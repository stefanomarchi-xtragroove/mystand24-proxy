/**
 * MyStand24 — Backend Proxy v3.5
 * ────────────────────────────────
 * GET  /              → health check
 * GET  /api/status    → stato chiavi + knowledge caricata
 * POST /api/analyze   → Claude architetto (system prompt da knowledge.md + web search cliente)
 * GET  /api/lookup    → brand info: scrape sito + payoff + AI rewrite IT
 * POST /api/render    → fal.ai FLUX.1-pro img2img
 */

const express = require("express");
const cors    = require("cors");
const fetch   = require("node-fetch");
const fs      = require("fs");
const path    = require("path");
require("dotenv").config();

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(express.json({ limit: "25mb" }));
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || "*", methods: ["GET","POST","OPTIONS"] }));

// ── Carica knowledge.md ───────────────────────────────────────────────────────
let KNOWLEDGE = "";
const KNOWLEDGE_PATH = path.join(__dirname, "knowledge.md");

function loadKnowledge() {
  try {
    if (fs.existsSync(KNOWLEDGE_PATH)) {
      KNOWLEDGE = fs.readFileSync(KNOWLEDGE_PATH, "utf8");
      console.log(`📚 knowledge.md caricata (${KNOWLEDGE.length} chars)`);
    } else {
      console.warn("⚠️  knowledge.md non trovata — verrà usato solo il prompt base");
    }
  } catch (e) {
    console.error("Errore lettura knowledge.md:", e.message);
  }
}
loadKnowledge();
// Ricarica senza riavvio (ogni 5 minuti — utile su Render)
setInterval(loadKnowledge, 5 * 60 * 1000);

// ── System prompt per Claude architetto ──────────────────────────────────────
function buildSystemPrompt() {
  // Cap knowledge to avoid token overflow when combined with large image messages
  const k = KNOWLEDGE ? KNOWLEDGE.slice(0, 12000) : "";
  const knowledgeBlock = k ? "---\n" + k + "\n---" : "";
  return "Sei un architetto fieristico creativo senior che lavora per MyStand24, specializzata in stand modulari per fiere ed eventi.\n\n"
    + "Il tuo compito: analizzare le foto dello stand del cliente e proporre una soluzione con il sistema Vector MyStand24 — audace, scenografica, calibrata sul brand.\n\n"
    + knowledgeBlock
    + "\n\nRispondi SEMPRE e SOLO con JSON valido, nessun testo fuori dal JSON:\n"
    + "{ \"clientName\": \"nome azienda\", \"clientIndustry\": \"settore\", \"clientDomain\": \"dominio o stringa vuota\","
    + " \"model\": { \"id\": \"id-modello\", \"name\": \"Nome\", \"w\": 0, \"d\": 0, \"type\": \"angolo\" },"
    + " \"colors\": [\"#hex1\", \"#hex2\"],"
    + " \"marketingNarrative\": \"testo evocativo 2-3 frasi italiano\","
    + " \"displaySuggestion\": \"accessori MyStand24 + posizione + motivazione\","
    + " \"webResearch\": \"info online sul cliente o stringa vuota\","
    + " \"designRationale\": \"spiegazione scelte progettuali\" }";
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "ok", service: "MyStand24 Proxy" }));

app.get("/api/status", (req, res) => res.json({
  status:        "ok",
  version:       "3.5.0",
  engine:        "fal.ai FLUX.1-pro img2img",
  knowledge:     KNOWLEDGE ? `caricata (${KNOWLEDGE.length} chars)` : "non trovata",
  anthropic_key: process.env.ANTHROPIC_API_KEY ? "ok" : "MANCANTE",
  fal_key:       process.env.FAL_API_KEY       ? "ok" : "MANCANTE",
}));

// ── Ricerca web cliente (DuckDuckGo) ──────────────────────────────────────────
async function searchClientOnline(clientName, domain) {
  if (!clientName || clientName === "il tuo brand") return "";
  try {
    const queries = [
      `${clientName} fiera stand fieristico`,
      domain ? `${domain} exhibition stand trade show` : `${clientName} trade show booth`,
    ];
    const results = [];
    for (const q of queries) {
      const r = await fetch(
        `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`,
        { headers: { "User-Agent": "MyStand24Bot/1.0" }, signal: AbortSignal.timeout(4000) }
      );
      const d = await r.json();
      if (d.Abstract) results.push(d.Abstract);
      (d.RelatedTopics || []).slice(0, 2).forEach(t => { if (t.Text) results.push(t.Text); });
    }
    return results.slice(0, 4).join(" | ");
  } catch (e) {
    console.warn("  web search failed:", e.message);
    return "";
  }
}

