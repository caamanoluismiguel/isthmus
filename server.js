// server.js — ChatKit session + herramientas Sheets/Calendar + KB search
const express = require("express");
const cors = require("cors");
const { google } = require("googleapis");
const path = require("path");
const fs = require("fs");

// ---------- ENV ----------
const {
  PORT = 8080,
  OPENAI_API_KEY,
  CHATKIT_WORKFLOW_ID,
  // CORS
  ALLOWED_ORIGIN, ALLOWED_ORIGINS_EXTRA,
  // Google Sheets/Calendar
  SHEET_ID,
  SHEET_TAB_LEADS = "Leads",
  SHEET_TAB_CITAS = "Citas",
  GOOGLE_CLIENT_EMAIL,
  GOOGLE_PRIVATE_KEY,
  GOOGLE_PROJECT_ID,
  CALENDAR_ID,
  // KB
  KB_DIR = path.join(__dirname, "kb")
} = process.env;

// ---------- APP ----------
const app = express();
app.use(express.json());
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
    await appendRow(SHEET_TAB_CITAS, [
      timestamp, p.modality, p.preferred_dt_local, p.contact.name,
      p.contact.email, p.contact.phone, p.program_interest || "",
      "created", p.notes || "",
    ]);

    return res.json({ ok:true, eventId: ev.data.id });
  } catch (err) {
    console.error("schedule_visit error:", err?.response?.data || err);
    try {
      const timestamp = new Date().toISOString();
      await appendRow(SHEET_TAB_CITAS, [
        timestamp, p.modality || "", p.preferred_dt_local || "",
        p.contact?.name || "", p.contact?.email || "", p.contact?.phone || "",
        p.program_interest || "", "manual_followup",
        p.notes || "Registro automático falló; confirmar manual",
      ]);
    } catch(e){ console.error("append fallback failed:", e?.response?.data || e); }
    return res.status(500).json({ ok:false, status:"manual_followup" });
  }
});

// ============== KB: indexado simple y búsqueda por embeddings ==============
let KB_INDEX = []; // [{title, canonical_url, updated_at, chunk, vector: Float32Array}]

function parseFrontMatter(txt){
  const m = txt.match(/^---\s*([\s\S]*?)\s*---\s*([\s\S]*)$/);
  if (!m) return { meta:{}, body: txt };
  const meta = {};
  m[1].split("\n").forEach(line => {
    const mm = line.match(/^\s*([a-zA-Z0-9_]+)\s*:\s*(.+)\s*$/);
    if (mm) meta[mm[1].trim()] = mm[2].trim().replace(/^"(.*)"$/,'$1');
  });
  return { meta, body: m[2] };
}
function splitChunks(s, max=800, overlap=120){
  const out=[]; let i=0;
  while (i<s.length){ out.push(s.slice(i, i+max).trim()); i += (max - overlap); }
  return out.filter(Boolean);
}
async function embedBatch(texts){
  if (!OPENAI_API_KEY) throw new Error("missing OPENAI_API_KEY");
  const r = await fetch("https://api.openai.com/v1/embeddings", {
    method:"POST",
    headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model:"text-embedding-3-small", input: texts })
  });
  const j = await r.json();
  if (!r.ok) throw new Error("Embeddings error: "+JSON.stringify(j));
  return j.data.map(d => Float32Array.from(d.embedding));
}
function cosSim(a, b){
  let dot=0, na=0, nb=0;
  for (let i=0;i<a.length;i++){ dot+=a[i]*b[i]; na+=a[i]*a[i]; nb+=b[i]*b[i]; }
  return dot / (Math.sqrt(na)*Math.sqrt(nb) + 1e-8);
}
async function buildKbIndex(){
  KB_INDEX = [];
  if (!fs.existsSync(KB_DIR)) {
    console.log("KB_DIR no existe, creando vacío:", KB_DIR);
    return;
  }
  const files = fs.readdirSync(KB_DIR).filter(f => /\.(md|txt)$/i.test(f));
  const chunks = [];
  files.forEach(fname => {
    const full = path.join(KB_DIR, fname);
    const raw  = fs.readFileSync(full, "utf8");
    const { meta, body } = parseFrontMatter(raw);
    const title = meta.title || fname;
    const canonical_url = meta.canonical_url || "";
    const updated_at = meta.updated_at || "";

    splitChunks(body).forEach(ch => {
      chunks.push({ title, canonical_url, updated_at, chunk: ch });
    });
  });
  for (let i=0;i<chunks.length;i+=64){
    const batch = chunks.slice(i, i+64);
    const vecs = await embedBatch(batch.map(x=>x.chunk));
    vecs.forEach((v,k)=> KB_INDEX.push({ ...batch[k], vector: v }));
  }
  console.log(`KB indexado: ${KB_INDEX.length} fragmentos.`);
}
async function searchKb(query, top_k=6){
  if (!KB_INDEX.length) return [];
  const [qvec] = await embedBatch([query]);
  const scored = KB_INDEX.map(it => ({ ...it, score: cosSim(qvec, it.vector) }));
  scored.sort((a,b)=> b.score - a.score);
  return scored.slice(0, top_k).map(s => ({
    title: s.title, canonical_url: s.canonical_url,
    updated_at: s.updated_at, snippet: s.chunk.slice(0, 600),
    score: +s.score.toFixed(4)
  }));
}

// Reindex manual
app.post("/api/kb/reindex", async (_req, res) => {
  try { await buildKbIndex(); res.json({ ok:true, chunks: KB_INDEX.length }); }
  catch(e){ console.error(e); res.status(500).json({ ok:false }); }
});

// ---------- TOOLS: search_kb (para ChatKit client tool) ----------
app.post("/tools/search_kb", async (req, res) => {
  try {
    const p = req.body || {};
    const q = String(p.query || "").slice(0, 500);
    const k = Math.min(Math.max(parseInt(p.top_k||6,10),1), 6);
    if (!q) return res.status(400).json({ ok:false, error:"missing_query" });
    const hits = await searchKb(q, k);
    return res.json({ ok:true, hits });
  } catch (e) {
    console.error("search_kb error:", e);
    return res.status(500).json({ ok:false, error:"search_kb_failed" });
  }
});

// ---------- START ----------
app.listen(PORT, async () => {
  console.log("API listening on " + PORT);
  try { await buildKbIndex(); } catch(e){ console.error("KB index error:", e.message); }
});
