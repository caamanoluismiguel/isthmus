// server/server.js
const express = require("express");
const cors = require("cors");
const { OpenAI } = require("openai");
require("dotenv").config();

const app = express();
app.use(express.json());

// CORS sencillo para empezar (luego puedes restringir a tu dominio)
app.use(cors());

// Rutas simples para comprobar que corre
app.get("/", (_req, res) => res.send("ok"));
app.get("/health", (_req, res) => res.send("ok"));

// ChatKit: crear sesión y devolver client_secret
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const WORKFLOW_ID = process.env.CHATKIT_WORKFLOW_ID;

app.post("/api/chatkit/session", async (req, res) => {
  try {
    const user = (req.body && (req.body.userId || req.body.deviceId)) || "anon";
    const session = await openai.chatkit.sessions.create({
      workflow: { id: WORKFLOW_ID },
      user
    });
    return res.json({ client_secret: session.client_secret });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "chatkit_session_failed" });
  }
});

// Importante: escuchar el puerto que Railway te pasa
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("API listening on " + PORT));
