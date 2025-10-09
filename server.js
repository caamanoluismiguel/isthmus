// server.js
"use strict";

const express = require("express");
const cors = require("cors");

const app = express();

// ===== CONFIG =====
const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

// Acepta ambos nombres
const WORKFLOW_ID =
  process.env.WORKFLOW_ID ||
  process.env.CHATKIT_WORKFLOW_ID ||
  "";

const ALLOWED_ORIGIN =
  process.env.ALLOWED_ORIGIN ||
  process.env.CORS_ORIGIN ||
  "https://www.semeocurrioalgo.com";

// ===== MIDDLEWARE GLOBAL =====
app.use(express.json());

// ===== RUTAS ABIERTAS (sin CORS) =====
app.get("/", (_, res) => res.type("text/plain").send("ok"));
app.get("/health", (_, res) => res.type("text/plain").send("ok"));

// ===== CORS SOLO PARA /api =====
const corsOptions = {
  origin: (origin, cb) => {
    // Permite SSR/tools (origin null) y tu dominio público
    if (!origin || origin === ALLOWED_ORIGIN) return cb(null, true);
    return cb(new Error("CORS bloqueado para " + origin));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
};
const api = express.Router();
api.use(cors(corsOptions));          // CORS aplicado solo a /api
api.use(express.json());

// Utilidad para esconder la key en logs
function maskKey(k){ return k ? (k.slice(0,7) + "…" + k.slice(-4)) : "(vacía)"; }

// ===== SESIÓN CHATKIT =====
api.post("/chatkit/session", async (req, res) => {
  try {
    if (!OPENAI_API_KEY) return res.status(500).json({ error: "Falta OPENAI_API_KEY" });
    if (!WORKFLOW_ID)   return res.status(500).json({ error: "Falta WORKFLOW_ID/CHATKIT_WORKFLOW_ID" });

    const userId = (req.body && (req.body.user || req.body.userId)) || `anon-${Date.now()}`;

    console.log("[/api/chatkit/session] user:", userId);
    console.log("[env] WORKFLOW_ID:", WORKFLOW_ID, "| OPENAI_API_KEY:", maskKey(OPENAI_API_KEY));
    console.log("[env] ALLOWED_ORIGIN/CORS_ORIGIN:", ALLOWED_ORIGIN);

    const payload = { workflow: { id: WORKFLOW_ID }, user: userId };

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
    try { data = JSON.parse(text); } catch (e) {
      console.error("[OpenAI] JSON parse error:", e, "raw:", text);
      return res.status(500).json({ error: "Bad JSON from OpenAI", raw: text });
    }

    if (!data.client_secret) {
      console.error("[OpenAI] Missing client_secret:", data);
      return res.status(500).json({ error: "Missing client_secret from OpenAI", raw: data });
    }

    return res.json({ client_secret: data.client_secret });
  } catch (err) {
    console.error("[/api/chatkit/session] crash:", err);
    return res.status(500).json({ error: "Server error", message: String(err && err.message || err) });
  }
});

// Monta el router /api
app.use("/api", api);

// ===== START =====
app.listen(PORT, () => {
  console.log("API listening on " + PORT);
});

