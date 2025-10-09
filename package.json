// server.js
"use strict";

const express = require("express");
const cors = require("cors");

const app = express();

// ===== CONFIG =====
const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;      // <- ponla en Railway
const WORKFLOW_ID = process.env.WORKFLOW_ID;            // <- wf_68e7cc18d10c8190a69b17e589c1899e01de395587bb64d1
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://www.semeocurrioalgo.com";

// ===== MIDDLEWARE =====
app.use(cors({
  origin: (origin, cb) => {
    // Permite SSR (origin null) y tu dominio
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

// ===== CREAR SESIÓN DE CHATKIT =====
// NOTA: usamos la API REST directamente; es estable y no dependemos de si el SDK Node expone chatkit aún.
app.post("/api/chatkit/session", async (req, res) => {
  try {
    if (!OPENAI_API_KEY) return res.status(500).json({ error: "Falta OPENAI_API_KEY" });
    if (!WORKFLOW_ID)   return res.status(500).json({ error: "Falta WORKFLOW_ID" });

    const userId = (req.body && (req.body.user || req.body.userId)) || `anon-${Date.now()}`;

    // Llamada REST a OpenAI ChatKit Sessions
    const resp = await fetch("https://api.openai.com/v1/chatkit/sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "chatkit_beta=v1" // requerido para ChatKit (hosted)
      },
      body: JSON.stringify({
        workflow: { id: WORKFLOW_ID },
        user: userId
      })
    });

    const text = await resp.text();
    if (!resp.ok) {
      console.error("ChatKit session error:", resp.status, text);
      return res.status(500).json({ error: "OpenAI session failed", status: resp.status, body: text });
    }

    const data = JSON.parse(text);
    if (!data.client_secret) {
      console.error("Sin client_secret en respuesta:", data);
      return res.status(500).json({ error: "Missing client_secret from OpenAI" });
    }

    // Regresamos SOLO el client_secret al navegador
    return res.json({ client_secret: data.client_secret });
  } catch (err) {
    console.error("SESSION endpoint crash:", err);
    return res.status(500).json({ error: "Server error", message: String(err && err.message || err) });
  }
});

// ===== START =====
app.listen(PORT, () => {
  console.log("API listening on " + PORT);
});

