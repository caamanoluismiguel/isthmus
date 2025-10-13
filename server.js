// server.js (con chat conversacional sin ChatKit)
const express = require("express");
const cors = require("cors");
const { google } = require("googleapis");
const path = require("path");

// ---------- ENV ----------
const {
  PORT = 8080,
  OPENAI_API_KEY,
  CHATKIT_WORKFLOW_ID,      // se mantiene por si luego vuelves al widget
  ALLOWED_ORIGIN,
  ALLOWED_ORIGINS_EXTRA,
  SHEET_ID,
  GOOGLE_CLIENT_EMAIL,
  GOOGLE_PRIVATE_KEY,
  GOOGLE_PROJECT_ID,
  CALENDAR_ID,
} = process.env;

if (!OPENAI_API_KEY) {
  console.error("Falta OPENAI_API_KEY en variables de entorno");
}

// ---------- APP ----------
const app = express();
app.use(express.json());

// servir estáticos (index.html en /public)
app.use(express.static(path.join(__dirname, "public")));

// CORS
const allowList = [
  ...(ALLOWED_ORIGIN ? [ALLOWED_ORIGIN] : []),
  ...(ALLOWED_ORIGINS_EXTRA ? ALLOWED_ORIGINS_EXTRA.split(",").map(s => s.trim()) : []),
];
app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (allowList.length === 0 || allowList.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
  })
);

// ---------- HEALTH ----------
app.get("/health", (_, res) => res.send("ok"));

// ---------- (Sigue disponible) CHATKIT sesión ----------
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

// ---------- GOOGLE AUTH ----------
function getGoogleAuth() {
  const key = (GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  return new google.auth.JWT(
    GOOGLE_CLIENT_EMAIL,
    null,
    key,
    [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/calendar",
    ]
  );
}
const sheetsApi = () => google.sheets({ version: "v4", auth: getGoogleAuth() });
const calendarApi = () => google.calendar({ version: "v3", auth: getGoogleAuth() });

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
    const required = [
      "full_name","email","phone","program_interest","language",
      "source_channel","consent_personal_data","privacy_ack","costs_email_requested"
    ];
    for (const k of required) {
      if (!p[k]) return res.status(400).json({ ok:false, error:`missing_${k}` });
    }
    const timestamp = new Date().toISOString();
    const row = [
      timestamp, p.full_name, p.email, p.phone, p.program_interest, p.language,
      p.source_channel, p.consent_personal_data, p.privacy_ack, p.costs_email_requested,
      p.notes || "", "new",
    ];
    await appendRow("Leads", row);
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
    if (!p.modality) return res.status(400).json({ ok:false, error:"missing_modality" });
    if (!p.preferred_dt_local) return res.status(400).json({ ok:false, error:"missing_preferred_dt_local" });
    if (!p.contact || !p.contact.name || !p.contact.email || !p.contact.phone) {
      return res.status(400).json({ ok:false, error:"missing_contact_fields" });
    }

    const tz = "America/Panama";
    const start = new Date(p.preferred_dt_local);
    if (isNaN(start.getTime())) return res.status(400).json({ ok:false, error:"invalid_datetime" });
    const end = new Date(start.getTime() + 60 * 60 * 1000);

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

    const timestamp = new Date().toISOString();
    await appendRow("Citas", [
      timestamp, p.modality, p.preferred_dt_local, p.contact.name,
      p.contact.email, p.contact.phone, p.program_interest || "",
      "created", p.notes || "",
    ]);

    return res.json({ ok:true, eventId: ev.data.id });
  } catch (err) {
    console.error("schedule_visit error:", err?.response?.data || err);
    try {
      const timestamp = new Date().toISOString();
      await appendRow("Citas", [
        timestamp, p.modality || "", p.preferred_dt_local || "",
        p.contact?.name || "", p.contact?.email || "", p.contact?.phone || "",
        p.program_interest || "", "manual_followup",
        p.notes || "Registro automático falló; confirmar manual",
      ]);
    } catch(e){ console.error("append fallback failed:", e?.response?.data || e); }
    return res.status(500).json({ ok:false, status:"manual_followup" });
  }
});

