/**
 * MyStand24 — Backend Proxy per DALL-E 3
 * ----------------------------------------
 * Questo server riceve le richieste dal tuo sito (o dall'artifact),
 * aggiunge la API key OpenAI, e le inoltra a OpenAI.
 * La API key rimane sul server e non è mai esposta al browser.
 */

const express = require("express");
const cors    = require("cors");
const fetch   = require("node-fetch");
require("dotenv").config();

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Middlewares ───────────────────────────────────────────────────────────────

app.use(express.json({ limit: "10mb" }));

// CORS: permetti solo le origini del tuo sito
// In sviluppo puoi usare "*", in produzione specifica il tuo dominio
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || "*",
  methods: ["POST", "OPTIONS"],
}));

// ── Health check ──────────────────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "MyStand24 Proxy" });
});

// ── Endpoint DALL-E 3 ─────────────────────────────────────────────────────────

app.post("/api/render", async (req, res) => {
  try {
    const { prompt } = req.body;

    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "Campo 'prompt' mancante o non valido." });
    }

    if (prompt.length > 4000) {
      return res.status(400).json({ error: "Prompt troppo lungo (max 4000 caratteri)." });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "OPENAI_API_KEY non configurata sul server." });
    }

    console.log(`[${new Date().toISOString()}] Richiesta rendering — prompt: ${prompt.slice(0, 80)}…`);

    const openaiRes = await fetch("https://api.openai.com/v1/images/generations", {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model:   "dall-e-3",
        prompt:  prompt,
        n:       1,
        size:    "1792x1024",
        quality: "hd",
      }),
    });

    const openaiData = await openaiRes.json();

    if (!openaiRes.ok) {
      console.error("Errore OpenAI:", openaiData);
      return res.status(openaiRes.status).json({
        error: openaiData?.error?.message || "Errore OpenAI.",
      });
    }

    // Ritorna solo l'URL dell'immagine al client
    const imageUrl = openaiData.data?.[0]?.url;
    if (!imageUrl) {
      return res.status(500).json({ error: "Nessuna immagine ricevuta da OpenAI." });
    }

    res.json({ url: imageUrl });

  } catch (err) {
    console.error("Errore server:", err);
    res.status(500).json({ error: "Errore interno del server." });
  }
});

// ── Avvio ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`✅ MyStand24 Proxy in ascolto su http://localhost:${PORT}`);
  console.log(`   OPENAI_API_KEY: ${process.env.OPENAI_API_KEY ? "✓ configurata" : "✗ MANCANTE"}`);
  console.log(`   ALLOWED_ORIGIN: ${process.env.ALLOWED_ORIGIN || "* (tutti)"}`);
});
