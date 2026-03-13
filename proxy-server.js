/**
 * MyStand24 — Backend Proxy v3.3
 * ────────────────────────────────
 * GET  /              → health check
 * GET  /api/status    → stato chiavi
 * POST /api/analyze   → Anthropic Claude (analisi stand)
 * GET  /api/lookup    → brand info: scrape sito + LinkedIn + rielaborazione AI in italiano
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
  version:       "3.4.0",
  engine:        "fal.ai FLUX.1-pro img2img",
  lookup:        "web scrape + payoff + AI rielaborazione IT",
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

function getMeta(html, ...names) {
  for (const name of names) {
    const patterns = [
      new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"'<>]{2,300})["']`, "i"),
      new RegExp(`<meta[^>]+content=["']([^"'<>]{2,300})["'][^>]+(?:property|name)=["']${name}["']`, "i"),
    ];
    for (const re of patterns) {
      const m = html.match(re);
      if (m && m[1].trim()) return m[1].trim();
    }
  }
  return "";
}

function getFavicon(html, baseUrl) {
  const m = html.match(/<link[^>]+rel=["'](?:shortcut )?icon["'][^>]+href=["']([^"']+)["']/i)
         || html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["'](?:shortcut )?icon["']/i);
  if (!m) return `${baseUrl}/favicon.ico`;
  const href = m[1];
  if (href.startsWith("http")) return href;
  if (href.startsWith("//"))   return "https:" + href;
  if (href.startsWith("/"))    return baseUrl + href;
  return baseUrl + "/" + href;
}

// Estrae telefono e indirizzo con regex semplici
function extractContacts(html) {
  // Telefono: cerca pattern tipo +39 02 1234567, 02-1234567, +390212345678
  const phoneRe = /(?:\+39[\s.-]?)?(?:0\d{1,4}[\s.-]?\d{4,8}|\+\d{10,14})/g;
  const phones = [...new Set((html.replace(/<[^>]+>/g, " ").match(phoneRe) || [])
    .map(p => p.trim())
    .filter(p => p.replace(/\D/g, "").length >= 8)
  )].slice(0, 2);

  // Indirizzo: cerca JSON-LD schema.org (più affidabile)
  let address = "";
  const jsonLdRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let jm;
  while ((jm = jsonLdRe.exec(html)) !== null) {
    try {
      const obj = JSON.parse(jm[1]);
      const entries = Array.isArray(obj) ? obj : [obj];
      for (const e of entries) {
        const addr = e.address || e.location?.address;
        if (addr) {
          const parts = [addr.streetAddress, addr.postalCode, addr.addressLocality, addr.addressCountry]
            .filter(Boolean).join(", ");
          if (parts.length > 5) { address = parts; break; }
        }
      }
    } catch { /* JSON non valido, ignora */ }
    if (address) break;
  }

  return { phone: phones[0] || "", address };
}

async function fetchWithTimeout(url, opts = {}, ms = 7000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

// Rielabora il testo in italiano fluente con Claude
async function rewriteInItalian(rawText, companyName, claudeKey) {
  if (!rawText || !claudeKey) return rawText;
  try {
    const r = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
      method:  "POST",
      headers: { "Content-Type": "application/json", "x-api-key": claudeKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model:      "claude-haiku-4-5-20251001",
        max_tokens: 120,
        messages: [{
          role:    "user",
          content: `Riscrivi questa descrizione aziendale in italiano fluente e professionale, massimo 2 frasi concise. Solo il testo riscritto, niente altro.\n\nAzienda: ${companyName}\nTesto originale: ${rawText}`,
        }],
      }),
    }, 8000);
    const data = await r.json();
    return data?.content?.[0]?.text?.trim() || rawText;
  } catch (e) {
    console.warn("  rewrite failed:", e.message);
    return rawText;
  }
}