// =============== CONVERSACIONAL SIN CHATKIT =================
// Simple loop de function-calling con la API de OpenAI
const AGENT_SYSTEM_PROMPT = `
Eres el Asesor de Admisiones de ISTHMUS. Responde en el idioma del usuario.
Políticas clave:
- Capturar leads para costos por correo (no publiques montos).
- Agendar llamadas/visitas L–V 08:00–17:00 America/Panama.
- Antes de guardar datos, pide consentimiento breve ("autorizo").
- Pide sólo lo que falte (slot-filling mínimo). Usa confirmación única antes de registrar.
- Para programar, normaliza fecha/hora a America/Panama. Si fuera de horario, sugiere 2 alternativas cercanas.
Herramientas disponibles:
- create_lead(payload)
- schedule_visit(payload)
Devuelve respuestas breves (60–120 palabras) y una sola CTA por turno.
`;

async function callOpenAIWithTools(messages) {
  const url = "https://api.openai.com/v1/chat/completions";
  const model = "gpt-4o-mini";

  const tools = [
    {
      type: "function",
      function: {
        name: "create_lead",
        description: "Registra un lead para enviar costos por correo.",
        parameters: {
          type: "object",
          properties: {
            full_name: { type:"string" },
            email: { type:"string" },
            phone: { type:"string" },
            program_interest: { type:"string" },
            language: { type:"string" },
            source_channel: { type:"string", enum:["web"] },
            consent_personal_data: { type:"string", enum:["yes","no"] },
            privacy_ack: { type:"string", enum:["yes","no"] },
            costs_email_requested: { type:"string", enum:["yes","no"] },
            notes: { type:"string" }
          },
          required:["full_name","email","phone","program_interest","language","source_channel","consent_personal_data","privacy_ack","costs_email_requested"]
        }
      }
    },
    {
      type:"function",
      function:{
        name:"schedule_visit",
        description:"Registra solicitud de visita/llamada",
        parameters:{
          type:"object",
          properties:{
            modality:{ type:"string", enum:["presencial","virtual"] },
            preferred_dt_local:{ type:"string", description:"Formato ISO local, ej 2025-10-16T11:00:00-05:00" },
            contact:{
              type:"object",
              properties:{
                name:{type:"string"}, email:{type:"string"}, phone:{type:"string"}
              },
              required:["name","email","phone"]
            },
            program_interest:{ type:"string" },
            notes:{ type:"string" }
          },
          required:["modality","preferred_dt_local","contact"]
        }
      }
    }
  ];

  const body = { model, messages, tools, tool_choice: "auto" };
  const r = await fetch(url, {
    method:"POST",
    headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify(body)
  });
  if(!r.ok){
    const t = await r.text().catch(()=> "");
    throw new Error("OpenAI error "+r.status+": "+t);
  }
  const j = await r.json();
  return j.choices[0].message;
}

app.post("/api/agent_chat", async (req, res) => {
  try {
    const userText = (req.body && req.body.text) || "";
    if (!userText) return res.status(400).json({ error:"missing_text" });

    let messages = [
      { role:"system", content: AGENT_SYSTEM_PROMPT },
      { role:"user", content: userText }
    ];

    // loop de herramientas
    for (let i = 0; i < 3; i++) {
      const msg = await callOpenAIWithTools(messages);

      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        // respuesta final
        return res.json({ reply: msg.content || "" });
      }

      // ejecutar tools y devolver resultados al modelo
      for (const tc of msg.tool_calls) {
        const name = tc.function.name;
        const args = JSON.parse(tc.function.arguments || "{}");
        let toolResult;

        if (name === "create_lead") {
          try { toolResult = await (await fetch(`${req.protocol}://${req.get("host")}/tools/create_lead`, {
            method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(args)
          })).json(); } catch(e){ toolResult = { ok:false, error:"client_fetch_error" }; }
        } else if (name === "schedule_visit") {
          try { toolResult = await (await fetch(`${req.protocol}://${req.get("host")}/tools/schedule_visit`, {
            method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(args)
          })).json(); } catch(e){ toolResult = { ok:false, error:"client_fetch_error" }; }
        } else {
          toolResult = { ok:false, error:"unknown_tool" };
        }

        messages.push({ role:"assistant", tool_calls:[tc] });
        messages.push({ role:"tool", tool_call_id: tc.id, content: JSON.stringify(toolResult) });
      }
    }

    // si no salió antes:
    return res.json({ reply: "He registrado tu solicitud. El equipo te confirmará por correo/teléfono." });
  } catch (err) {
    console.error("agent_chat error:", err);
    return res.status(500).json({ error:"agent_chat_failed" });
  }
});

// ---------- START ----------
app.listen(PORT, () => console.log("API listening on " + PORT));


