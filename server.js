// server.js
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");
const { google } = require("googleapis");

const app = express();

/* ========= Config ========= */
const PORT = process.env.PORT || 8080;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const CHATKIT_WORKFLOW_ID = process.env.CHATKIT_WORKFLOW_ID;

// Google
const SHEET_ID = process.env.SHEET_ID;               // ID del Google Sheet
const SHEET_TAB_LEADS = process.env.SHEET_TAB_LEADS || "Leads";
const SHEET_TAB_CITAS = process.env.SHEET_TAB_CITAS || "Citas";

const CALENDAR_ID = process.env.CALENDAR_ID;         // ID/email del calendario
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const GOOGLE_PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

/* ========= Middlewares ========= */
app.use(cors({
  origin: ALLOWED_ORIGIN === "*" ? true : ALLOWED_ORIGIN.split(","),
}));
app.use(bodyParser.json({ limit: "1mb" }));

/* ========= Utils Google ========= */
function getGoogleAuth(scopes) {
  return new google.auth.JWT(
    GOOGLE_CLIENT_EMAIL,
    null,
    GOOGLE_PRIVATE_KEY,
    scopes
  );
}

async function appendRow(sheetName, values) {
  if (!SHEET_ID) return;
  const auth = getGoogleAuth(["https://www.googleapis.com/auth/spreadsheets"]);
  const sheets = google.sheets({ version: "v4", auth });
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${sheetName}!A:Z`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [values] },
  });
}

/* ========= Health ========= */
app.get("/", (_, res) => res.send("ok"));
app.get("/health", (_, res) => res.send("ok"));

/* ========= ChatKit session ========= */
app.post("/api/chatkit/session", async (req, res) => {
  try {
    const user = (req.body && (req.body.userId || req.body.user)) || "web";
    const r = await fetch("https://api.openai.com/v1/chatkit/sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "OpenAI-Beta": "chatkit_beta=v1",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        workflow: { id: CHATKIT_WORKFLOW_ID },
        user,
      }),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      return res.status(500).json({ error: "openai_session_error", details: text });
    }
    const data = await r.json();
    return res.json({ client_secret: data.client_secret });
  } catch (err) {
    console.error("session error", err);
    return res.status(500).json({ error: "session_internal_error" });
  }
});

/* ========= Tools: create_lead =========
   Columns in "Leads":
   timestamp, full_name, email, phone, program_interest, language, source_channel,
   consent_personal_data, privacy_ack, costs_email_requested, notes, status
*/
app.post("/tools/create_lead", async (req, res) => {
  try {
    const {
      full_name, email, phone, program_interest,
      language = "es",
      source_channel = "web",
      consent_personal_data = "yes",
      privacy_ack = "yes",
      costs_email_requested = "yes",
      notes = "",
      status = "lead",
    } = req.body || {};

    if (!full_name || !email) {
      return res.status(400).json({ ok: false, error: "missing_fields" });
    }

    const timestamp = new Date().toISOString();

    if (SHEET_ID) {
      await appendRow(SHEET_TAB_LEADS, [
        timestamp,
        full_name,
        email,
        phone || "",
        program_interest || "",
        language,
        source_channel,
        consent_personal_data,
        privacy_ack,
        costs_email_requested,
        notes,
        status,
      ]);
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("create_lead error:", err?.response?.data || err.message);
    // Aunque falle Sheets, respondemos ok=false manual para que el agente sepa que debe hacer seguimiento manual
    return res.status(200).json({ ok: false, status: "manual_followup" });
  }
});

/* ========= Tools: schedule_visit =========
   Columns in "Citas":
   timestamp, modality, preferred_dt_local, contact_name, contact_email,
   contact_phone, program_interest, status, notes
*/
app.post("/tools/schedule_visit", async (req, res) => {
  const {
    modality,                                // 'virtual' | 'presencial'
    preferred_dt_local,                      // ISO ej: 2025-10-16T10:30:00-05:00
    contact = {},                            // { name, email, phone }
    program_interest = "",
    notes = "origen:web",
  } = req.body || {};

  if (!modality || !preferred_dt_local || !contact?.name || !contact?.email) {
    return res.status(400).json({ ok: false, error: "missing_fields" });
  }

  const start = new Date(preferred_dt_local);
  if (isNaN(start)) {
    return res.status(400).json({ ok: false, error: "invalid_datetime" });
  }
  const end = new Date(start.getTime() + 60 * 60 * 1000); // 60 minutos

  const nowISO = new Date().toISOString();

  // Helper para escribir fila en "Citas"
  async function writeCita(statusVal) {
    if (!SHEET_ID) return;
    await appendRow(SHEET_TAB_CITAS, [
      nowISO,
      modality,
      preferred_dt_local,
      contact.name,
      contact.email,
      contact.phone || "",
      program_interest || "",
      statusVal,
      notes || "",
    ]);
  }

  // Si no hay Calendar configurado, registramos como manual_followup
  if (!CALENDAR_ID || !GOOGLE_CLIENT_EMAIL || !GOOGLE_PRIVATE_KEY) {
    try { await writeCita("manual_followup"); } catch {}
    return res.status(200).json({ ok: false, status: "manual_followup" });
  }

  try {
    const auth = getGoogleAuth([
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/spreadsheets",
    ]);
    const calendar = google.calendar({ version: "v3", auth });

    const summary =
      `${modality === "presencial" ? "Visita campus" : "Llamada"} — ` +
      `${program_interest || "Admisiones"} — ${contact.name}`;

    const description =
      `Solicitado vía web\n` +
      `Programa: ${program_interest || "-"}\n` +
      `Email: ${contact.email}\n` +
      `Tel: ${contact.phone || "-"}\n` +
      `Notas: ${notes || "-"}`;

    const event = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary,
        description,
        start: { dateTime: start.toISOString() },
        end: { dateTime: end.toISOString() },
        attendees: [{ email: contact.email, displayName: contact.name }],
      },
    });

    try { await writeCita("scheduled"); } catch {}
    return res.json({ ok: true, eventId: event.data.id });
  } catch (err) {
    console.error("schedule_visit error:", err?.response?.data || err.message);
    try { await writeCita("manual_followup"); } catch {}
    return res.status(200).json({ ok: false, status: "manual_followup" });
  }
});

/* ========= Start ========= */
app.listen(PORT, () => {
  console.log("API listening on " + PORT);
});
