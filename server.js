// server.js
const express = require("express");
const cors = require("cors");
const { google } = require("googleapis");

// ---------- ENV ----------
const {
  PORT = 8080,
  OPENAI_API_KEY,
  CHATKIT_WORKFLOW_ID,

  // CORS
  ALLOWED_ORIGIN,            // p.ej. https://www.tudominio.com
  ALLOWED_ORIGINS_EXTRA,     // opcional: coma-separada

  // Google Sheets (Service Account)
  SHEET_ID,
  GOOGLE_CLIENT_EMAIL,
  GOOGLE_PRIVATE_KEY,
  SHEET_TAB_LEADS,           // opcional, default "Leads"
  SHEET_TAB_CITAS,           // opcional, default "Citas"

  // Google Calendar (OAuth 2.0 con refresh_token)
  CLIENT_ID,
  CLIENT_SECRET,
  GOOGLE_OAUTH_TOKEN_JSON,   // JSON del Playground con "refresh_token"

  // Calendar ID (p.ej. "primary")
  CALENDAR_ID,

  // Debug (opcional)
  DEBUG_SECRET
} = process.env;

const TAB_LEADS = SHEET_TAB_LEADS || "Leads";
const TAB_CITAS = SHEET_TAB_CITAS || "Citas";
const PANAMA_TZ = "America/Panama";
const CAL_ID = CALENDAR_ID || "primary";

// ---------- APP ----------
const app = express();
app.use(express.json());

// CORS: permite tu dominio público y extras
const allowList = [
  ...(ALLOWED_ORIGIN ? [ALLOWED_ORIGIN] : []),
  ...(ALLOWED_ORIGINS_EXTRA ? ALLOWED_ORIGINS_EXTRA.split(",").map(s => s.trim()) : []),
];
app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true); // allow curl / direct
      if (allowList.length === 0 || allowList.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
  })
);

// ---------- HEALTH ----------
app.get("/", (_, res) => res.send("ok"));
app.get("/health", (_, res) => res.send("ok"));

// ---------- CHATKIT: crea sesión ----------
app.post("/api/chatkit/session", async (req, res) => {
  try {
    const user = (req.body && (req.body.user || req.body.userId)) || "anon";
    const r = await fetch("https://api.openai.com/v1/chatkit/sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "OpenAI-Beta": "chatkit_beta=v1",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        workflow: { id: CHATKIT_WORKFLOW_ID },
        user,
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    return res.json({ client_secret: data.client_secret });
  } catch (err) {
    console.error("chatkit session error:", err);
    return res.status(500).json({ error: "session_error" });
  }
});

// ---------- GOOGLE AUTH (Sheets: Service Account) ----------
function getSheetsAuth() {
  const key = (GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  return new google.auth.JWT(
    GOOGLE_CLIENT_EMAIL,
    null,
    key,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
}
const sheetsApi = () => google.sheets({ version: "v4", auth: getSheetsAuth() });

// ---------- GOOGLE AUTH (Calendar: OAuth con refresh_token) ----------
function calendarApi() {
  if (!CLIENT_ID || !CLIENT_SECRET || !GOOGLE_OAUTH_TOKEN_JSON) {
    throw new Error("Calendar OAuth no configurado (CLIENT_ID/CLIENT_SECRET/GOOGLE_OAUTH_TOKEN_JSON).");
  }
  const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
  oauth2.setCredentials(JSON.parse(GOOGLE_OAUTH_TOKEN_JSON));
  return google.calendar({ version: "v3", auth: oauth2 });
}

// ---------- Helpers ----------
async function appendRow(tabName, values) {
  const sheets = sheetsApi();
  return sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${tabName}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [values] },
  });
}

// Parser para entradas como "16/10/2025 11:00", "16/10 11am", "16-10 3 pm"
function parseLocalPanama(input) {
  const s = String(input).trim().toLowerCase().replace(/\s+/g, " ");
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let [, dd, mm, yyyy, hh, min, ampm] = m;
  const now = new Date();
  const year = yyyy ? Number(yyyy.length === 2 ? "20" + yyyy : yyyy) : now.getFullYear();
  let hour = Number(hh);
  const minute = Number(min || "0");
  if (ampm) {
    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
  }
  // Panamá UTC-5: construimos el instante UTC equivalente a la hora local
  return new Date(Date.UTC(year, Number(mm) - 1, Number(dd), hour + 5, minute));
}

// ---------- TOOLS: create_lead ----------
app.post("/tools/create_lead", async (req, res) => {
  try {
    const p = req.body || {};

    // Mínimos para cualquier lead
    const coreRequired = ["full_name", "email", "phone"];
    for (const k of coreRequired) {
      if (!p[k]) return res.status(400).json({ ok: false, error: `missing_${k}` });
    }

    // Defaults para no romper en fallbacks (el flujo de "costos" llenará los reales)
    const row = [
      new Date().toISOString(),
      p.full_name,
      p.email,
      p.phone,
      p.program_interest || "",
      p.language || "es",
      p.source_channel || "web",
      p.consent_personal_data || "yes",
      p.privacy_ack || "yes",
      p.costs_email_requested || "no",
      p.notes || "",
      "new",
    ];

    await appendRow(TAB_LEADS, row);
    return res.json({ ok: true });
  } catch (err) {
    console.error("create_lead error:", err?.response?.data || err);
    // Devolver 200 para no romper el UI; el agente puede decidir reintentar o escalar
    return res.status(200).json({ ok: false, error: "create_lead_failed" });
  }
});

