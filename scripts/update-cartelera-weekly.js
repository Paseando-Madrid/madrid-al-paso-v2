/**
 * Update Cartelera (Weekly)
 * - Genera /data/cartelera-weekly.json
 * - Teatro: mezcla multi-sede (cupos), sin venta entradas en salida
 * - Danza: sub-bloque dentro de Cartelera (cupos)
 *
 * Requiere: npm i cheerio@1
 */

import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { URL } from "node:url";
import * as cheerio from "cheerio";

const OUT_PATH = path.join(process.cwd(), "data", "cartelera-weekly.json");

const LIMITS = {
  theatreMax: 10, // total teatro (no más de 12 sumando danza)
  danceMax: 3
};

const UA =
  "Mozilla/5.0 (compatible; PaseandoMadridBot/1.0; +https://paseando-madrid.github.io/)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* =========================================================
   HTTP (sin fetch / sin undici) -> evita "File is not defined"
   ========================================================= */

function httpsRequest(urlStr, { method = "GET", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);

    const req = https.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method,
        headers: {
          "user-agent": UA,
          ...headers
        }
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            text: () => data
          });
        });
      }
    );

    req.on("error", reject);

    if (body) req.write(body);
    req.end();
  });
}

async function requestWithRetry(url, opts = {}, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await httpsRequest(url, opts);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return res;
    } catch (e) {
      lastErr = e;
      await sleep(350 * (i + 1));
    }
  }
  throw lastErr;
}

async function fetchText(url, opts) {
  const res = await requestWithRetry(url, opts);
  return res.text();
}

/* ========================================================= */

