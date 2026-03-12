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
  methods: ["GET", "POST", "OPTIONS"],
}));

// ── Health check ──────────────────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "MyStand24 Proxy" });
});

// ── Endpoint Claude (Anthropic) ───────────────────────────────────────────────

app.post("/api/analyze", async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages) return res.status(400).json({ error: "Campo 'messages' mancante." });

    const claudeKey = process.env.ANTHROPIC_API_KEY;
    if (!claudeKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY non configurata sul server." });

    console.log(`[${new Date().toISOString()}] Richiesta analisi Claude`);

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":         "application/json",
        "x-api-key":            claudeKey,
        "anthropic-version":    "2023-06-01",
      },
      body: JSON.stringify({
        model:      "claude-sonnet-4-6",
        max_tokens: 2000,
        messages,
      }),
    });

    const claudeData = await claudeRes.json();
    if (!claudeRes.ok) {
      console.error("Errore Claude:", claudeData);
      return res.status(claudeRes.status).json({ error: claudeData?.error?.message || "Errore Claude." });
    }

    res.json(claudeData);
  } catch (err) {
    console.error("Errore server /api/analyze:", err);
    res.status(500).json({ error: "Errore interno del server." });
  }
});

// ── Endpoint brand lookup (DuckDuckGo + Clearbit logo) ───────────────────────

app.get("/api/lookup", async (req, res) => {
  const domain = (req.query.domain || "").trim().toLowerCase().replace(/^https?:\/\//,"").replace(/\/.*/,"");
  if (!domain) return res.status(400).json({ error: "Parametro 'domain' mancante." });

  const logoUrl = `https://logo.clearbit.com/${domain}`;
  const website = `https://${domain}`;

  try {
    // DuckDuckGo Instant Answer API (public, no auth)
    const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(domain)}&format=json&no_html=1&skip_disambig=1`;
    const ddgRes = await fetch(ddgUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MyStand24Bot/1.0)" },
    });
    const ddg = await ddgRes.json();

    res.json({
      logoUrl,
      website,
      abstract:  ddg.Abstract   || "",
      heading:   ddg.Heading    || "",
      ddgImage:  ddg.Image      || "",
      websiteUrl: ddg.AbstractURL || website,
    });
  } catch(e) {
    // Fallback: ritorna solo logo Clearbit
    res.json({ logoUrl, website, abstract: "", heading: "" });
  }
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
