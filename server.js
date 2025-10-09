// server.js
"use strict";

const express = require("express");
const cors = require("cors");

const app = express();

// ===== CONFIG =====
const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const WORKFLOW_ID = process.env.WORKFLOW_ID || "";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://www.semeocurrioalgo.com";

// ===== MIDDLEWARE =====
app.use(cors({
  origin: (origin, cb) => {
    // Permite SSR/tools (origin null) y tu dominio
    if (!origin || origin === ALLOWED_ORIGIN) return cb(null, true);
    return cb(new Error("CORS bloqueado para " + origin));
  },
  methods: ["GET","POST","OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));
app.use(express.json());

// ===== RUTAS BÁSICAS =====
app.get("/", (_, res) => res.type("text/plain").send("ok"));
app.get("/health", (_, res) => res.type("text/plain").send("ok"));

// ===== UTIL: loggear config (sin exponer key completa) =====
function maskKey(k){ return k ? (k.slice(0,7) + "…" + k.slice(-4)) : "(vacía)"; }

// ===== SESIÓN CHATKIT =====
app.post("/api/chatkit/session", async (req, res) => {
  try {
    // Validación de entorno
    if (!OPENAI_API_KEY) return res.status(500).json({ error: "Falta OPENAI_API_KEY" });
    if (!WORKFLOW_ID)   return res.status(500).json({ error: "Falta WORKFLOW_ID" });

    // user puede venir como userId o user
    const userId = (req.body && (req.body.user || req.body.userId)) || `anon-${Date.now()}`;

    // DEBUG: log mínimo (seguro)
    console.log("[/api/chatkit/session] user:", userId);
    console.log("[env] WORKFLOW_ID:", WORKFLOW_ID, "| OPENAI_API_KEY:", maskKey(OPENAI_API_KEY));
    console.log("[env] ALLOWED_ORIGIN:", ALLOWED_ORIGIN);

    const payload = {
      workflow: { id: WORKFLOW_ID },
      user: userId
    };

    const resp = await fetch("https://api.openai.com/v1/chatkit/sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "chatkit_beta=v1"
      },
      body: JSON.stringify(payload)
    });

    const text = await resp.text();
    if (!resp.ok) {
      console.error("[OpenAI] status:", resp.status, "| body:", text);
      return res.status(500).json({ error: "OpenAI session failed", status: resp.status, body: text });
    }

    let data;
    try { data = JSON.parse(text); } catch(parseErr){
      console.error("[OpenAI] JSON parse error:", parseErr, "raw:", text);
      return res.status(500).json({ error: "Bad JSON from OpenAI", raw: text });
    }

    if (!data.client_secret) {
      console.error("[OpenAI] Missing client_secret in response:", data);
      return res.status(500).json({ error: "Missing client_secret from OpenAI", raw: data });
    }

    return res.json({ client_secret: data.client_secret });
  } catch (err) {
    console.error("[/api/chatkit/session] crash:", err);
    return res.status(500).json({ error: "Server error", message: String(err && err.message || err) });
  }
});

// ===== START =====
app.listen(PORT, () => {
  console.log("API listening on " + PORT);
});