// ── Claude analyze ────────────────────────────────────────────────────────────
app.post("/api/analyze", async (req, res) => {
  try {
    const { messages, clientName, clientDomain } = req.body;
    if (!messages) return res.status(400).json({ error: "messages mancante" });

    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return res.status(500).json({ error: "ANTHROPIC_API_KEY non configurata" });

    console.log(`[${new Date().toISOString()}] /api/analyze | client: ${clientName || "?"}`);

    // Cerca il cliente online in parallelo mentre prepariamo la chiamata
    const webResearch = await searchClientOnline(clientName, clientDomain);
    if (webResearch) {
      console.log(`  web research: ${webResearch.slice(0, 80)}…`);
    }

    // Inietta la web research nell'ultimo messaggio utente se disponibile
    let finalMessages = messages;
    if (webResearch) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg.role === "user") {
        // Aggiungi la research come contesto aggiuntivo
        const researchNote = `\n\n[RICERCA WEB SUL CLIENTE: ${webResearch}]`;
        if (typeof lastMsg.content === "string") {
          finalMessages = [
            ...messages.slice(0, -1),
            { ...lastMsg, content: lastMsg.content + researchNote }
          ];
        } else if (Array.isArray(lastMsg.content)) {
          // Aggiungi come blocco testo aggiuntivo
          finalMessages = [
            ...messages.slice(0, -1),
            { ...lastMsg, content: [...lastMsg.content, { type: "text", text: researchNote }] }
          ];
        }
      }
    }

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method:  "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      "claude-sonnet-4-6",
        max_tokens: 3000,
        system:     buildSystemPrompt(),
        messages:   finalMessages,
      }),
    });

    const data = await r.json();
    if (!r.ok) {
      console.error("Claude error:", data);
      return res.status(r.status).json({ error: data?.error?.message || "Errore Claude" });
    }
    res.json(data);
  } catch (e) {
    console.error("/api/analyze:", e);
    res.status(500).json({ error: "Errore interno" });
  }
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

function extractContacts(html) {
  const phoneRe = /(?:\+39[\s.-]?)?(?:0\d{1,4}[\s.-]?\d{4,8}|\+\d{10,14})/g;
  const phones = [...new Set((html.replace(/<[^>]+>/g, " ").match(phoneRe) || [])
    .map(p => p.trim()).filter(p => p.replace(/\D/g, "").length >= 8))].slice(0, 2);
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
          const parts = [addr.streetAddress, addr.postalCode, addr.addressLocality, addr.addressCountry].filter(Boolean).join(", ");
          if (parts.length > 5) { address = parts; break; }
        }
      }
    } catch { }
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

