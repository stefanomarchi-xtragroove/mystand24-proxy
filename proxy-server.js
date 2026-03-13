/**
 * MyStand24 — Backend Proxy v3.1
 * ────────────────────────────────
 * GET  /              → health check
 * GET  /api/status    → stato chiavi
 * POST /api/analyze   → Anthropic Claude (analisi stand)
 * GET  /api/lookup    → brand info (DuckDuckGo + Clearbit)
 * POST /api/render    → fal.ai FLUX.1-pro img2img
 *
 * Flusso rendering:
 *   Browser → cattura foto utente → base64 JPEG
 *   POST /api/render { prompt, imageBase64, mimeType }
 *   → FLUX img2img (image_url = data URL inline, no upload separato)
 *   → ritorna { url: "https://..." }
 */

const express = require("express");
const cors    = require("cors");
const fetch   = require("node-fetch");
require("dotenv").config();

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(express.json({ limit: "25mb" }));
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || "*", methods: ["GET","POST","OPTIONS"] }));

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "ok", service: "MyStand24 Proxy" }));

app.get("/api/status", (req, res) => res.json({
  status:        "ok",
  version:       "3.1.0",
  engine:        "fal.ai FLUX.1-pro img2img (data URL, no upload)",
  anthropic_key: process.env.ANTHROPIC_API_KEY ? "ok" : "MANCANTE",
  fal_key:       process.env.FAL_API_KEY       ? "ok" : "MANCANTE",
  openai_key:    process.env.OPENAI_API_KEY    ? "ok" : "non configurata",
}));

// ── Claude analyze ────────────────────────────────────────────────────────────
app.post("/api/analyze", async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages) return res.status(400).json({ error: "messages mancante" });

    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return res.status(500).json({ error: "ANTHROPIC_API_KEY non configurata" });

    console.log(`[${new Date().toISOString()}] /api/analyze`);

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method:  "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body:    JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 2000, messages }),
    });
    const data = await r.json();
    if (!r.ok) { console.error("Claude error:", data); return res.status(r.status).json({ error: data?.error?.message || "Errore Claude" }); }
    res.json(data);
  } catch (e) { console.error("/api/analyze:", e); res.status(500).json({ error: "Errore interno" }); }
});

// ── Brand lookup ──────────────────────────────────────────────────────────────
app.get("/api/lookup", async (req, res) => {
  const domain = (req.query.domain || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*/, "");
  if (!domain) return res.status(400).json({ error: "domain mancante" });
  const logoUrl = `https://logo.clearbit.com/${domain}`;
  try {
    const ddg = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(domain)}&format=json&no_html=1&skip_disambig=1`,
      { headers: { "User-Agent": "MyStand24Bot/1.0" } }
    ).then(r => r.json());
    res.json({ logoUrl, website: `https://${domain}`, abstract: ddg.Abstract || "", heading: ddg.Heading || "", websiteUrl: ddg.AbstractURL || `https://${domain}` });
  } catch { res.json({ logoUrl, website: `https://${domain}`, abstract: "", heading: "" }); }
});

// ── fal.ai FLUX img2img ───────────────────────────────────────────────────────
app.post("/api/render", async (req, res) => {
  try {
    const { prompt, imageBase64, mimeType = "image/jpeg" } = req.body;
    if (!prompt) return res.status(400).json({ error: "prompt mancante" });

    const falKey = process.env.FAL_API_KEY;
    if (!falKey) return res.status(500).json({ error: "FAL_API_KEY non configurata" });

    console.log(`[${new Date().toISOString()}] /api/render | img2img=${!!imageBase64} | ${Math.round((imageBase64||"").length/1024)}KB | prompt: ${prompt.slice(0,60)}…`);

    let endpoint, body;

    if (imageBase64) {
      // FLUX accetta data URL direttamente nel campo image_url — nessun upload separato
      const dataUrl = `data:${mimeType};base64,${imageBase64}`;
      endpoint = "https://fal.run/fal-ai/flux-pro/v1.1-ultra";
      body = {
        prompt,
        image_url:           dataUrl,
        strength:            0.72,
        image_size:          "landscape_16_9",
        num_inference_steps: 28,
        guidance_scale:      3.5,
        output_format:       "jpeg",
        safety_tolerance:    "5",
      };
    } else {
      // text-to-image fallback (nessuna foto caricata)
      endpoint = "https://fal.run/fal-ai/flux-pro";
      body = {
        prompt,
        image_size:          "landscape_16_9",
        num_inference_steps: 28,
        guidance_scale:      3.5,
        output_format:       "jpeg",
        safety_tolerance:    "5",
      };
    }

    const falRes = await fetch(endpoint, {
      method:  "POST",
      headers: { "Authorization": `Key ${falKey}`, "Content-Type": "application/json" },
      body:    JSON.stringify(body),
    });

    const falData = await falRes.json();

    if (!falRes.ok) {
      console.error("fal.ai error:", JSON.stringify(falData).slice(0, 300));
      return res.status(falRes.status).json({ error: falData?.detail || falData?.message || `fal.ai error ${falRes.status}` });
    }

    const url = falData?.images?.[0]?.url;
    if (!url) { console.error("fal.ai unexpected response:", JSON.stringify(falData).slice(0,200)); return res.status(500).json({ error: "Nessuna immagine da fal.ai" }); }

    console.log(`  → ${url}`);
    res.json({ url });

  } catch (e) { console.error("/api/render:", e.message); res.status(500).json({ error: e.message || "Errore interno" }); }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅  MyStand24 Proxy v3.1 — porta ${PORT}`);
  console.log(`    ANTHROPIC_API_KEY : ${process.env.ANTHROPIC_API_KEY ? "✓" : "✗ MANCANTE"}`);
  console.log(`    FAL_API_KEY       : ${process.env.FAL_API_KEY       ? "✓" : "✗ MANCANTE"}\n`);
});
