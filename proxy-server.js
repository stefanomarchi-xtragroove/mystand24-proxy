/**
 * MyStand24 — Backend Proxy v3.2
 * ────────────────────────────────
 * GET  /              → health check
 * GET  /api/status    → stato chiavi
 * POST /api/analyze   → Anthropic Claude (analisi stand)
 * GET  /api/lookup    → brand info: scrape sito + ricerca LinkedIn su DDG
 * POST /api/render    → fal.ai FLUX.1-pro img2img
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
  version:       "3.2.0",
  engine:        "fal.ai FLUX.1-pro img2img",
  lookup:        "web scrape + LinkedIn via DDG",
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

// ── Helpers scraping ──────────────────────────────────────────────────────────

// Estrae il valore di un meta tag da HTML grezzo
function getMeta(html, ...names) {
  for (const name of names) {
    // og:xxx  /  name="description"  /  property="og:image"
    const patterns = [
      new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']+)["']`, "i"),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${name}["']`, "i"),
    ];
    for (const re of patterns) {
      const m = html.match(re);
      if (m && m[1].trim()) return m[1].trim();
    }
  }
  return "";
}

// Estrae href del favicon da HTML grezzo
function getFavicon(html, baseUrl) {
  const m = html.match(/<link[^>]+rel=["'](?:shortcut )?icon["'][^>]+href=["']([^"']+)["']/i)
         || html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["'](?:shortcut )?icon["']/i);
  if (!m) return `${baseUrl}/favicon.ico`;
  const href = m[1];
  if (href.startsWith("http")) return href;
  if (href.startsWith("//")) return "https:" + href;
  if (href.startsWith("/")) return baseUrl + href;
  return baseUrl + "/" + href;
}

// Fetch con timeout
async function fetchWithTimeout(url, opts = {}, ms = 6000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally { clearTimeout(t); }
}

// ── Brand lookup: scrape sito + LinkedIn via DuckDuckGo ──────────────────────
app.get("/api/lookup", async (req, res) => {
  const domain = (req.query.domain || "").trim().toLowerCase()
    .replace(/^https?:\/\//, "").replace(/\/.*/, "");
  if (!domain) return res.status(400).json({ error: "domain mancante" });

  const siteUrl    = `https://${domain}`;
  const clearbitLogo = `https://logo.clearbit.com/${domain}`;

  console.log(`[${new Date().toISOString()}] /api/lookup → ${domain}`);

  // ── 1. Scrape sito web ─────────────────────────────────────────────────────
  const scrapeWebsite = async () => {
    try {
      const r = await fetchWithTimeout(siteUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; MyStand24Bot/1.0; +https://mystand24.it)",
          "Accept":     "text/html",
        },
      }, 7000);
      if (!r.ok) return {};
      const html = await r.text();
      const title    = getMeta(html, "og:title", "twitter:title")
                    || html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim()
                    || "";
      const desc     = getMeta(html, "og:description", "twitter:description", "description");
      const ogImage  = getMeta(html, "og:image", "twitter:image");
      const favicon  = getFavicon(html, siteUrl);
      return { title, desc, ogImage, favicon };
    } catch (e) {
      console.warn("  website scrape failed:", e.message);
      return {};
    }
  };

  // ── 2. Cerca pagina LinkedIn via DuckDuckGo ────────────────────────────────
  const scrapeLinkedIn = async () => {
    try {
      // Cerca su DDG: {domain} site:linkedin.com/company
      const query = encodeURIComponent(`${domain} site:linkedin.com/company`);
      const r = await fetchWithTimeout(
        `https://api.duckduckgo.com/?q=${query}&format=json&no_html=1&skip_disambig=1`,
        { headers: { "User-Agent": "Mozilla/5.0 (compatible; MyStand24Bot/1.0)" } },
        6000
      );
      const ddg = await r.json();

      // RelatedTopics contiene spesso il risultato LinkedIn
      let linkedInUrl  = "";
      let linkedInDesc = ddg.Abstract || "";

      // Cerca URL LinkedIn nei RelatedTopics
      const topics = ddg.RelatedTopics || [];
      for (const t of topics) {
        const url = t.FirstURL || "";
        if (url.includes("linkedin.com/company")) {
          linkedInUrl  = url;
          linkedInDesc = linkedInDesc || (t.Text || "");
          break;
        }
      }

      // Se DDG non ha trovato niente, prova a costruire l'URL canonico
      if (!linkedInUrl) {
        const slug = domain.replace(/\.(com|it|eu|net|org|co\.\w+)$/, "").replace(/\./g, "-");
        linkedInUrl = `https://www.linkedin.com/company/${slug}`;
      }

      // Tenta di scrapare direttamente la pagina LinkedIn (spesso bloccata, ma vale la pena)
      if (linkedInUrl) {
        try {
          const lr = await fetchWithTimeout(linkedInUrl, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
              "Accept-Language": "it-IT,it;q=0.9",
            },
          }, 5000);
          if (lr.ok) {
            const lhtml = await lr.text();
            const ldesc = getMeta(lhtml, "og:description", "description");
            if (ldesc) linkedInDesc = ldesc;
          }
        } catch { /* bloccato da LinkedIn, ignora */ }
      }

      return { linkedInUrl, linkedInDesc };
    } catch (e) {
      console.warn("  LinkedIn lookup failed:", e.message);
      return {};
    }
  };

  // ── Esegui in parallelo ────────────────────────────────────────────────────
  const [web, linkedin] = await Promise.all([scrapeWebsite(), scrapeLinkedIn()]);

  // ── Assembla risposta ──────────────────────────────────────────────────────
  const logoUrl = web.ogImage || web.favicon || clearbitLogo;
  const name    = web.title   || domain;
  const abstract = web.desc   || linkedin.linkedInDesc || "";

  console.log(`  → logo: ${logoUrl.slice(0,60)} | linkedin: ${linkedin.linkedInUrl || "n/a"}`);

  res.json({
    // compatibilità con il frontend esistente
    logoUrl,
    website:      siteUrl,
    abstract,
    heading:      name,
    websiteUrl:   siteUrl,
    // nuovi campi
    linkedInUrl:  linkedin.linkedInUrl  || "",
    linkedInDesc: linkedin.linkedInDesc || "",
    ogImage:      web.ogImage  || "",
    favicon:      web.favicon  || clearbitLogo,
    companyName:  name,
  });
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
      console.error("fal.ai error:", JSON.stringify(falData).slice(0,300));
      return res.status(falRes.status).json({ error: falData?.detail || falData?.message || `fal.ai error ${falRes.status}` });
    }

    const url = falData?.images?.[0]?.url;
    if (!url) return res.status(500).json({ error: "Nessuna immagine da fal.ai" });

    console.log(`  → ${url}`);
    res.json({ url });

  } catch (e) { console.error("/api/render:", e.message); res.status(500).json({ error: e.message || "Errore interno" }); }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅  MyStand24 Proxy v3.2 — porta ${PORT}`);
  console.log(`    ANTHROPIC_API_KEY : ${process.env.ANTHROPIC_API_KEY ? "✓" : "✗ MANCANTE"}`);
  console.log(`    FAL_API_KEY       : ${process.env.FAL_API_KEY       ? "✓" : "✗ MANCANTE"}\n`);
});
