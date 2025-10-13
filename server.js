// server.js — sirve index público + ChatKit session + herramientas Sheets/Calendar
const express = require("express");
const cors = require("cors");
const { google } = require("googleapis");
const path = require("path");

// ---------- ENV ----------
const {
  PORT = 8080,
  OPENAI_API_KEY,
  CHATKIT_WORKFLOW_ID,
  // CORS
  ALLOWED_ORIGIN,                 // ej: https://www.semeocurrioalgo.com
  ALLOWED_ORIGINS_EXTRA,          // opcional lista separada por comas
  // Google Sheets/Calendar
  SHEET_ID,
  SHEET_TAB_LEADS = "Leads",
  SHEET_TAB_CITAS = "Citas",
  GOOGLE_CLIENT_EMAIL,
  GOOGLE_PRIVATE_KEY,
  GOOGLE_PROJECT_ID,              // no se usa en código, pero útil tenerlo
  CALENDAR_ID                     // ej: primary o ...@group.calendar.google.com
} = process.env;

// ---------- APP ----------
const app = express();
app.use(express.json());

// Sirve archivos estáticos (index.html en /public)
app.use(express.static(path.join(__dirname, "public")));

// CORS: permite tu dominio público y extras
const allowList = [
  ...(ALLOWED_ORIGIN ? [ALLOWED_ORIGIN] : []),
  ...(ALLOWED_ORIGINS_EXTRA ? ALLOWED_ORIGINS_EXTRA.split(",").map(s => s.trim()) : []),
];
app.use(
  cors({
    origin(origin, cb) {
      // Permite curl/postman (sin origin)
      if (!origin) return cb(null, true);
      if (allowList.length === 0 || allowList.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
  })
);

// ---------- HEALTH ----------
app.get("/health", (_, res) => res.send("ok"));

// ---------- CHATKIT: crear sesión ----------
app.post("/api/chatkit/session", async (req, res) => {
  try {
    if (!OPENAI_API_KEY || !CHATKIT_WORKFLOW_ID) {
      return res.status(500).json({ error: "missing_openai_env" });
    }
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

// ---------- GOOGLE AUTH ----------
function getGoogleAuth() {
  const key = (GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  return new google.auth.JWT(
    GOOGLE_CLIENT_EMAIL,
    null,
    key,
    [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/calendar"
    ]
  );
}
const sheetsApi = () => google.sheets({ version: "v4", auth: getGoogleAuth() });
const calendarApi = () => google.calendar({ version: "v3", auth: getGoogleAuth() });

// Helpers: append a Sheet row
async function appendRow(tabName, values) {
  const sheets = sheetsApi();
  return sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${tabName}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [values] },
  });
}

// ---------- TOOLS: create_lead ----------
app.post("/tools/create_lead", async (req, res) => {
  try {
    const p = req.body || {};
    // Campos mínimos
    const required = [
      "full_name","email","phone","program_interest","language",
      "source_channel","consent_personal_data","privacy_ack","costs_email_requested"
    ];
    for (const k of required) {
      if (!p[k]) return res.status(400).json({ ok:false, error:`missing_${k}` });
    }

    const timestamp = new Date().toISOString();
    const row = [
      timestamp,
      p.full_name,
      p.email,
      p.phone,
      p.program_interest,
      p.language,
      p.source_channel,
      p.consent_personal_data,
      p.privacy_ack,
      p.costs_email_requested,
      p.notes || "",
      "new",
    ];
    await appendRow(SHEET_TAB_LEADS, row);
    return res.json({ ok:true });
  } catch (err) {
    console.error("create_lead error:", err?.response?.data || err);
    return res.status(500).json({ ok:false, error:"create_lead_failed" });
  }
});

// ---------- TOOLS: schedule_visit ----------
app.post("/tools/schedule_visit", async (req, res) => {
  const p = req.body || {};
  try {
    if (!CALENDAR_ID) return res.status(500).json({ ok:false, error:"missing_CALENDAR_ID" });

    // Validar mínimos
    if (!p.modality) return res.status(400).json({ ok:false, error:"missing_modality" });
    if (!p.preferred_dt_local) return res.status(400).json({ ok:false, error:"missing_preferred_dt_local" });
    if (!p.contact || !p.contact.name || !p.contact.email || !p.contact.phone) {
      return res.status(400).json({ ok:false, error:"missing_contact_fields" });
    }

    // Parseo fecha/hora
    const tz = "America/Panama";
    const start = new Date(p.preferred_dt_local); // acepta "2025-10-16T11:00:00-05:00"
    if (isNaN(start.getTime())) return res.status(400).json({ ok:false, error:"invalid_datetime" });
    const end = new Date(start.getTime() + 60 * 60 * 1000); // 1h

    // Crear evento en Calendar
    const calendar = calendarApi();
    const summary = `Visita ${p.modality} — ${p.contact.name}`;
    const description = [
      `Contacto: ${p.contact.name} — ${p.contact.email} — ${p.contact.phone}`,
      p.program_interest ? `Programa: ${p.program_interest}` : "",
      p.notes ? `Notas: ${p.notes}` : "",
    ].filter(Boolean).join("\n");

    const ev = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary,
        description,
        start: { dateTime: start.toISOString(), timeZone: tz },
        end:   { dateTime: end.toISOString(),   timeZone: tz },
      },
    });

    // Registrar en Sheet (Citas)
    const timestamp = new Date().toISOString();
    const row = [
      timestamp,
      p.modality,
      p.preferred_dt_local,
      p.contact.name,
      p.contact.email,
      p.contact.phone,
      p.program_interest || "",
      "created",
      p.notes || "",
    ];
    await appendRow(SHEET_TAB_CITAS, row);

    return res.json({ ok:true, eventId: ev.data.id });
  } catch (err) {
    console.error("schedule_visit error:", err?.response?.data || err);
    // Fallback: registrar la cita para seguimiento manual
    try {
      const timestamp = new Date().toISOString();
      await appendRow(SHEET_TAB_CITAS, [
        timestamp,
        p.modality || "",
        p.preferred_dt_local || "",
        p.contact?.name || "",
        p.contact?.email || "",
        p.contact?.phone || "",
        p.program_interest || "",
        "manual_followup",
        p.notes || "Registro automático falló; confirmar manual",
      ]);
    } catch(e){ console.error("append fallback failed:", e?.response?.data || e); }
    return res.status(500).json({ ok:false, status:"manual_followup" });
  }
});

// ---------- START ----------
app.listen(PORT, () => console.log("API listening on " + PORT));