// ── Brand lookup ──────────────────────────────────────────────────────────────
app.get("/api/lookup", async (req, res) => {
  const domain = (req.query.domain || "").trim().toLowerCase()
    .replace(/^https?:\/\//, "").replace(/\/.*/, "");
  if (!domain) return res.status(400).json({ error: "domain mancante" });

  const siteUrl      = `https://${domain}`;
  const clearbitLogo = `https://logo.clearbit.com/${domain}`;
  const claudeKey    = process.env.ANTHROPIC_API_KEY;

  console.log(`[${new Date().toISOString()}] /api/lookup → ${domain}`);

  // ── 1. Scrape sito web ─────────────────────────────────────────────────────
  const scrapeWebsite = async () => {
    try {
      const r = await fetchWithTimeout(siteUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; MyStand24Bot/1.0)", "Accept": "text/html" },
      });
      if (!r.ok) return {};
      const html  = await r.text();
      const title = getMeta(html, "og:title", "twitter:title")
                 || html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() || "";
      const desc    = getMeta(html, "og:description", "twitter:description", "description");
      const ogImage = getMeta(html, "og:image", "twitter:image");
      const favicon = getFavicon(html, siteUrl);
      const contacts = extractContacts(html);

      // Payoff / tagline: cerca og:site_name, slogan schema.org, o testo dopo il trattino nel <title>
      let payoff = "";
      // 1. schema.org slogan
      const sloganRe = /"slogan"\s*:\s*"([^"]{5,120})"/i;
      const sm = html.match(sloganRe);
      if (sm) payoff = sm[1].trim();
      // 2. og:site_name diverso dal titolo
      if (!payoff) {
        const siteName = getMeta(html, "og:site_name");
        if (siteName && siteName !== title && siteName.length < 80) payoff = siteName;
      }
      // 3. <title> spesso ha formato "Azienda | Payoff" o "Azienda - Payoff"
      if (!payoff) {
        const rawTitle = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() || "";
        const sep = rawTitle.match(/[|\-–—·]/);
        if (sep) {
          const parts = rawTitle.split(sep[0]).map(p => p.trim());
          // il payoff è la parte che NON assomiglia al dominio
          const domainBase = domain.replace(/\.(com|it|eu|net|org)$/, "");
          const candidate = parts.find(p => p.length > 4 && !p.toLowerCase().includes(domainBase.toLowerCase()));
          if (candidate && candidate !== title) payoff = candidate;
        }
      }

      return { title, desc, ogImage, favicon, payoff, ...contacts };
    } catch (e) { console.warn("  website scrape failed:", e.message); return {}; }
  };

  // ── 2. LinkedIn via DuckDuckGo ─────────────────────────────────────────────
  const scrapeLinkedIn = async () => {
    try {
      const query = encodeURIComponent(`${domain} site:linkedin.com/company`);
      const r = await fetchWithTimeout(
        `https://api.duckduckgo.com/?q=${query}&format=json&no_html=1&skip_disambig=1`,
        { headers: { "User-Agent": "MyStand24Bot/1.0" } }
      );
      const ddg = await r.json();
      let linkedInUrl  = "";
      let linkedInDesc = ddg.Abstract || "";
      for (const t of (ddg.RelatedTopics || [])) {
        if ((t.FirstURL || "").includes("linkedin.com/company")) {
          linkedInUrl  = t.FirstURL;
          linkedInDesc = linkedInDesc || t.Text || "";
          break;
        }
      }
      if (!linkedInUrl) {
        const slug = domain.replace(/\.(com|it|eu|net|org|co\.\w+)$/, "").replace(/\./g, "-");
        linkedInUrl = `https://www.linkedin.com/company/${slug}`;
      }
      // Tenta scrape diretto LinkedIn
      try {
        const lr = await fetchWithTimeout(linkedInUrl, {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Accept-Language": "it-IT" },
        }, 5000);
        if (lr.ok) {
          const lhtml = await lr.text();
          const ldesc = getMeta(lhtml, "og:description", "description");
          if (ldesc) linkedInDesc = ldesc;
        }
      } catch { /* bloccato, ignora */ }
      return { linkedInUrl, linkedInDesc };
    } catch (e) { console.warn("  LinkedIn lookup failed:", e.message); return {}; }
  };

  // ── Esegui in parallelo ────────────────────────────────────────────────────
  const [web, linkedin] = await Promise.all([scrapeWebsite(), scrapeLinkedIn()]);

  // ── Scegli il testo migliore e rielabora in italiano ──────────────────────
  const rawDesc   = web.desc || linkedin.linkedInDesc || "";
  const companyName = web.title || domain;
  const abstract  = rawDesc ? await rewriteInItalian(rawDesc, companyName, claudeKey) : "";

  const logoUrl = web.ogImage || web.favicon || clearbitLogo;

  console.log(`  → logo: ${logoUrl.slice(0,60)} | phone: ${web.phone||"—"} | addr: ${(web.address||"—").slice(0,40)} | linkedin: ${linkedin.linkedInUrl||"n/a"}`);

  res.json({
    logoUrl,
    website:      siteUrl,
    websiteUrl:   siteUrl,
    abstract,
    heading:      companyName,
    companyName,
    payoff:       web.payoff  || "",
    address:      web.address || "",
    ogImage:      web.ogImage || "",
    favicon:      web.favicon || clearbitLogo,
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
      endpoint = "https://fal.run/fal-ai/flux-pro/v1.1-ultra";
      body = {
        prompt,
        image_url:           `data:${mimeType};base64,${imageBase64}`,
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

    const falRes  = await fetch(endpoint, {
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
  console.log(`\n✅  MyStand24 Proxy v3.4 — porta ${PORT}`);
  console.log(`    ANTHROPIC_API_KEY : ${process.env.ANTHROPIC_API_KEY ? "✓" : "✗ MANCANTE"}`);
  console.log(`    FAL_API_KEY       : ${process.env.FAL_API_KEY       ? "✓" : "✗ MANCANTE"}\n`);
});