function normSpace(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripHtml(html) {
  const $ = cheerio.load(String(html || ""));
  return normSpace($.text());
}

function toMapsUrl(query) {
  const q = encodeURIComponent(normSpace(query));
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
}

function dedupeBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const k = keyFn(it);
    if (!k) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

function pickFirstSentence(text, max = 200) {
  const t = normSpace(text);
  if (!t) return "";
  const cut = t.split(". ").slice(0, 2).join(". ");
  return cut.length > max ? cut.slice(0, max - 1) + "…" : cut;
}

/**
 * JSON-LD extractor (Matadero / Nave10)
 */
function extractJsonLdObjects(html) {
  const $ = cheerio.load(html);
  const scripts = $('script[type="application/ld+json"]')
    .map((_, el) => $(el).html())
    .get()
    .filter(Boolean);

  const out = [];
  for (const raw of scripts) {
    const txt = String(raw).trim();
    if (!txt) continue;
    try {
      const parsed = JSON.parse(txt);

      // Puede venir como array, objeto, o graph
      if (Array.isArray(parsed)) {
        for (const o of parsed) out.push(o);
      } else if (parsed && typeof parsed === "object") {
        if (Array.isArray(parsed["@graph"])) {
          for (const o of parsed["@graph"]) out.push(o);
        } else {
          out.push(parsed);
        }
      }
    } catch (_) {
      // ignorar
    }
  }
  return out;
}

function pickEventFromJsonLd(jsonLdArr) {
  // Priorizamos objetos tipo *Event
  const events = jsonLdArr.filter(
    (o) => o && typeof o === "object" && /Event$/i.test(String(o["@type"] || ""))
  );
  if (events.length) return events[0];

  const any = jsonLdArr.find((o) => o && typeof o === "object" && o.name && o.url);
  return any || null;
}

function classifyMataderoEvent({ name, description, locationName }) {
  const n = (name || "").toLowerCase();
  const d = (description || "").toLowerCase();
  const loc = (locationName || "").toLowerCase();

  const kidsSignals =
    /\b(familiar|infantil|niñ|nino|nina|familias)\b/.test(n) ||
    /\b(edad recomendada|intergeneracional)\b/.test(d) ||
    /\b(taller)\b/.test(loc);

  if (kidsSignals) return "kids";

  if (/\b(naves|nave 10)\b/.test(loc)) return "theatre";

  return "other";
}

/**
 * -------------------------
 * FUENTES
 * -------------------------
 */

/**
 * 1) Teatro Canal (WordPress admin-ajax) — teatro y danza
 * action=get_todos_espectaculos
 * section=teatro|danza
 */
async function scrapeCanalSection(section) {
  const url = "https://www.teatroscanal.com/wp-admin/admin-ajax.php";
  const body = new URLSearchParams({
    action: "get_todos_espectaculos",
    section,
    page: "1",
    ppp: "24"
  }).toString();

  const html = await fetchText(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body
  });

  const $ = cheerio.load(html);

  const cards = $("a")
    .map((_, a) => {
      const href = $(a).attr("href");
      const text = normSpace($(a).text());
      if (!href) return null;

      if (!/^https?:\/\//.test(href)) return null;
      if (!/teatroscanal\.com/.test(href)) return null;

      const $card = $(a).closest("div");
      const title =
        normSpace($card.find("h3,h2,.title").first().text()) || text || null;

      if (!title) return null;

      const img = $card.find("img").first().attr("src") || null;

      const rawTxt = normSpace($card.text());
      const dateText = rawTxt.match(
        /(\b\d{1,2}\s+de\s+\w+\s+de\s+\d{4}\b)|(\bDel\s+\d{1,2}\s+al\s+\d{1,2}\s+de\s+\w+\s+de\s+\d{4}\b)|(\b\d{1,2}\s+y\s+\d{1,2}\s+de\s+\w+\s+de\s+\d{4}\b)/i
      );
      const dateStr = dateText ? normSpace(dateText[0]) : null;

      return {
        title,
        link: href,
        image: img,
        dateText: dateStr
      };
    })
    .get()
    .filter(Boolean);

  const unique = dedupeBy(cards, (c) => c.link);

  return unique.map((c) => ({
    source: "canal",
    kind: section === "danza" ? "dance" : "theatre",
    title: c.title,
    credits: "",
    deck: "",
    dateText: c.dateText || "",
    venue: "Teatros del Canal",
    address: "C. de Cea Bermúdez, 1, Madrid",
    mapsQuery: "Teatros del Canal, Madrid",
    mapsUrl: toMapsUrl("Teatros del Canal, Madrid"),
    link: c.link,
    image: c.image || ""
  }));
}

/**
 * 2) Nave 10 (JSON-LD por evento) — listamos en /programacion?field_category[14]=14
 */
async function scrapeNave10Theatre() {
  const listUrl =
    "https://www.nave10matadero.es/programacion?field_category%5B14%5D=14";
  const html = await fetchText(listUrl);
  const $ = cheerio.load(html);

  const links = $("a")
    .map((_, a) => $(a).attr("href"))
    .get()
    .filter(Boolean)
    .map((href) => (href.startsWith("http") ? href : `https://www.nave10matadero.es${href}`))
    .filter((href) => /\/actividades\//.test(href));

  const uniqueLinks = [...new Set(links)].slice(0, 12);

  const out = [];
  for (const url of uniqueLinks) {
    const page = await fetchText(url);
    const jsonLd = extractJsonLdObjects(page);
    const ev = pickEventFromJsonLd(jsonLd);
    if (!ev || !ev.name) continue;

    const desc = stripHtml(ev.description || "");
    const deck = pickFirstSentence(desc, 210);

    out.push({
      source: "nave10",
      kind: "theatre",
      title: normSpace(ev.name),
      credits: "",
      deck,
      startDate: ev.startDate || "",
      endDate: ev.endDate || "",
      dateText: "",
      venue: "Nave 10 Matadero",
      address: "Plaza de Legazpi, 8, Madrid",
      mapsQuery: "Nave 10 Matadero, Plaza de Legazpi 8, Madrid",
      mapsUrl: toMapsUrl("Nave 10 Matadero, Plaza de Legazpi 8, Madrid"),
      link: ev.url || url,
      image:
        (typeof ev.image === "string" ? ev.image : ev.image?.url) || ""
    });
  }
  return out;
}

/**
 * 3) Matadero (JSON-LD por evento) — desde /programacion?f[0]=category:185 (teatro)
 * Filtrado: excluye talleres/familiar → irán a CON NIÑOS luego
 */
async function scrapeMataderoTheatre() {
  const listUrl =
    "https://www.mataderomadrid.org/programacion?f%5B0%5D=category%3A185";
  const html = await fetchText(listUrl);
  const $ = cheerio.load(html);

  const links = $("a.field-group-link, a.field-group-link[href]")
    .map((_, a) => $(a).attr("href"))
    .get()
    .filter(Boolean)
    .map((href) => (href.startsWith("http") ? href : `https://www.mataderomadrid.org${href}`))
    .filter((href) => /\/programacion\//.test(href));

  const uniqueLinks = [...new Set(links)].slice(0, 14);

  const out = [];
  for (const url of uniqueLinks) {
    const page = await fetchText(url);
    const jsonLd = extractJsonLdObjects(page);
    const ev = pickEventFromJsonLd(jsonLd);
    if (!ev || !ev.name) continue;

    const locationName = ev.location?.name || "";
    const desc = stripHtml(ev.description || "");
    const cls = classifyMataderoEvent({
      name: ev.name,
      description: desc,
      locationName
    });
    if (cls !== "theatre") continue;

    const deck = pickFirstSentence(desc, 210);

    out.push({
      source: "matadero",
      kind: "theatre",
      title: normSpace(ev.name),
      credits: "",
      deck,
      startDate: ev.startDate || "",
      endDate: ev.endDate || "",
      dateText: "",
      venue: locationName || "Matadero Madrid",
      address: ev.location?.address?.streetAddress
        ? `${ev.location.address.streetAddress}, Madrid`
        : "Plaza de Legazpi, 8, Madrid",
      mapsQuery: ev.location?.address?.streetAddress
        ? `${ev.location.address.streetAddress}, Madrid`
        : "Matadero Madrid, Plaza de Legazpi 8, Madrid",
      mapsUrl: toMapsUrl(
        ev.location?.address?.streetAddress
          ? `${ev.location.address.streetAddress}, Madrid`
          : "Matadero Madrid, Plaza de Legazpi 8, Madrid"
      ),
      link: ev.url || url,
      image: ev.image?.url ? `https://www.mataderomadrid.org${ev.image.url}` : ""
    });
  }

  return out;
}

/**
 * -------------------------
 * SELECCIÓN / CUPO
 * -------------------------
 */
function cap(items, max) {
  return items.slice(0, Math.max(0, max));
}

function sortEditorial(items) {
  const parse = (s) => {
    const t = Date.parse(s || "");
    return Number.isFinite(t) ? t : Infinity;
  };
  return [...items].sort((a, b) => parse(a.startDate) - parse(b.startDate));
}

function sanitizeForOutput(it) {
  return {
    source: it.source,
    kind: it.kind,
    title: it.title,
    credits: it.credits || "",
    deck: it.deck || "",
    startDate: it.startDate || "",
    endDate: it.endDate || "",
    dateText: it.dateText || "",
    venue: it.venue || "",
    address: it.address || "",
    mapsQuery: it.mapsQuery || "",
    mapsUrl: it.mapsUrl || "",
    link: it.link || "",
    image: it.image || ""
  };
}

async function main() {
  const theatre = [];
  const dance = [];

  const canalTheatre = await scrapeCanalSection("teatro");
  const canalDance = await scrapeCanalSection("danza");

  const nave10 = await scrapeNave10Theatre();
  const mataderoTheatre = await scrapeMataderoTheatre();

  theatre.push(...canalTheatre, ...nave10, ...mataderoTheatre);
  dance.push(...canalDance);

  const theatreUnique = dedupeBy(theatre, (x) => x.link || `${x.source}:${x.title}`);
  const danceUnique = dedupeBy(dance, (x) => x.link || `${x.source}:${x.title}`);

  const theatreFinal = cap(sortEditorial(theatreUnique), LIMITS.theatreMax).map(
    sanitizeForOutput
  );
  const danceFinal = cap(sortEditorial(danceUnique), LIMITS.danceMax).map(sanitizeForOutput);

  const out = {
    updatedAt: new Date().toISOString(),
    theatre: theatreFinal,
    dance: danceFinal,
    meta: { limits: LIMITS }
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + "\n", "utf-8");

  console.log(
    `OK: wrote ${OUT_PATH} (theatre=${theatreFinal.length}, dance=${danceFinal.length})`
  );
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});