async function rewriteInItalian(rawText, companyName, claudeKey) {
  if (!rawText || !claudeKey) return rawText;
  try {
    const r = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
      method:  "POST",
      headers: { "Content-Type": "application/json", "x-api-key": claudeKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model:      "claude-haiku-4-5-20251001",
        max_tokens: 120,
        messages: [{ role: "user", content: `Riscrivi in italiano fluente e professionale, massimo 2 frasi. Solo il testo riscritto.\n\nAzienda: ${companyName}\nTesto: ${rawText}` }],
      }),
    }, 8000);
    const data = await r.json();
    return data?.content?.[0]?.text?.trim() || rawText;
  } catch { return rawText; }
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

  const scrapeWebsite = async () => {
    try {
      const r = await fetchWithTimeout(siteUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; MyStand24Bot/1.0)", "Accept": "text/html" },
      });
      if (!r.ok) return {};
      const html    = await r.text();
      const title   = getMeta(html, "og:title", "twitter:title") || html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() || "";
      const desc    = getMeta(html, "og:description", "twitter:description", "description");
      const ogImage = getMeta(html, "og:image", "twitter:image");
      const favicon = getFavicon(html, siteUrl);
      const contacts = extractContacts(html);
      let payoff = "";
      const sm = html.match(/"slogan"\s*:\s*"([^"]{5,120})"/i);
      if (sm) payoff = sm[1].trim();
      if (!payoff) {
        const siteName = getMeta(html, "og:site_name");
        if (siteName && siteName !== title && siteName.length < 80) payoff = siteName;
      }
      if (!payoff) {
        const rawTitle = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() || "";
        const sep = rawTitle.match(/[|\-–—·]/);
        if (sep) {
          const parts = rawTitle.split(sep[0]).map(p => p.trim());
          const domainBase = domain.replace(/\.(com|it|eu|net|org)$/, "");
          const candidate = parts.find(p => p.length > 4 && !p.toLowerCase().includes(domainBase.toLowerCase()));
          if (candidate && candidate !== title) payoff = candidate;
        }
      }
      return { title, desc, ogImage, favicon, payoff, ...contacts };
    } catch (e) { console.warn("  website scrape failed:", e.message); return {}; }
  };

  const scrapeLinkedIn = async () => {
    try {
      const query = encodeURIComponent(`${domain} site:linkedin.com/company`);
      const r = await fetchWithTimeout(
        `https://api.duckduckgo.com/?q=${query}&format=json&no_html=1&skip_disambig=1`,
        { headers: { "User-Agent": "MyStand24Bot/1.0" } }
      );
      const ddg = await r.json();
      let linkedInUrl = "", linkedInDesc = ddg.Abstract || "";
      for (const t of (ddg.RelatedTopics || [])) {
        if ((t.FirstURL || "").includes("linkedin.com/company")) {
          linkedInUrl = t.FirstURL; linkedInDesc = linkedInDesc || t.Text || ""; break;
        }
      }
      if (!linkedInUrl) {
        const slug = domain.replace(/\.(com|it|eu|net|org|co\.\w+)$/, "").replace(/\./g, "-");
        linkedInUrl = `https://www.linkedin.com/company/${slug}`;
      }
      return { linkedInUrl, linkedInDesc };
    } catch { return {}; }
  };

  const [web, linkedin] = await Promise.all([scrapeWebsite(), scrapeLinkedIn()]);
  const rawDesc   = web.desc || linkedin.linkedInDesc || "";
  const companyName = web.title || domain;
  const abstract  = rawDesc ? await rewriteInItalian(rawDesc, companyName, claudeKey) : "";
  const logoUrl   = web.ogImage || web.favicon || clearbitLogo;

  console.log(`  → logo: ${logoUrl.slice(0,60)} | payoff: ${(web.payoff||"—").slice(0,40)}`);

  res.json({
    logoUrl, website: siteUrl, websiteUrl: siteUrl,
    abstract, heading: companyName, companyName,
    payoff:   web.payoff  || "",
    address:  web.address || "",
    ogImage:  web.ogImage || "",
    favicon:  web.favicon || clearbitLogo,
  });
});

// ── fal.ai FLUX img2img ───────────────────────────────────────────────────────
app.post("/api/render", async (req, res) => {
  try {
    const { prompt, imageBase64, mimeType = "image/jpeg" } = req.body;
    if (!prompt) return res.status(400).json({ error: "prompt mancante" });
    const falKey = process.env.FAL_API_KEY;
    if (!falKey) return res.status(500).json({ error: "FAL_API_KEY non configurata" });

    console.log(`[${new Date().toISOString()}] /api/render | img2img=${!!imageBase64} | ${Math.round((imageBase64||"").length/1024)}KB`);

    let endpoint, body;
    if (imageBase64) {
      endpoint = "https://fal.run/fal-ai/flux-pro/v1.1-ultra";
      body = { prompt, image_url: `data:${mimeType};base64,${imageBase64}`, strength: 0.72,
               image_size: "landscape_16_9", num_inference_steps: 28, guidance_scale: 3.5,
               output_format: "jpeg", safety_tolerance: "5" };
    } else {
      endpoint = "https://fal.run/fal-ai/flux-pro";
      body = { prompt, image_size: "landscape_16_9", num_inference_steps: 28,
               guidance_scale: 3.5, output_format: "jpeg", safety_tolerance: "5" };
    }

    const falRes  = await fetch(endpoint, {
      method: "POST",
      headers: { "Authorization": `Key ${falKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const falData = await falRes.json();
    if (!falRes.ok) return res.status(falRes.status).json({ error: falData?.detail || falData?.message || `fal.ai error ${falRes.status}` });
    const url = falData?.images?.[0]?.url;
    if (!url) return res.status(500).json({ error: "Nessuna immagine da fal.ai" });
    console.log(`  → ${url}`);
    res.json({ url });
  } catch (e) { res.status(500).json({ error: e.message || "Errore interno" }); }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅  MyStand24 Proxy v3.5.1 — porta ${PORT}`);
  console.log(`    ANTHROPIC_API_KEY : ${process.env.ANTHROPIC_API_KEY ? "✓" : "✗ MANCANTE"}`);
  console.log(`    FAL_API_KEY       : ${process.env.FAL_API_KEY       ? "✓" : "✗ MANCANTE"}`);
  console.log(`    knowledge.md      : ${KNOWLEDGE ? `✓ (${KNOWLEDGE.length} chars)` : "✗ non trovata"}\n`);
});
