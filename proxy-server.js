/**
 * MyStand24 — Backend Proxy v3.0
 * --------------------------------
 * Analisi stand:     Anthropic Claude  → /api/analyze
 * Brand lookup:      DuckDuckGo + Clearbit → /api/lookup
 * Rendering img2img: fal.ai FLUX.1-pro → /api/render
 *
 * Flusso rendering:
 *   Browser cattura SVG isometrico → base64 PNG
 *   POST /api/render { prompt, imageBase64 }
 *   → upload su fal.ai storage → FLUX img2img
 *   → ritorna URL immagine fotorealistica coerente col 3D
 */

const express = require("express");
const cors    = require("cors");
const fetch   = require("node-fetch");
require("dotenv").config();

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(express.json({ limit: "20mb" }));
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || "*",
  methods: ["GET", "POST", "OPTIONS"],
}));

// ── Health check ──────────────────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "MyStand24 Proxy" });
});

app.get("/api/status", (req, res) => {
  res.json({
    status:        "ok",
    anthropic_key: process.env.ANTHROPIC_API_KEY ? "ok" : "MANCANTE",
    fal_key:       process.env.FAL_API_KEY       ? "ok" : "MANCANTE",
    openai_key:    process.env.OPENAI_API_KEY    ? "ok (non usato)" : "non configurata",
    version:       "3.0.0",
    engine:        "fal.ai FLUX.1-pro img2img",
  });
});

// ── Anthropic Claude ──────────────────────────────────────────────────────────

app.post("/api/analyze", async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages) return res.status(400).json({ error: "Campo messages mancante." });

    const claudeKey = process.env.ANTHROPIC_API_KEY;
    if (!claudeKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY non configurata." });

    console.log(`[${new Date().toISOString()}] Claude analyze`);

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         claudeKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 2000, messages }),
    });

    const data = await r.json();
    if (!r.ok) {
      console.error("Errore Claude:", data);
      return res.status(r.status).json({ error: data?.error?.message || "Errore Claude." });
    }
    res.json(data);
  } catch (err) {
    console.error("/api/analyze:", err);
    res.status(500).json({ error: "Errore interno." });
  }
});

// ── Brand lookup ──────────────────────────────────────────────────────────────

app.get("/api/lookup", async (req, res) => {
  const domain = (req.query.domain || "").trim().toLowerCase()
    .replace(/^https?:\/\//, "").replace(/\/.*/, "");
  if (!domain) return res.status(400).json({ error: "Parametro domain mancante." });

  const logoUrl = `https://logo.clearbit.com/${domain}`;
  const website = `https://${domain}`;

  try {
    const ddg = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(domain)}&format=json&no_html=1&skip_disambig=1`,
      { headers: { "User-Agent": "Mozilla/5.0 (compatible; MyStand24Bot/1.0)" } }
    ).then(r => r.json());

    res.json({
      logoUrl,
      website,
      abstract:   ddg.Abstract    || "",
      heading:    ddg.Heading     || "",
      ddgImage:   ddg.Image       || "",
      websiteUrl: ddg.AbstractURL || website,
    });
  } catch {
    res.json({ logoUrl, website, abstract: "", heading: "" });
  }
});

// ── fal.ai upload helper ──────────────────────────────────────────────────────

async function uploadToFalStorage(base64Data, mimeType, falKey) {
  const buffer = Buffer.from(base64Data, "base64");

  const uploadRes = await fetch("https://fal.run/storage/upload", {
    method: "POST",
    headers: {
      "Authorization": `Key ${falKey}`,
      "Content-Type":  mimeType,
    },
    body: buffer,
  });

  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    throw new Error(`fal storage upload failed (${uploadRes.status}): ${err}`);
  }

  const { url } = await uploadRes.json();
  return url;
}

// ── fal.ai FLUX img2img ───────────────────────────────────────────────────────

app.post("/api/render", async (req, res) => {
  try {
    const { prompt, imageBase64, mimeType = "image/png" } = req.body;

    if (!prompt) return res.status(400).json({ error: "Campo prompt mancante." });

    const falKey = process.env.FAL_API_KEY;
    if (!falKey) return res.status(500).json({ error: "FAL_API_KEY non configurata sul server." });

    console.log(`[${new Date().toISOString()}] fal.ai render | img2img=${!!imageBase64} | prompt: ${prompt.slice(0, 80)}...`);

    let endpoint, falBody;

    if (imageBase64) {
      // Carica il rendering isometrico su fal storage
      console.log(`  Uploading base image (${Math.round(imageBase64.length / 1024)}KB)...`);
      const baseImageUrl = await uploadToFalStorage(imageBase64, mimeType, falKey);
      console.log(`  Uploaded: ${baseImageUrl}`);

      // FLUX img2img: trasforma il rendering 3D SVG in fotorealismo
      endpoint = "https://fal.run/fal-ai/flux-pro/v1.1-ultra";
      falBody = {
        prompt,
        image_url:           baseImageUrl,
        strength:            0.78,   // mantiene struttura, aggiunge fotorealismo
        image_size:          "landscape_16_9",
        num_inference_steps: 28,
        guidance_scale:      3.5,
        output_format:       "jpeg",
        safety_tolerance:    "5",
      };
    } else {
      // Fallback text-to-image se non arriva immagine base
      endpoint = "https://fal.run/fal-ai/flux-pro";
      falBody = {
        prompt,
        image_size:          "landscape_16_9",
        num_inference_steps: 28,
        guidance_scale:      3.5,
        output_format:       "jpeg",
        safety_tolerance:    "5",
      };
    }

    const falRes = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Key ${falKey}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify(falBody),
    });

    const falData = await falRes.json();

    if (!falRes.ok) {
      console.error("Errore fal.ai:", JSON.stringify(falData).slice(0, 400));
      return res.status(falRes.status).json({
        error: falData?.detail || falData?.message || `Errore fal.ai (${falRes.status}).`,
      });
    }

    const imageUrl = falData?.images?.[0]?.url;
    if (!imageUrl) {
      console.error("Risposta fal.ai inattesa:", JSON.stringify(falData).slice(0, 300));
      return res.status(500).json({ error: "Nessuna immagine ricevuta da fal.ai." });
    }

    console.log(`  Done: ${imageUrl}`);
    res.json({ url: imageUrl });

  } catch (err) {
    console.error("/api/render error:", err.message);
    res.status(500).json({ error: err.message || "Errore interno." });
  }
});

// ── Avvio ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n✅  MyStand24 Proxy v3.0 — porta ${PORT}`);
  console.log(`    ANTHROPIC_API_KEY : ${process.env.ANTHROPIC_API_KEY ? "✓" : "✗ MANCANTE"}`);
  console.log(`    FAL_API_KEY       : ${process.env.FAL_API_KEY       ? "✓" : "✗ MANCANTE"}\n`);
});