// ---------- TOOLS: schedule_visit ----------
app.post("/tools/schedule_visit", async (req, res) => {
  const p = req.body || {};
  try {
    // Validar mínimos
    if (!p.modality) return res.status(400).json({ ok: false, error: "missing_modality" });
    if (!p.preferred_dt_local) return res.status(400).json({ ok: false, error: "missing_preferred_dt_local" });
    if (!p.contact || !p.contact.name || !p.contact.email || !p.contact.phone) {
      return res.status(400).json({ ok: false, error: "missing_contact_fields" });
    }

    // Parseo fecha/hora (ISO directo o "16/10 11am")
    let start = new Date(p.preferred_dt_local);
    if (isNaN(start.getTime())) {
      const parsed = parseLocalPanama(p.preferred_dt_local);
      if (!parsed) return res.status(400).json({ ok: false, error: "invalid_datetime_format" });
      start = parsed;
    }
    const end = new Date(start.getTime() + 60 * 60 * 1000); // 1h

    // Crear evento en Calendar (OAuth)
    const calendar = calendarApi();
    const summary = `Visita ${p.modality} — ${p.contact.name}`;
    const description = [
      `Contacto: ${p.contact.name} — ${p.contact.email} — ${p.contact.phone}`,
      p.program_interest ? `Programa: ${p.program_interest}` : "",
      p.notes ? `Notas: ${p.notes}` : "",
    ].filter(Boolean).join("\n");

    const ev = await calendar.events.insert({
      calendarId: CAL_ID, // "primary" por defecto
      requestBody: {
        summary,
        description,
        start: { dateTime: start.toISOString(), timeZone: PANAMA_TZ },
        end:   { dateTime: end.toISOString(),   timeZone: PANAMA_TZ },
        // Si quieres invitar al contacto:
        // attendees: [{ email: p.contact.email }],
      },
    });

    // Registrar en Sheet (Citas)
    await appendRow(TAB_CITAS, [
      new Date().toISOString(),
      p.modality,
      p.preferred_dt_local,
      p.contact.name,
      p.contact.email,
      p.contact.phone,
      p.program_interest || "",
      "created",
      p.notes || "",
    ]);

    return res.json({ ok: true, eventId: ev.data.id });
  } catch (err) {
    console.error("schedule_visit error:", err?.response?.data || err);
    // Fallback: registrar la cita para seguimiento manual, sin romper el UI
    try {
      await appendRow(TAB_CITAS, [
        new Date().toISOString(),
        p.modality || "",
        p.preferred_dt_local || "",
        p.contact?.name || "",
        p.contact?.email || "",
        p.contact?.phone || "",
        p.program_interest || "",
        "manual_followup",
        p.notes || "Registro automático falló; confirmar manual",
      ]);
    } catch (e) {
      console.error("append fallback failed:", e?.response?.data || e);
    }
    return res.status(200).json({ ok: false, status: "manual_followup" });
  }
});

// ---------- DEBUG (opcional): protege con DEBUG_SECRET ----------
function requireDebugSecret(req, res, next) {
  if (!DEBUG_SECRET) return next(); // sin secreto, queda abierto (útil en desarrollo)
  const sent = req.get("x-debug-secret");
  if (sent === DEBUG_SECRET) return next();
  return res.status(403).json({ ok: false, error: "forbidden" });
}

app.get("/debug/calendar-list", requireDebugSecret, async (req, res) => {
  try {
    const calendar = calendarApi();
    const r = await calendar.calendarList.list();
    const items = (r.data.items || []).map(i => ({
      id: i.id, summary: i.summary, primary: !!i.primary
    }));
    return res.json({ ok: true, items });
  } catch (e) {
    console.error("debug calendar-list error:", e?.response?.data || e);
    return res.status(200).json({ ok: false, error: (e?.response?.data || e?.message || "fail") });
  }
});

app.post("/debug/calendar-insert", requireDebugSecret, async (req, res) => {
  try {
    const calendar = calendarApi();
    const start = new Date(Date.now() + 15 * 60 * 1000);
    const end   = new Date(start.getTime() + 60 * 60 * 1000);
    const ev = await calendar.events.insert({
      calendarId: CAL_ID,
      requestBody: {
        summary: "Debug Visit",
        start: { dateTime: start.toISOString(), timeZone: PANAMA_TZ },
        end:   { dateTime: end.toISOString(),   timeZone: PANAMA_TZ }
      }
    });
    return res.json({ ok: true, eventId: ev.data.id, htmlLink: ev.data.htmlLink });
  } catch (e) {
    console.error("debug calendar-insert error:", e?.response?.data || e);
    return res.status(200).json({ ok: false, error: (e?.response?.data || e?.message || "fail") });
  }
});

// ---------- START ----------
app.listen(PORT, () => console.log("API listening on " + PORT));
