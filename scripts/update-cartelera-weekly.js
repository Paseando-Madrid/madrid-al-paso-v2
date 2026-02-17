import fs from "node:fs";
#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import https from "node:https";
import zlib from "node:zlib";
import { URL } from "node:url";
import zlib from "node:zlib";
import * as cheerio from "cheerio";

const OUT_PATH = path.join(process.cwd(), "data", "cartelera-weekly.json");

const LIMITS = { theatreMax: 10, danceMax: 2 };

// Cupos editoriales EXACTOS (tu regla)
const CAPS_THEATRE = {
  nave10: 2,
  "cdn-maria-guerrero": 1,
  "cdn-valle-inclan": 2,
  teatrodelbarrio: 1,
  pradillo: 1,
  teatroespanol: 1,
  canal: 2,
  matadero: 0
};

const CAPS_DANCE = { canal: 2 };

const UA =
  "Mozilla/5.0 (compatible; PaseandoMadridBot/1.0; +https://paseando-madrid.github.io/)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* =========================================================
   HTTP (sin fetch / sin undici)
   - Redirects
   - gzip/deflate/br
   ========================================================= */

function decompressBuffer(buf, encoding) {
  const enc = String(encoding || "").toLowerCase().trim();
  try {
    if (enc === "gzip") return zlib.gunzipSync(buf);
    if (enc === "deflate") return zlib.inflateSync(buf);
    if (enc === "br") return zlib.brotliDecompressSync(buf);
  } catch (_) {}
  return buf;
}

function httpsRequest(
  urlStr,
  { method = "GET", headers = {}, body = null, timeoutMs = 25000, maxRedirects = 6 } = {}
) {
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
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "es-ES,es;q=0.9,en;q=0.7",
          "accept-encoding": "gzip, deflate, br",
          ...headers
        }
      },
      (res) => {
        const status = res.statusCode || 0;

        const loc = res.headers.location;
        if (loc && [301, 302, 303, 307, 308].includes(status) && maxRedirects > 0) {
          const next = new URL(loc, urlStr).toString();
          const nextMethod = status === 303 ? "GET" : method;
          res.resume();
          httpsRequest(next, {
            method: nextMethod,
            headers,
            body: nextMethod === "GET" ? null : body,
            timeoutMs,
            maxRedirects: maxRedirects - 1
          })
            .then(resolve)
            .catch(reject);
          return;
        }

        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          const outBuf = decompressBuffer(buf, res.headers["content-encoding"]);
          const text = outBuf.toString("utf8");

          resolve({
            ok: status >= 200 && status < 300,
            status,
            headers: res.headers,
            text: () => text
          });
        });
      }
    );

    req.on("error", reject);
    req.setTimeout(timeoutMs, () =>
      req.destroy(new Error(`Timeout after ${timeoutMs}ms for ${urlStr}`))
    );

    if (body) req.write(body);
    req.end();
  });
}

async function requestWithRetry(url, opts = {}, { tries = 3, allowStatuses = [] } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await httpsRequest(url, opts);
      if (res.ok) return res;
      if (allowStatuses.includes(res.status)) return res;
      throw new Error(`HTTP ${res.status} for ${url}`);
    } catch (e) {
      lastErr = e;
      await sleep(450 * (i + 1));
    }
  }
  throw lastErr;
}

async function fetchText(url, opts = {}, meta = {}) {
  const res = await requestWithRetry(url, opts, meta);
  return res.text();
}

function looksLikeHtml(txt) {
  const t = String(txt || "").trim().toLowerCase();
  return t.startsWith("<!doctype") || t.startsWith("<html") || t.startsWith("<");
}
const MONTHS = {
  enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5,
  julio: 6, agosto: 7, septiembre: 8, setiembre: 8,
  octubre: 9, noviembre: 10, diciembre: 11,
  ene: 0, feb: 1, mar: 2, abr: 3, may: 4, jun: 5, jul: 6, ago: 7, sep: 8, oct: 9, nov: 10, dic: 11
};

/* =========================================================
   Helpers
   ========================================================= */
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";

function normSpace(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function stripHtml(html) {
  const $ = cheerio.load(String(html || ""));
  return normSpace($.text());
function normMonthKey(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function toMapsUrl(query) {
  const q = encodeURIComponent(normSpace(query));
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query || "")}`;
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
function toJinaUrl(raw) {
  const u = raw.startsWith("http") ? raw : `https://${raw}`;
  return `https://r.jina.ai/${u}`;
}

function pickFirstSentence(text, max = 210) {
  const t = normSpace(text);
  if (!t) return "";
  const cut = t.split(". ").slice(0, 2).join(". ");
  return cut.length > max ? cut.slice(0, max - 1) + "…" : cut;
function isoToMs(iso) {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? t : Infinity;
}

function truncateForUI(text, max = 160) {
  const t = normSpace(text);
  if (!t) return "";
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}
function parseSpanishStartDate(dateText) {
  const s = normSpace(dateText).toLowerCase();
  if (!s) return "";

/* --------- Fechas --------- */
  let m = s.match(/\b(\d{1,2})\s+([a-záéíóúñ]+)\s+(\d{4})\s*[-–]\s*(\d{1,2})\s+([a-záéíóúñ]+)\s+(\d{4})\b/i);
  if (m) {
    const d1 = Number(m[1]);
    const mon1 = MONTHS[normMonthKey(m[2])];
    const y1 = Number(m[3]);
    if (Number.isFinite(mon1)) return new Date(y1, mon1, d1, 0, 0, 0).toISOString();
  }

const MONTHS = {
  enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5,
  julio: 6, agosto: 7, septiembre: 8, setiembre: 8,
  octubre: 9, noviembre: 10, diciembre: 11,
  ene: 0, feb: 1, mar: 2, abr: 3, may: 4, jun: 5, jul: 6, ago: 7, sep: 8, oct: 9, nov: 10, dic: 11
};
  m = s.match(/\b(\d{1,2})\s*([a-záéíóúñ]{3,})\s*[-–]\s*(\d{1,2})\s*([a-záéíóúñ]{3,})(?:\s*(\d{4}))?/i);
  if (m) {
    const d1 = Number(m[1]);
    const mon1 = MONTHS[normMonthKey(m[2])];
    const mon2 = MONTHS[normMonthKey(m[4])];
    const y2 = m[5] ? Number(m[5]) : new Date().getFullYear();
    let y1 = y2;
    if (Number.isFinite(mon1) && Number.isFinite(mon2) && mon1 > mon2) y1 = y2 - 1;
    if (Number.isFinite(mon1)) return new Date(y1, mon1, d1, 0, 0, 0).toISOString();
  }

function normMonthKey(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  m = s.match(/\b(\d{1,2})\s*([a-záéíóúñ]+)\s*(\d{1,2})\s*([a-záéíóúñ]+)\s*(\d{4})\b/i);
  if (m) {
    const d1 = Number(m[1]);
    const mon1 = MONTHS[normMonthKey(m[2])];
    const y = Number(m[5]);
    if (Number.isFinite(mon1)) return new Date(y, mon1, d1, 0, 0, 0).toISOString();
  }

  m = s.match(/\bdel\s+(\d{1,2})\s+al\s+(\d{1,2})\s+de\s+([a-záéíóúñ]+)\s+de\s+(\d{4})\b/i);
  if (m) {
    const d1 = Number(m[1]);
    const mon = MONTHS[normMonthKey(m[3])];
    const y = Number(m[4]);
    if (Number.isFinite(mon)) return new Date(y, mon, d1, 0, 0, 0).toISOString();
  }

  return "";
}

function parseSpanishEndDate(dateText) {
  const s0 = normSpace(dateText);
  const s = s0.toLowerCase();
  const s = normSpace(dateText).toLowerCase();
  if (!s) return "";

  // ✅ "7 septiembre 2025 - 1 marzo 2026"
  let m = s.match(/\b(\d{1,2})\s+([a-záéíóúñ]+)\s+(\d{4})\s*[-–]\s*(\d{1,2})\s+([a-záéíóúñ]+)\s+(\d{4})\b/i);
  if (m) {
    const d2 = Number(m[4]);
    const mon = MONTHS[normMonthKey(m[5])];
    const y = Number(m[6]);
    if (Number.isFinite(mon)) return new Date(y, mon, d2, 23, 59, 59).toISOString();
    const mon2 = MONTHS[normMonthKey(m[5])];
    const y2 = Number(m[6]);
    if (Number.isFinite(mon2)) return new Date(y2, mon2, d2, 23, 59, 59).toISOString();
  }

  // "23 ENE - 01 MAR" / "13 FEB - 05 ABR 2026"
  m = s.match(/\b(\d{1,2})\s*([a-záéíóúñ]{3,})\s*[-–]\s*(\d{1,2})\s*([a-záéíóúñ]{3,})(?:\s*(\d{4}))?/i);
  if (m) {
    const d2 = Number(m[3]);
    const mon = MONTHS[normMonthKey(m[4])];
    const y = m[5] ? Number(m[5]) : new Date().getFullYear();
    if (Number.isFinite(mon)) return new Date(y, mon, d2, 23, 59, 59).toISOString();
    const mon1 = MONTHS[normMonthKey(m[2])];
    const mon2 = MONTHS[normMonthKey(m[4])];
    const yHint = m[5] ? Number(m[5]) : new Date().getFullYear();
    let y2 = yHint;
    if (Number.isFinite(mon1) && Number.isFinite(mon2) && mon1 > mon2) y2 = yHint + 1;
    if (Number.isFinite(mon2)) return new Date(y2, mon2, d2, 23, 59, 59).toISOString();
  }

  // "23 Enero7 Marzo 2026" (Español a veces sin separadores)
  m = s.match(/\b(\d{1,2})\s*([a-záéíóúñ]+)\s*(\d{1,2})\s*([a-záéíóúñ]+)\s*(\d{4})\b/i);
  if (m) {
    const d2 = Number(m[3]);
    const mon = MONTHS[normMonthKey(m[4])];
    const mon2 = MONTHS[normMonthKey(m[4])];
    const y = Number(m[5]);
    if (Number.isFinite(mon)) return new Date(y, mon, d2, 23, 59, 59).toISOString();
    if (Number.isFinite(mon2)) return new Date(y, mon2, d2, 23, 59, 59).toISOString();
  }

  // "del 10 al 22 de marzo de 2026"
  m = s.match(/\bdel\s+(\d{1,2})\s+al\s+(\d{1,2})\s+de\s+([a-záéíóúñ]+)\s+de\s+(\d{4})\b/i);
  if (m) {
    const d2 = Number(m[2]);
    const mon = MONTHS[normMonthKey(m[3])];
    const y = Number(m[4]);
    if (Number.isFinite(mon)) return new Date(y, mon, d2, 23, 59, 59).toISOString();
  }

  // "10 de marzo de 2026"
  m = s.match(/\b(\d{1,2})\s+de\s+([a-záéíóúñ]+)\s+de\s+(\d{4})\b/i);
  if (m) {
    const d = Number(m[1]);
    const mon = MONTHS[normMonthKey(m[2])];
    const y = Number(m[3]);
    if (Number.isFinite(mon)) return new Date(y, mon, d, 23, 59, 59).toISOString();
  }

  return "";
}

function isoToMs(iso) {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? t : Infinity;
}

function isExpired(it, nowMs) {
  const end = isoToMs(it.endDate);
  if (end !== Infinity) return end < nowMs - 24 * 60 * 60 * 1000;

  const start = isoToMs(it.startDate);
  if (start !== Infinity) return start < nowMs - 7 * 24 * 60 * 60 * 1000;

  return false;
function dedupeBy(items, keyFn) {
  const map = new Map();
  for (const it of items) {
    const k = keyFn(it);
    if (!k) continue;
    if (!map.has(k)) map.set(k, it);
  }
  return [...map.values()];
}

function sortByEndThenStart(items) {
  return [...items].sort((a, b) => {
    const ae = isoToMs(a.endDate);
    const be = isoToMs(b.endDate);
    if (ae !== be) return ae - be;

    const as = isoToMs(a.startDate);
    const bs = isoToMs(b.startDate);
    return as - bs;
  });
function truncateForUI(txt, max = 160) {
  const t = normSpace(txt);
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function sanitizeForOutput(it) {
  const creditsShort = truncateForUI(it.credits || "", 160);
  return {
    source: it.source,
    kind: it.kind,
    title: it.title,

    credits: creditsShort,
    credits: truncateForUI(it.credits || "", 160),
    deck: it.deck || "",

    author: it.author || "",
    director: it.director || "",
    company: it.company || "",
    choreographer: it.choreographer || "",
    cast: Array.isArray(it.cast) ? it.cast.slice(0, 6) : [],

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

/* =========================================================
   Selector plural por cupos
   ========================================================= */

function pickWithCaps(items, totalMax, capsBySource) {
  const sorted = sortByEndThenStart(items);
  const sorted = [...items].sort((a, b) => {
    const ae = isoToMs(a.endDate);
    const be = isoToMs(b.endDate);
    if (ae !== be) return ae - be;
    return isoToMs(a.startDate) - isoToMs(b.startDate);
  });

  const picked = [];
  const counts = new Map();

  // Pasada 1: cupos estrictos
  for (const it of sorted) {
    if (picked.length >= totalMax) break;
    const src = it.source || "other";

    if (!(src in capsBySource)) continue;
    const cap = capsBySource[src];
    if (cap === 0) continue;

    const n = counts.get(src) || 0;
    if (n >= cap) continue;

    if (picked.some((p) => p.link && it.link && p.link === it.link)) continue;
    if (picked.some((p) => p.link && p.link === it.link)) continue;

    picked.push(it);
    counts.set(src, n + 1);
  }

  // Pasada 2: relleno controlado
  if (picked.length < totalMax) {
    const fillOrder = [
      "teatroespanol",
      "cdn-valle-inclan",
      "cdn-maria-guerrero",
      "teatrodelbarrio",
      "pradillo",
      "nave10",
      "canal"
    ];

    for (const src of fillOrder) {
    for (const it of sorted) {
      if (picked.length >= totalMax) break;
      if (!(src in capsBySource)) continue;

      const baseCap = capsBySource[src] ?? 0;
      if (baseCap === 0) continue;

      const hard =
        src === "nave10" ? baseCap :
        src === "canal" ? baseCap :
        baseCap + 1;

      for (const it of sorted) {
        if (picked.length >= totalMax) break;
        if (it.source !== src) continue;

        if (picked.some((p) => p.link && it.link && p.link === it.link)) continue;

        const n = counts.get(src) || 0;
        if (n >= hard) continue;

        picked.push(it);
        counts.set(src, n + 1);
      }
      if (picked.some((p) => p.link && p.link === it.link)) continue;
      picked.push(it);
    }
  }

  return picked.slice(0, totalMax);
}

function tallyBySource(items) {
  return items.reduce((acc, x) => {
    acc[x.source] = (acc[x.source] || 0) + 1;
    return acc;
  }, {});
  return picked;
}

/* =========================================================
   JSON-LD helpers (CDN fichas + Nave10)
   ========================================================= */

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
      if (Array.isArray(parsed)) parsed.forEach((o) => out.push(o));
      else if (parsed && typeof parsed === "object") {
        if (Array.isArray(parsed["@graph"])) parsed["@graph"].forEach((o) => out.push(o));
        else out.push(parsed);
function requestRaw(urlStr, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const req = https.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: opts.method || "GET",
        headers: {
          "user-agent": UA,
          accept: "*/*",
          "accept-encoding": "gzip, deflate, br",
          ...opts.headers
        },
        timeout: opts.timeoutMs || 25000
      },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          resolve({ status: res.statusCode || 0, headers: res.headers, body: buf });
        });
      }
    } catch (_) {}
  }
  return out;
}
    );

function pickEventFromJsonLd(arr) {
  const events = arr.filter(
    (o) => o && typeof o === "object" && /Event$/i.test(String(o["@type"] || ""))
  );
  if (events.length) return events[0];
  return arr.find((o) => o && typeof o === "object" && o.name && o.url) || null;
    req.on("timeout", () => req.destroy(new Error(`timeout ${urlStr}`)));
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function normKeyLabel(s) {
  return normSpace(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
function decodeBody(buf, headers = {}) {
  const enc = String(headers["content-encoding"] || "").toLowerCase();
  try {
    if (enc.includes("br")) return zlib.brotliDecompressSync(buf);
    if (enc.includes("gzip")) return zlib.gunzipSync(buf);
    if (enc.includes("deflate")) return zlib.inflateSync(buf);
  } catch {}
  return buf;
}

function splitPeopleList(s) {
  const t = normSpace(s);
  if (!t) return [];
  const raw = t
    .replace(/\s*[•·|]\s*/g, ", ")
    .replace(/\s*;\s*/g, ", ")
    .replace(/\s*\/\s*/g, ", ")
    .replace(/\s+y\s+/gi, ", ");
  const parts = raw
    .split(",")
    .map((x) => normSpace(x))
    .filter(Boolean);
  return [...new Set(parts)];
}
async function requestWithRetry(url, opts = {}, retry = {}) {
  const tries = retry.tries || 3;
  const allowStatuses = retry.allowStatuses || [];
  let lastErr;
  let current = url;

function parseEquipoBoxFromDramatico($) {
  const out = {};
  const cast = [];

  $("div.equipo.box-line").each((_, el) => {
    const $box = $(el);
    $box.find(".content .item").each((__, it) => {
      const label = normKeyLabel($(it).find("h4").first().text());
      const val = normSpace($(it).find("p").first().text());
      if (!label || !val) return;

      if (label === "texto" || label === "dramaturgia" || label === "autor") out.author = val;
      else if (label.includes("version") && label.includes("direccion")) out.director = val;
      else if (label === "direccion" || label === "direccion escenica") out.director = val;
      else if (label === "reparto" || label === "interpretacion" || label === "intérpretes") {
        cast.push(...splitPeopleList(val));
      } else if (label === "compania" || label === "compañia" || label === "produccion") {
        out.company = val;
      } else if (label === "coreografia" || label === "coreografía") {
        out.choreographer = val;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await requestRaw(current, opts);

      if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.location) {
        current = new URL(res.headers.location, current).toString();
        continue;
      }
    });
  });

  if (cast.length) out.cast = [...new Set(cast)].slice(0, 8);
  return out;
      if (res.status >= 200 && res.status < 300) return res;
      if (allowStatuses.includes(res.status)) return res;
      lastErr = new Error(`HTTP ${res.status} for ${current}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 350 * (i + 1)));
  }

  throw lastErr || new Error(`request failed ${url}`);
}

function extractOgImage($) {
  return (
    $('meta[property="og:image"]').attr("content") ||
    $('meta[name="twitter:image"]').attr("content") ||
    ""
  );
async function fetchText(url, opts = {}, retry = {}) {
  const res = await requestWithRetry(url, opts, retry);
  const buf = decodeBody(res.body, res.headers);
  return Buffer.from(buf).toString("utf8");
}

/* =========================================================
   CDN — PROGRAMACIÓN + fallback JINA + fallback AJAX + ENRICH (ficha)
   ========================================================= */
function makeBaseItem(partial = {}) {
  return {
    source: "",
    kind: "theatre",
    title: "",
    credits: "",
    deck: "",
    author: "",
    director: "",
    company: "",
    choreographer: "",
    cast: [],
    startDate: "",
    endDate: "",
    dateText: "",
    venue: "",
    address: "",
    mapsQuery: "",
    mapsUrl: "",
    link: "",
    image: "",
    ...partial
  };
}

function cdnVenueMeta(source) {
  if (source === "cdn-maria-guerrero") {
function cdnVenueMetaByText(text) {
  const t = normSpace(text).toLowerCase();
  if (t.includes("maría guerrero") || t.includes("maria guerrero")) {
    return {
      source: "cdn-maria-guerrero",
      venue: "Teatro María Guerrero",
      address: "C. de Tamayo y Baus, 4, Madrid",
      mapsQuery: "Teatro María Guerrero, Madrid"
    };
  }
  if (source === "cdn-valle-inclan") {
  if (t.includes("valle-inclán") || t.includes("valle inclan") || t.includes("valle-inclan")) {
    return {
      source: "cdn-valle-inclan",
      venue: "Teatro Valle-Inclán",
      address: "C. de Plazuela de Ana Diosdado, 1, Madrid",
      mapsQuery: "Teatro Valle-Inclán, Madrid"
    };
  }
  return { venue: "Centro Dramático Nacional", address: "Madrid", mapsQuery: "Centro Dramático Nacional, Madrid" };
  return {
    source: "cdn-valle-inclan",
    venue: "Teatro Valle-Inclán",
    address: "C. de Plazuela de Ana Diosdado, 1, Madrid",
    mapsQuery: "Teatro Valle-Inclán, Madrid"
  };
}

function isWafChallengeHtml(html) {
  const h = String(html || "");
  const t = h.toLowerCase();
  const signals = [
    "cf-challenge",
    "challenge-platform",
    "attention required",
    "captcha",
    "incapsula",
    "imperva",
    "security check",
    "access denied",
    "/cdn-cgi/"
function extractCdnRange(text) {
  const t = normSpace(text);
  const patterns = [
    /\b\d{1,2}\s+[A-ZÁÉÍÓÚÑ]{3}\s*[-–]\s*\d{1,2}\s+[A-ZÁÉÍÓÚÑ]{3}(?:\s+\d{4})?\b/i,
    /\b\d{1,2}\s+[a-záéíóúñ]{3,}\s+\d{4}\s*[-–]\s*\d{1,2}\s+[a-záéíóúñ]{3,}\s+\d{4}\b/i,
    /\bdel\s+\d{1,2}\s+al\s+\d{1,2}\s+de\s+[a-záéíóúñ]+\s+de\s+\d{4}\b/i,
    /\b\d{1,2}\s*[A-Za-zÁÉÍÓÚáéíóúÑñ]+\s*\d{1,2}\s*[A-Za-zÁÉÍÓÚáéíóúÑñ]+\s*\d{4}\b/i
  ];
  const hasSignals = signals.some((s) => t.includes(s));
  const hasEvento = t.includes("/evento/");
  return hasSignals || !hasEvento;
}

/**
 * FIX CRÍTICO:
 * r.jina.ai funciona como: https://r.jina.ai/http(s)://<host>/...
 */
function toJinaUrl(url) {
  const u =
    url.startsWith("http://") || url.startsWith("https://")
      ? url
      : `https://${url}`;
  return `https://r.jina.ai/${u}`;
  for (const re of patterns) {
    const m = t.match(re);
    if (m) return normSpace(m[0]);
  }
  return "";
}

async function fetchTextCdnSmart(url, errors, venueTag) {
  // 1) intento directo
  const html1 = await fetchText(url, { headers: { accept: "text/html,*/*;q=0.9" } });
  if (!isWafChallengeHtml(html1)) return html1;

  errors.push({
    source: "cdn",
    venue: venueTag,
    message: `WAF/Challenge en ${url} (directo). Intento fallback r.jina.ai…`
  });

  // 2) fallback r.jina.ai
  try {
    const jUrl = toJinaUrl(url);
    const html2 = await fetchText(
      jUrl,
      { headers: { accept: "text/plain,*/*;q=0.9" } },
      { tries: 2 }
    );

    const t2 = String(html2).toLowerCase();
    if (
      t2.includes("/evento/") ||
      t2.includes("item-event-resume") ||
      t2.includes("evento-programacion") ||
      t2.includes("wrapper-detail")
    ) {
      return html2;
function extractCdnSchedule(text) {
  const lines = String(text || "").replace(/\r/g, "\n").split("\n").map(normSpace).filter(Boolean);
  for (const l of lines) {
    if (/(lunes|martes|mi[eé]rcoles|jueves|viernes|s[áa]bado|domingo|lun|mar|mi[eé]|jue|vie|s[áa]b|dom)/i.test(l) && /(a\s+las\s+\d{1,2}[:\.]\d{2}|\d{1,2}[:\.]\d{2}\s*h?\.?)/i.test(l)) {
      return normSpace(l.split("| Duración")[0].split("|")[0]);
    }

    errors.push({
      source: "cdn",
      venue: venueTag,
      message: `Fallback r.jina.ai no devolvió programación usable para ${url}`
    });
    return html1;
  } catch (e) {
    errors.push({
      source: "cdn",
      venue: venueTag,
      message: `Fallback r.jina.ai falló para ${url}: ${String(e?.message || e)}`
    });
    return html1;
  }
  return "";
}

function extractDateTextFromCDNCard($detail) {
  const p = $detail
    .find("p")
    .filter((_, el) => {
      const text = normSpace(stripHtml(cheerio.load(el).root().html() || ""));
      return /\b\d{1,2}\s+[A-ZÁÉÍÓÚÑ]{3}\s*[-–]\s*\d{1,2}\s+[A-ZÁÉÍÓÚÑ]{3}/.test(text);
    })
    .first();

  const txt = normSpace(stripHtml(p.html() || ""));
  const m = txt.match(/\b(\d{1,2}\s+[A-ZÁÉÍÓÚÑ]{3}\s*[-–]\s*\d{1,2}\s+[A-ZÁÉÍÓÚÑ]{3})(?:\s+(\d{4}))?/);
  if (!m) return "";
  return `${m[1]}${m[2] ? " " + m[2] : ""}`;
}

function parseCdnAuthorDirectorFromDetail($detail) {
  const out = { author: "", director: "", credits: "" };

  const ps = $detail.find("p").toArray().map((el) => {
    const html = cheerio.load(el).root().html() || "";
    const text = normSpace(stripHtml(html));
    return { html, text };
  });

  const ficha = ps.filter(
    (p) => p.text && !/\b\d{1,2}\s+[A-ZÁÉÍÓÚÑ]{3}\s*[-–]\s*\d{1,2}\s+[A-ZÁÉÍÓÚÑ]{3}/.test(p.text)
  );

  const blob = ficha.map((x) => x.text).join(" · ");
function parseAuthorDirectorFromText(text) {
  const t = normSpace(text);
  const out = { author: "", director: "" };

  let m = blob.match(/\bTexto\s+y\s+dirección\s+(.+)$/i);
  let m = t.match(/\btexto\s+y\s+direcci[oó]n\s*:?\s*([^|·\n]+)/i);
  if (m) {
    const person = normSpace(m[1]);
    out.author = person;
    out.director = person;
    out.credits = truncateForUI(person, 160);
    out.author = normSpace(m[1]);
    out.director = normSpace(m[1]);
    return out;
  }

  m = blob.match(/\b(Dramaturgia|Texto|Autor(?:ía)?)\s+(.+?)(?=(Dirección|Dirección asociada|$))/i);
  if (m) out.author = normSpace(m[2]);
  m = t.match(/\b(?:dramaturgia|texto|autor(?:[ií]a)?)\s*:?\s*([^|·\n]+?)(?=\b(?:direcci[oó]n|reparto|elenco|producci[oó]n)\b|$)/i);
  if (m) out.author = normSpace(m[1]);

  m = blob.match(/\bDirección(?:\s+asociada)?\s+(.+?)(?=($|Dirección asociada|Producción|Compañ[ií]a))/i);
  m = t.match(/\b(?:direcci[oó]n|versi[oó]n\s+y\s+direcci[oó]n)\s*:?\s*([^|·\n]+?)(?=\b(?:dramaturgia|texto|autor(?:[ií]a)?|reparto|elenco|producci[oó]n)\b|$)/i);
  if (m) out.director = normSpace(m[1]);

  const bits = [];
  if (out.author) bits.push(out.author);
  if (out.director) bits.push(out.director);
  out.credits = truncateForUI(bits.join(" · "), 160);

  return out;
}

function extractCdnScheduleFromEventLeftPanel($) {
  const p = $("div.col-lg-5.col-left .box-title .detail > p").first();
  if (!p.length) return { scheduleText: "", rangeText: "" };

  const rangeText = normSpace(p.find("strong").first().text() || "");
  const html = (p.html() || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n");

  const lines = stripHtml(html)
    .split("\n")
    .map(normSpace)
    .filter(Boolean);

  const scheduleLine =
    lines.find((x) => /a\s+las\s+\d{1,2}:\d{2}/i.test(x) || /martes|miércoles|jueves|viernes|sábado|domingo|lunes/i.test(x)) ||
    "";

  const scheduleText = scheduleLine ? scheduleLine.split("|")[0].trim() : "";
  return { scheduleText, rangeText };
}

/* =========================================================
   INAEM (entradasinaem.es) — ENRICH ROBUSTO (sin clases sc-*)
   ========================================================= */

function findFirstMatch(text, re) {
  const m = String(text || "").match(re);
  return m ? m[0] : "";
}

function parseInaemDateRangeFromText(txt) {
  const t = normSpace(txt);
  // Ej: "14 febrero 2026 - 05 abril 2026"
  const m = t.match(/\b(\d{1,2})\s+([a-záéíóúñ]+)\s+(\d{4})\s*[-–]\s*(\d{1,2})\s+([a-záéíóúñ]+)\s+(\d{4})\b/i);
  if (!m) return { startIso: "", endIso: "" };

  const d1 = Number(m[1]);
  const mon1 = MONTHS[normMonthKey(m[2])];
  const y1 = Number(m[3]);

  const d2 = Number(m[4]);
  const mon2 = MONTHS[normMonthKey(m[5])];
  const y2 = Number(m[6]);

  if (!Number.isFinite(mon1) || !Number.isFinite(mon2)) return { startIso: "", endIso: "" };

  const startIso = new Date(y1, mon1, d1, 0, 0, 0).toISOString();
  const endIso = new Date(y2, mon2, d2, 23, 59, 59).toISOString();
  return { startIso, endIso };
function mergeCdnDateText(rangeText, scheduleText, fallback = "") {
  const range = normSpace(rangeText);
  const sched = normSpace(scheduleText);
  if (range && sched) return `${range} · ${sched}`;
  if (range) return `${range} · Consultar taquilla`;
  return normSpace(fallback);
}

function extractInaemTeamFromText(txt) {
  const t = String(txt || "");
  const lines = t.split("\n").map(normSpace).filter(Boolean);

  const idx = lines.findIndex((l) => /equipo\s+art[ií]stico/i.test(l));
  if (idx === -1) return { author: "", director: "", cast: [] };
async function fetchCdnSeedLinks(errors) {
  const seeds = [
    "https://dramatico.inaem.gob.es/temporada/temporada-25-26/",
    "https://dramatico.inaem.gob.es/prensa/"
  ];

  const slice = lines.slice(idx + 1, idx + 70);
  const links = new Set();

  let outAuthor = "";
  let outDirector = "";
  const outCast = [];
  for (const seed of seeds) {
    const tries = [seed, toJinaUrl(seed)];
    let ok = false;

  for (let i = 0; i < slice.length; i++) {
    const l = slice[i];
    for (const u of tries) {
      try {
        const txt = await fetchText(u, { headers: { accept: u.includes("r.jina.ai") ? "text/plain,*/*;q=0.9" : "text/html,*/*;q=0.9" } }, { tries: 2 });
        const rawMatches = txt.match(/https?:\/\/dramatico\.inaem\.gob\.es\/evento\/[a-z0-9\-]+\/?/gi) || [];
        for (const m of rawMatches) links.add(m.replace(/\/?$/, "/"));

    if (/^texto\s+y\s+direcci[oó]n$/i.test(l)) {
      const v = slice[i + 1] || "";
      if (v) { outAuthor = v; outDirector = v; }
      i++;
      continue;
    }
    if (/^texto$/i.test(l) || /^dramaturgia$/i.test(l) || /^autor(?:[ií]a)?$/i.test(l)) {
      const v = slice[i + 1] || "";
      if (v) outAuthor = v;
      i++;
      continue;
    }
    if (/^direcci[oó]n$/i.test(l) || /^direcci[oó]n\s+esc[eé]nica$/i.test(l) || /^versi[oó]n\s+y\s+direcci[oó]n$/i.test(l)) {
      const v = slice[i + 1] || "";
      if (v) outDirector = v;
      i++;
      continue;
    }
    if (/^reparto$/i.test(l) || /^int[eé]rpretes$/i.test(l) || /^interpretaci[oó]n$/i.test(l)) {
      const v = slice[i + 1] || "";
      if (v) outCast.push(...splitPeopleList(v));
      i++;
      continue;
        const $ = cheerio.load(txt);
        $("a[href*='/evento/']").each((_, a) => {
          const href = $(a).attr("href") || "";
          if (!href) return;
          const abs = href.startsWith("http") ? href : `https://dramatico.inaem.gob.es${href}`;
          if (/\/evento\/[a-z0-9\-]+\/?$/i.test(abs)) links.add(abs.replace(/\/?$/, "/"));
        });
        ok = true;
        break;
      } catch (e) {
        errors.push({ source: "cdn", venue: "seed", message: `seed fail ${u}: ${String(e?.message || e)}` });
      }
    }

    if (!ok) errors.push({ source: "cdn", venue: "seed", message: `seed unavailable ${seed}` });
  }

  return { author: outAuthor, director: outDirector, cast: [...new Set(outCast)].slice(0, 8) };
  return [...links];
}

async function enrichInaemFromEntradas(item, errors) {
  // Solo para fichas CDN (de donde sacamos el link a entradas)
  if (!item?.link || !/dramatico\.inaem\.gob\.es\/evento\//.test(item.link)) return item;

  try {
    // 1) sacar URL de entradas desde la ficha CDN (usando JINA para evitar WAF)
    const fichaTxt = await fetchText(
      toJinaUrl(item.link),
      { headers: { accept: "text/plain,*/*;q=0.9" } },
      { tries: 2 }
    );
    const $ = cheerio.load(fichaTxt);

    const entradasHref =
      $("a[href*='entradasinaem.es']").first().attr("href") ||
      findFirstMatch(fichaTxt, /https?:\/\/entradasinaem\.es\/[^\s"'<>]+/i);

    if (!entradasHref) return item;

    // 2) cargar entradasinaem y parsear por texto (robusto)
    const eHtml = await fetchText(
      entradasHref,
      { headers: { accept: "text/html,*/*;q=0.9" } },
      { tries: 2 }
    );

    const $$ = cheerio.load(eHtml);
    const pageText = $$.text().replace(/\r/g, "");

    const { startIso, endIso } = parseInaemDateRangeFromText(pageText);
    const team = extractInaemTeamFromText(pageText);
function buildCdnItemFromDom(item, $, rawHtml) {
  const textAll = $.text();

    const enriched = { ...item };
  const title = normSpace($("h1").first().text()) || item.title;

    // Fechas: solo si faltan
    if (startIso && !enriched.startDate) enriched.startDate = startIso;
    if (endIso && !enriched.endDate) enriched.endDate = endIso;
  const detailP = $("div.col-lg-5.col-left .box-title .detail > p").first();
  const rangeFromStrong = normSpace(detailP.find("strong").first().text());
  const htmlP = detailP.html() || "";
  const lines = cheerio.load(`<x>${htmlP.replace(/<br\s*\/?>/gi, "\n")}</x>`)("x").text().split("\n").map(normSpace).filter(Boolean);
  const scheduleFromDetail = lines.find((l) => /a\s+las\s+\d{1,2}[:\.]\d{2}|\d{1,2}[:\.]\d{2}\s*h|lunes|martes|mi[eé]rcoles|jueves|viernes|s[áa]bado|domingo/i.test(l) && l !== rangeFromStrong) || "";

    // dateText humano (rango) si falta
    if (!enriched.dateText) {
      const rangeHuman = findFirstMatch(
        pageText,
        /\b\d{1,2}\s+[a-záéíóúñ]+\s+\d{4}\s*[-–]\s*\d{1,2}\s+[a-záéíóúñ]+\s+\d{4}\b/i
      );
      if (rangeHuman) enriched.dateText = normSpace(rangeHuman);
    }
  const range = rangeFromStrong || extractCdnRange(textAll) || extractCdnRange(rawHtml) || extractCdnRange(item.dateText);
  const schedule = scheduleFromDetail || extractCdnSchedule(textAll) || extractCdnSchedule(rawHtml);

    // Equipo: solo si falta
    if (team.author && !enriched.author) enriched.author = team.author;
    if (team.director && !enriched.director) enriched.director = team.director;
    if (team.cast?.length && (!enriched.cast || !enriched.cast.length)) enriched.cast = team.cast;
  const teamBlockText = $("div.equipo.box-line .content").text() || textAll;
  const team = parseAuthorDirectorFromText(teamBlockText);

    if (!enriched.endDate && enriched.dateText) {
      const tryEnd = parseSpanishEndDate(enriched.dateText);
      if (tryEnd) enriched.endDate = tryEnd;
    }
  const venueHint = normSpace(`${textAll} ${rawHtml}`);
  const meta = cdnVenueMetaByText(venueHint);

    if (!enriched.credits) {
      const bits = [];
      if (enriched.author) bits.push(enriched.author);
      if (enriched.director && enriched.director !== enriched.author) bits.push(enriched.director);
      enriched.credits = truncateForUI(bits.join(" · "), 160);
    } else {
      enriched.credits = truncateForUI(enriched.credits, 160);
    }
  const enriched = {
    ...item,
    source: item.source || meta.source,
    title: title || item.title,
    venue: item.venue || meta.venue,
    address: item.address || meta.address,
    mapsQuery: item.mapsQuery || meta.mapsQuery,
    mapsUrl: toMapsUrl(item.mapsQuery || meta.mapsQuery),
    author: item.author || team.author,
    director: item.director || team.director,
    image: item.image || $("meta[property='og:image']").attr("content") || $("meta[name='twitter:image']").attr("content") || ""
  };

    return enriched;
  } catch (e) {
    errors.push({
      source: "inaem",
      venue: item.source,
      message: `INAEM enrich failed for ${item.link}: ${String(e?.message || e)}`
    });
    return item;
  if (range) {
    enriched.dateText = mergeCdnDateText(range, schedule, enriched.dateText);
    if (!enriched.startDate) enriched.startDate = parseSpanishStartDate(range);
    if (!enriched.endDate) enriched.endDate = parseSpanishEndDate(range);
  }
}

async function enrichDramaticoEventPage(item, errors) {
  if (!item?.link || !/dramatico\.inaem\.gob\.es\/evento\//.test(item.link)) return item;

  const tryUrls = [item.link, toJinaUrl(item.link)];

  for (let attempt = 0; attempt < tryUrls.length; attempt++) {
    const url = tryUrls[attempt];
    try {
      const html = await fetchText(url, {
        headers: {
          accept: "text/html,*/*;q=0.9",
          referer: "https://dramatico.inaem.gob.es/",
          origin: "https://dramatico.inaem.gob.es"
        }
      });

      if (attempt === 0 && isWafChallengeHtml(html)) {
        errors.push({
          source: "cdn",
          venue: item.source,
          message: `WAF/Challenge también en ficha ${item.link} (directo). Intento fallback r.jina.ai…`
        });
        continue;
      }

      const $ = cheerio.load(html);
      const equipo = parseEquipoBoxFromDramatico($);
      const jsonLd = extractJsonLdObjects(html);
      const ev = pickEventFromJsonLd(jsonLd);

      const enriched = { ...item };

      if (ev?.startDate && !enriched.startDate) enriched.startDate = String(ev.startDate);
      if (ev?.endDate && !enriched.endDate) enriched.endDate = String(ev.endDate);

      if (!enriched.image) {
        const og = extractOgImage($);
        if (og) enriched.image = og;
      }

      if (equipo.author && !enriched.author) enriched.author = equipo.author;
      if (equipo.director && !enriched.director) enriched.director = equipo.director;
      if (equipo.company && !enriched.company) enriched.company = equipo.company;
      if (equipo.choreographer && !enriched.choreographer) enriched.choreographer = equipo.choreographer;
      if (Array.isArray(equipo.cast) && equipo.cast.length && (!Array.isArray(enriched.cast) || !enriched.cast.length)) {
        enriched.cast = equipo.cast;
      }

      // ✅ HORARIO/DÍAS desde panel izquierdo
      const { scheduleText, rangeText } = extractCdnScheduleFromEventLeftPanel($);
      const baseRange = rangeText || enriched.dateText || "";
      const schedule = normSpace(scheduleText);

      if (baseRange && schedule) enriched.dateText = `${baseRange} · ${schedule}`;
      else if (schedule && !enriched.dateText) enriched.dateText = schedule;

      if (!enriched.endDate) {
        const tryEnd = parseSpanishEndDate(enriched.dateText || baseRange);
        if (tryEnd) enriched.endDate = tryEnd;
      }

      if (!enriched.credits) {
        const bits = [];
        if (enriched.author) bits.push(enriched.author);
        if (enriched.director) bits.push(enriched.director);
        enriched.credits = truncateForUI(bits.slice(0, 2).join(" · "), 160);
      } else {
        enriched.credits = truncateForUI(enriched.credits, 160);
      }

      // ✅ BLINDAJE FINAL: si aún faltan datos clave, intenta INAEM Entradas (robusto)
      const needsInaem =
        (!enriched.endDate && !enriched.dateText) ||
        (!enriched.author && !enriched.director);

      if (needsInaem) {
        const fromInaem = await enrichInaemFromEntradas(enriched, errors);
        return fromInaem;
      }

      return enriched;
    } catch (e) {
      if (attempt === tryUrls.length - 1) {
        errors.push({
          source: "cdn",
          venue: item.source,
          message: `CDN enrich failed for ${item.link}: ${String(e?.message || e)}`
        });
      }
    }
  if (!enriched.credits) {
    const bits = [];
    if (enriched.author) bits.push(enriched.author);
    if (enriched.director && enriched.director !== enriched.author) bits.push(enriched.director);
    enriched.credits = truncateForUI(bits.join(" · "), 160);
  }

  // Si no pudimos enrich por CDN/JINA, intenta INAEM igualmente (último recurso)
  return await enrichInaemFromEntradas(item, errors);
  return enriched;
}

async function scrapeCDNProgramacionPage(url, source, errors) {
  const meta = cdnVenueMeta(source);

  const html = await fetchTextCdnSmart(url, errors, source);

  if (isWafChallengeHtml(html)) {
    errors.push({
      source: "cdn",
      venue: source,
      message: `WAF/Challenge persistente en ${url} (directo + jina). Activaré fallback AJAX.`
    });
    return [];
  }

  const $ = cheerio.load(html);
  const out = [];

  const cards = $("div.item.item-event-resume.evento-programacion");
  if (!cards.length) {
    errors.push({ source: "cdn", venue: source, message: `No encontré cards .item-event-resume en ${url}` });
    return out;
  }

  cards.each((_, card) => {
    const $card = $(card);
    const $detail = $card.find(".wrapper-detail .detail").first();

    const $a = $detail.find("h2 a[href*='/evento/']").first();

    const title = normSpace($a.text());
    const href = $a.attr("href") || "";
    const link = href ? (href.startsWith("http") ? href : `https://dramatico.inaem.gob.es${href}`) : "";
    if (!title || !link) return;

    const dateTextBasic = extractDateTextFromCDNCard($detail);
    const endDate = parseSpanishEndDate(dateTextBasic);

    const parsed = parseCdnAuthorDirectorFromDetail($detail);

    const img =
      $card.find(".carousel-inner img").first().attr("src") ||
      $card.find("img").first().attr("src") ||
      "";

    out.push({
      source,
      kind: "theatre",
      title,

      credits: parsed.credits || "",
      deck: "",

      author: parsed.author || "",
      director: parsed.director || "",
      company: "Centro Dramático Nacional",
      choreographer: "",
      cast: [],

      startDate: "",
      endDate,
      dateText: dateTextBasic,

      venue: meta.venue,
      address: meta.address,
      mapsQuery: meta.mapsQuery,
      mapsUrl: toMapsUrl(meta.mapsQuery),
      link,
      image: img
    });
  });

  return dedupeBy(out, (x) => x.link);
}
async function enrichCdnEvent(link, errors) {
  let base = makeBaseItem({ kind: "theatre", link, company: "Centro Dramático Nacional" });

/* ---------- CDN fallback admin-ajax (best-effort) ---------- */
  const directUrl = link;
  const jinaUrl = toJinaUrl(link);

async function cdnWarmup(errors) {
  const base = "https://dramatico.inaem.gob.es/";
  const warmUrls = [base, `${base}programacion/`, `${base}compania/`];
  const tries = [
    { tag: "evento:direct", url: directUrl, accept: "text/html,*/*;q=0.9" },
    { tag: "evento:jina", url: jinaUrl, accept: "text/plain,*/*;q=0.9" }
  ];

  for (const u of warmUrls) {
  for (const t of tries) {
    try {
      await fetchText(
        u,
        {
          headers: {
            accept: "text/html,*/*;q=0.9",
            "cache-control": "no-cache",
            pragma: "no-cache"
          },
          timeoutMs: 25000
        },
        { tries: 2, allowStatuses: [403, 503] }
      );
      await sleep(220);
      const html = await fetchText(t.url, { headers: { accept: t.accept } }, { tries: 2 });
      const $ = cheerio.load(html);
      base = buildCdnItemFromDom(base, $, html);
      if (t.tag === "evento:jina") errors.push({ source: "cdn", venue: base.source || "cdn", message: `evento:jina:ok ${link}` });
      if (base.title && base.endDate && base.dateText) break;
    } catch (e) {
      errors.push({ source: "cdn", venue: "warmup", message: String(e?.message || e) });
      if (t.tag === "evento:jina") errors.push({ source: "cdn", venue: "cdn", message: `evento:jina:fail ${link}` });
    }
  }
}

async function fetchCDNJson(month, year) {
  const url = "https://dramatico.inaem.gob.es/wp-admin/admin-ajax.php";
  const tryActions = ["get-cdn-events", "get_cdn_events"];
  let lastErr = null;

  for (const action of tryActions) {
    const body = new URLSearchParams({
      action,
      mes: String(month),
      year: String(year)
    }).toString();

    try {
      const res = await requestWithRetry(
        url,
        {
          method: "POST",
          headers: {
            accept: "application/json, text/plain, */*",
            "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
            "x-requested-with": "XMLHttpRequest",
            origin: "https://dramatico.inaem.gob.es",
            referer: "https://dramatico.inaem.gob.es/"
          },
          body
        },
        { tries: 3, allowStatuses: [400, 403, 503] }
      );

      const txt = res.text();

      if (looksLikeHtml(txt)) {
        const snip = txt.slice(0, 180).replace(/\s+/g, " ");
        throw new Error(`Expected JSON but got HTML (WAF?). Snippet: ${snip}`);
  if (!base.endDate || !base.dateText || (!base.author && !base.director)) {
    const m = String(link).match(/\/evento\/([^/?#]+)\/?/i);
    if (m) {
      const prensa = `https://dramatico.inaem.gob.es/prensa/${m[1]}/`;
      try {
        const txt = await fetchText(toJinaUrl(prensa), { headers: { accept: "text/plain,*/*;q=0.9" } }, { tries: 2 });
        const $ = cheerio.load(txt);
        base = buildCdnItemFromDom(base, $, txt);
        errors.push({ source: "cdn", venue: base.source || "cdn", message: `prensa:ok ${prensa}` });
      } catch {
        errors.push({ source: "cdn", venue: base.source || "cdn", message: `prensa:fail ${prensa}` });
      }

      if (res.ok) return JSON.parse(txt);
      lastErr = new Error(`HTTP ${res.status} for CDN action=${action}`);
    } catch (e) {
      lastErr = e;
    } else {
      errors.push({ source: "cdn", venue: "cdn", message: "prensa:fail missing-slug" });
    }
  }

  throw lastErr || new Error("CDN JSON fetch failed");
}

function cdnSourceFromText(txt) {
  const t = normSpace(txt).toLowerCase();
  if (!t) return "";
  if (t.includes("maría guerrero") || t.includes("maria guerrero")) return "cdn-maria-guerrero";
  if (t.includes("valle-inclán") || t.includes("valle inclan") || t.includes("valle-inclan")) return "cdn-valle-inclan";
  return "";
  return base;
}

async function scrapeCDNMonthsFallbackAjax(errors) {
  await cdnWarmup(errors);

  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  const months = [
    { m: now.getMonth() + 1, y: now.getFullYear() },
    { m: next.getMonth() + 1, y: next.getFullYear() }
  ];

async function scrapeCDN(errors) {
  const links = await fetchCdnSeedLinks(errors);
  const dedup = [...new Set(links)];
  const out = [];

  for (const { m, y } of months) {
  for (const link of dedup) {
    try {
      const json = await fetchCDNJson(m, y);
      const days = Array.isArray(json?.response) ? json.response : [];

      for (const day of days) {
        const eventos = Array.isArray(day?.eventos) ? day.eventos : [];
        for (const ev of eventos) {
          const title = normSpace(ev?.titulo);
          const link = ev?.url ? String(ev.url) : "";
          if (!title || !link) continue;

          const locTxt = stripHtml(ev?.localizacion || "");
          let src = cdnSourceFromText(locTxt);
          if (!src) continue;

          const meta = cdnVenueMeta(src);

          out.push({
            source: src,
            kind: "theatre",
            title,
            credits: truncateForUI(stripHtml(ev?.subtitulo || ""), 160),
            deck: "",
            author: "",
            director: "",
            company: "",
            choreographer: "",
            cast: [],
            startDate: "",
            endDate: "",
            dateText: "",
            venue: meta.venue,
            address: meta.address,
            mapsQuery: meta.mapsQuery,
            mapsUrl: toMapsUrl(meta.mapsQuery),
            link,
            image: ""
          });
        }
      }
      const it = await enrichCdnEvent(link, errors);
      if (!it.title) continue;
      out.push(it);
    } catch (e) {
      errors.push({ source: "cdn", venue: `ajax:month:${m}/${y}`, message: String(e?.message || e) });
    }
  }

  const base = dedupeBy(out, (x) => x.link);
  const enriched = [];
  const cache = new Map();

  for (const it of base) {
    if (cache.has(it.link)) {
      enriched.push(cache.get(it.link));
      continue;
    }
    const got = await enrichDramaticoEventPage(it, errors);
    cache.set(it.link, got);
    enriched.push(got);
    await sleep(180);
  }

  return enriched.filter((x) => x.source === "cdn-maria-guerrero" || x.source === "cdn-valle-inclan");
}

async function scrapeCDNProgramacion(errors) {
  const mgUrl = "https://dramatico.inaem.gob.es/programacion/teatro-maria-guerrero/";
  const viUrl = "https://dramatico.inaem.gob.es/programacion/teatro-valle-inclan/";

  const mg = await scrapeCDNProgramacionPage(mgUrl, "cdn-maria-guerrero", errors);
  const vi = await scrapeCDNProgramacionPage(viUrl, "cdn-valle-inclan", errors);

  const base = [...mg, ...vi];
  if (!base.length) {
    return await scrapeCDNMonthsFallbackAjax(errors);
  }

  const enriched = [];
  const cache = new Map();

  for (const it of base) {
    if (cache.has(it.link)) {
      enriched.push(cache.get(it.link));
      continue;
      errors.push({ source: "cdn", venue: "cdn", message: `event fail ${link}: ${String(e?.message || e)}` });
    }
    const got = await enrichDramaticoEventPage(it, errors);
    cache.set(it.link, got);
    enriched.push(got);
    await sleep(180);
  }

  return enriched;
}

/* =========================================================
   CANAL — REST tribe events v1 (estable)
   ========================================================= */

function ymd(date) {
  const d = new Date(date);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function safeLower(s) {
  return normSpace(s).toLowerCase();
}

function canalCatSignals(ev) {
  const cats = Array.isArray(ev?.categories) ? ev.categories : [];
  const slugs = cats.map((c) => safeLower(c?.slug)).filter(Boolean);
  const names = cats.map((c) => safeLower(c?.name)).filter(Boolean);
  return { slugs, names };
}

function isCanalDance(ev) {
  const { slugs, names } = canalCatSignals(ev);
  return slugs.some((s) => s.includes("danza")) || names.some((n) => n.includes("danza"));
}

function isCanalTheatre(ev) {
  const { slugs, names } = canalCatSignals(ev);

  const theatreSlug = slugs.some((s) => s.includes("teatro") || s.includes("en-cartel") || s.includes("en-cartelera"));
  const theatreName = names.some((n) => n.includes("teatro") || n.includes("en cartel"));
  if (theatreSlug || theatreName) return true;

  const title = safeLower(ev?.title);
  const bad = ["taller", "curso", "masterclass", "seminario", "visita guiada", "formacion", "formación"];
  if (bad.some((k) => title.includes(k))) return false;

  return true;
}

function pickBestImageFromCanal(ev) {
  const img = ev?.image;
  if (!img) return "";
  if (typeof img === "string") return img;
  if (img?.url) return String(img.url);
  return "";
}
  const now = Date.now();
  const filtered = out.filter((x) => {
    if (!x.endDate) return false;
    return isoToMs(x.endDate) >= now - 24 * 60 * 60 * 1000;
  });

function canalDates(ev) {
  const start = ev?.start_date_utc || ev?.start_date || "";
  const end = ev?.end_date_utc || ev?.end_date || "";
  return { startDate: String(start || ""), endDate: String(end || "") };
  errors.push({ source: "cdn", venue: "pipeline", message: `cdn: collected ${out.length}, kept ${filtered.length}` });
  return dedupeBy(filtered, (x) => x.link);
}

function weekdayEsShort(d) {
  const w = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
  return w[d.getDay()];
}
function monthEsShort(d) {
  const m = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
  return m[d.getMonth()];
function fmtDateShortES(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const day = d.getDate();
  const mon = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"][d.getMonth()];
  return `${day} ${mon}`;
}
function pad2(n) { return String(n).padStart(2, "0"); }

function fmtTimeFromIso(iso) {
  if (!iso) return "";
function fmtTime(iso) {
  const d = new Date(iso);
  const hh = pad2(d.getHours());
  const mm = pad2(d.getMinutes());
  if (!Number.isFinite(d.getTime())) return "";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (hh === "00" && mm === "00") return "";
  return `${hh}:${mm}`;
}

function canalDateText(ev) {
  const start = ev?.start_date_utc || ev?.start_date || "";
  const end = ev?.end_date_utc || ev?.end_date || "";
  if (!start) return "";

  const ds = new Date(start);
  const de = end ? new Date(end) : null;

  const time = fmtTimeFromIso(start);

  if (!de || ds.toDateString() === de.toDateString()) {
    const day = `${weekdayEsShort(ds)} ${pad2(ds.getDate())} ${monthEsShort(ds)}`;
    return time ? `${day} · ${time}` : day;
  }

  const a = `${pad2(ds.getDate())} ${monthEsShort(ds)}`;
  const b = `${pad2(de.getDate())} ${monthEsShort(de)}`;
  const w1 = weekdayEsShort(ds);
  const w2 = weekdayEsShort(de);
  const wRange = (w1 && w2) ? `${w1}–${w2}` : "";

  const left = `Del ${a} al ${b}`;
  const mid = wRange ? ` · ${wRange}` : "";
  const right = time ? ` · ${time}` : "";

  return `${left}${mid}${right}`;
}

async function fetchCanalEventsPage({ perPage, page, startDate, endDate }, errors) {
  const url = new URL("https://www.teatroscanal.com/wp-json/tribe/events/v1/events");
  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set("page", String(page));
  url.searchParams.set("start_date", startDate);
  url.searchParams.set("end_date", endDate);
async function scrapeCanal(errors) {
  const url = "https://www.teatroscanal.com/wp-json/tribe/events/v1/events";
  const outTheatre = [];
  const outDance = [];

  try {
    const res = await requestWithRetry(url.toString(), {}, { tries: 3, allowStatuses: [404] });
    if (res.status === 404) return { _end: true, events: [] };

    const txt = res.text();
    if (looksLikeHtml(txt)) throw new Error("Expected JSON but got HTML");
    return JSON.parse(txt);
  } catch (e) {
    errors.push({ source: "canal", venue: `rest:page:${page}`, message: String(e?.message || e) });
    return null;
  }
}

async function scrapeCanalREST(errors) {
  const now = new Date();
  const from = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
  const to = new Date(now.getTime() + 120 * 24 * 60 * 60 * 1000);

  const startDate = ymd(from);
  const endDate = ymd(to);

  const perPage = 50;
  const maxPages = 8;

  const theatre = [];
  const dance = [];

  for (let page = 1; page <= maxPages; page++) {
    const data = await fetchCanalEventsPage({ perPage, page, startDate, endDate }, errors);
    if (!data) break;
    if (data._end) break;

    const events = Array.isArray(data?.events) ? data.events : [];
    if (!events.length) break;
    const txt = await fetchText(url, { headers: { accept: "application/json,*/*;q=0.9" } }, { tries: 2 });
    const json = JSON.parse(txt);
    const events = Array.isArray(json?.events) ? json.events : [];

    for (const ev of events) {
      const title = normSpace(ev?.title);
      const link = ev?.url ? String(ev.url) : "";
      const link = ev?.url || ev?.website || "";
      if (!title || !link) continue;

      const { startDate: s, endDate: e } = canalDates(ev);
      const image = pickBestImageFromCanal(ev);
      const start = ev?.start_date || ev?.start_date_utc || "";
      const end = ev?.end_date || ev?.end_date_utc || "";
      const catStr = JSON.stringify(ev?.categories || []).toLowerCase();
      const isDance = /danza/.test(catStr);
      const isTheatre = /teatro|en-cartel|en cartel|cartelera/.test(catStr) || !isDance;
      const kind = isDance ? "dance" : (isTheatre ? "theatre" : "theatre");

      const baseItem = {
      const time = fmtTime(start);
      const dateText = `${fmtDateShortES(start)} – ${fmtDateShortES(end)}${time ? ` · ${time}` : ""}`;

      const item = makeBaseItem({
        source: "canal",
        kind,
        title,
        credits: "",
        deck: "",
        author: "",
        director: "",
        company: "",
        choreographer: "",
        cast: [],
        startDate: s,
        endDate: e,
        dateText: canalDateText(ev),
        startDate: start ? new Date(start).toISOString() : "",
        endDate: end ? new Date(end).toISOString() : "",
        dateText,
        venue: "Teatros del Canal",
        address: "C. de Cea Bermúdez, 1, Madrid",
        mapsQuery: "Teatros del Canal, Madrid",
        mapsUrl: toMapsUrl("Teatros del Canal, Madrid"),
        link,
        image
      };
        image: ev?.image?.url || ev?.image?.sizes?.medium?.url || ""
      });

      if (isCanalDance(ev)) dance.push({ ...baseItem, kind: "dance" });
      else if (isCanalTheatre(ev)) theatre.push({ ...baseItem, kind: "theatre" });
      if (item.kind === "dance") outDance.push(item);
      else outTheatre.push(item);
    }

    if (theatre.length >= 60 && dance.length >= 20) break;
    await sleep(140);
  } catch (e) {
    errors.push({ source: "canal", venue: "canal", message: String(e?.message || e) });
  }

  return {
    theatre: dedupeBy(theatre, (x) => x.link),
    dance: dedupeBy(dance, (x) => x.link)
  };
  return { theatre: dedupeBy(outTheatre, (x) => x.link), dance: dedupeBy(outDance, (x) => x.link) };
}

/* =========================================================
   Nave 10 (JSON-LD por evento)
   ========================================================= */
async function scrapeTeatroEspanol(errors) {
  const out = [];
  const url = "https://www.teatroespanol.es";

async function scrapeNave10Theatre(errors) {
  const listUrl = "https://www.nave10matadero.es/programacion?field_category%5B14%5D=14";
  const html = await fetchText(listUrl);
  const $ = cheerio.load(html);
  try {
    const home = await fetchText(url, { headers: { accept: "text/html,*/*;q=0.9" } }, { tries: 2 });
    const $ = cheerio.load(home);
    const links = new Set();
    $("a[href]").each((_, a) => {
      const href = $(a).attr("href") || "";
      if (/^\/(?!wp-json)(?!sites\/default)/.test(href) && /\w/.test(href)) links.add(`https://www.teatroespanol.es${href}`);
    });

  const links = $("a")
    .map((_, a) => $(a).attr("href"))
    .get()
    .filter(Boolean)
    .map((href) => (href.startsWith("http") ? href : `https://www.nave10matadero.es${href}`))
    .filter((href) => /\/actividades\//.test(href));
    for (const link of [...links].slice(0, 20)) {
      try {
        const h = await fetchText(link, { headers: { accept: "text/html,*/*;q=0.9" } }, { tries: 1 });
        const $$ = cheerio.load(h);
        const title = normSpace($$("h1").first().text());
        if (!title) continue;
        const dateText = normSpace($$(".date-range, .field--name-field-fechas").first().text());
        const endDate = parseSpanishEndDate(dateText);
        if (!endDate) continue;
        out.push(makeBaseItem({
          source: "teatroespanol",
          kind: "theatre",
          title,
          endDate,
          dateText: dateText || "",
          venue: "Teatro Español",
          address: "Pl. de Santa Ana, 4, Madrid",
          mapsQuery: "Teatro Español, Pl. de Santa Ana, 4, Madrid",
          mapsUrl: toMapsUrl("Teatro Español, Pl. de Santa Ana, 4, Madrid"),
          link,
          image: $$("meta[property='og:image']").attr("content") || ""
        }));
      } catch {}
    }
  } catch (e) {
    errors.push({ source: "teatroespanol", venue: "teatroespanol", message: String(e?.message || e) });
  }

  const uniqueLinks = [...new Set(links)].slice(0, 18);
  return dedupeBy(out, (x) => x.link);
}

async function scrapeNave10(errors) {
  const out = [];
  for (const url of uniqueLinks) {
    try {
      const page = await fetchText(url);
      const jsonLd = extractJsonLdObjects(page);
      const ev = pickEventFromJsonLd(jsonLd);
      if (!ev?.name) continue;

      const desc = stripHtml(ev.description || "");
      out.push({
        source: "nave10",
        kind: "theatre",
        title: normSpace(ev.name),

        credits: "",
        deck: pickFirstSentence(desc, 210),

        author: "",
        director: "",
        company: "",
        choreographer: "",
        cast: [],

        startDate: ev.startDate || "",
        endDate: ev.endDate || "",
        dateText: "",

        venue: "Nave 10 Matadero",
        address: "Plaza de Legazpi, 8, Madrid",
        mapsQuery: "Nave 10 Matadero, Plaza de Legazpi 8, Madrid",
        mapsUrl: toMapsUrl("Nave 10 Matadero, Plaza de Legazpi 8, Madrid"),
        link: ev.url || url,
        image: (typeof ev.image === "string" ? ev.image : ev.image?.url) || ""
      });
  const base = "https://www.nave10matadero.es/actividades";

      await sleep(120);
    } catch (e) {
      errors.push({ source: "nave10", venue: "activity", message: String(e?.message || e) });
  try {
    const html = await fetchText(base, { headers: { accept: "text/html,*/*;q=0.9" } }, { tries: 2 });
    const $ = cheerio.load(html);
    const links = new Set();
    $("a[href*='/actividades/']").each((_, a) => {
      const href = $(a).attr("href") || "";
      const abs = href.startsWith("http") ? href : `https://www.nave10matadero.es${href}`;
      if (/\/actividades\//.test(abs)) links.add(abs);
    });

    for (const link of [...links].slice(0, 24)) {
      try {
        const h = await fetchText(link, { headers: { accept: "text/html,*/*;q=0.9" } }, { tries: 1 });
        const $$ = cheerio.load(h);
        const title = normSpace($$("h1").first().text()) || normSpace($$("meta[property='og:title']").attr("content"));
        if (!title) continue;
        const scripts = $$("script[type='application/ld+json']").toArray().map((el) => $$(el).html() || "");
        let startDate = "";
        let endDate = "";
        for (const raw of scripts) {
          try {
            const obj = JSON.parse(raw);
            const arr = Array.isArray(obj) ? obj : [obj];
            for (const x of arr) {
              if (x?.startDate && !startDate) startDate = new Date(x.startDate).toISOString();
              if (x?.endDate && !endDate) endDate = new Date(x.endDate).toISOString();
            }
          } catch {}
        }
        if (!endDate) continue;

        out.push(makeBaseItem({
          source: "nave10",
          kind: "theatre",
          title,
          startDate,
          endDate,
          dateText: "",
          deck: truncateForUI(normSpace($$("meta[name='description']").attr("content") || ""), 200),
          venue: "Nave 10 Matadero",
          address: "Plaza de Legazpi, 8, Madrid",
          mapsQuery: "Nave 10 Matadero, Plaza de Legazpi 8, Madrid",
          mapsUrl: toMapsUrl("Nave 10 Matadero, Plaza de Legazpi 8, Madrid"),
          link,
          image: $$("meta[property='og:image']").attr("content") || ""
        }));
      } catch {}
    }
  } catch (e) {
    errors.push({ source: "nave10", venue: "nave10", message: String(e?.message || e) });
  }
  return out;
}

async function scrapeMataderoTheatreDisabled() {
  return [];
  return dedupeBy(out, (x) => x.link);
}

/* =========================================================
   Teatro Pradillo (Divi)
   ========================================================= */

async function scrapePradillo(errors) {
  const url = "https://www.teatropradillo.com/";
  const html = await fetchText(url);
  const $ = cheerio.load(html);

  const items = $("article.et_pb_post[id^='post-']")
    .map((_, el) => {
      const $a = $(el).find("h2.entry-title a").first();
      const title = normSpace($a.text());
      const link = $a.attr("href") ? String($a.attr("href")) : "";
      if (!title || !link) return null;

      const dateText = normSpace($(el).find(".post-content-inner p").first().text());
  const out = [];
  const url = "https://www.teatropradillo.com";
  try {
    const html = await fetchText(url, { headers: { accept: "text/html,*/*;q=0.9" } }, { tries: 2 });
    const $ = cheerio.load(html);
    $("article.et_pb_post").each((_, el) => {
      const title = normSpace($(el).find("h2 a").first().text());
      const href = $(el).find("h2 a").first().attr("href") || "";
      if (!title || !href) return;
      const dateText = normSpace($(el).find(".post-meta, .entry-content").text());
      const endDate = parseSpanishEndDate(dateText);

      const img = $(el).find(".et_pb_image_container img").first().attr("src") || "";

      return {
      if (!endDate) return;
      out.push(makeBaseItem({
        source: "pradillo",
        kind: "theatre",
        title,

        credits: "",
        deck: "",

        author: "",
        director: "",
        company: "",
        choreographer: "",
        cast: [],

        startDate: "",
        endDate,
        dateText,

        venue: "Teatro Pradillo",
        address: "C. de Pradillo, 12, Madrid",
        mapsQuery: "Teatro Pradillo, Madrid",
        mapsUrl: toMapsUrl("Teatro Pradillo, Madrid"),
        link,
        image: img
      };
    })
    .get()
    .filter(Boolean);

  return dedupeBy(items, (x) => x.link);
        link: href.startsWith("http") ? href : `${url}${href}`
      }));
    });
  } catch (e) {
    errors.push({ source: "pradillo", venue: "pradillo", message: String(e?.message || e) });
  }
  return dedupeBy(out, (x) => x.link);
}

/* =========================================================
   Teatro del Barrio (Elementor) — FIX ROBUSTO
   ========================================================= */

async function scrapeTeatroDelBarrio(errors) {
  const url = "https://teatrodelbarrio.com/";
  const html = await fetchText(url);
  const $ = cheerio.load(html);

  const items = $("div.article[id^='post-']")
    .map((_, el) => {
      const $a = $(el).find("h2.title a").first();
      const title = normSpace($a.text() || $(el).find("h2.title").first().text());
      const link = $a.attr("href") ? String($a.attr("href")) : "";
      if (!title || !link) return null;

      const dateText =
        normSpace($(el).find("div.text-container > div").first().text()) ||
        normSpace($(el).find(".grid-content div").first().text());

  const out = [];
  const url = "https://teatrodelbarrio.com";
  try {
    const html = await fetchText(url, { headers: { accept: "text/html,*/*;q=0.9" } }, { tries: 2 });
    const $ = cheerio.load(html);
    $("div.article[id^='post-']").each((_, el) => {
      const a = $(el).find("h2.title a").first();
      const title = normSpace(a.text());
      const href = a.attr("href") || "";
      if (!title || !href) return;
      const dateText = normSpace($(el).text());
      const endDate = parseSpanishEndDate(dateText);
      if (!endDate) return;

      const style = $(el).find("div.image-wrap").first().attr("style") || "";
      const m = style.match(/background-image:\s*url\(["']?([^"')]+)["']?\)/i);
      const image = m ? m[1] : "";

      return {
      out.push(makeBaseItem({
        source: "teatrodelbarrio",
        kind: "theatre",
        title,

        credits: "",
        deck: "",

        author: "",
        director: "",
        company: "",
        choreographer: "",
        cast: [],

        startDate: "",
        endDate,
        dateText,

        venue: "Teatro del Barrio",
        address: "C. de Zurita, 20, Madrid",
        address: "C/ de Zurita, 20, Madrid",
        mapsQuery: "Teatro del Barrio, Madrid",
        mapsUrl: toMapsUrl("Teatro del Barrio, Madrid"),
        link,
        image
      };
    })
    .get()
    .filter(Boolean);

  return dedupeBy(items, (x) => x.link);
}

/* =========================================================
   Teatro Español — Drupal Views AJAX (blindado)
   ========================================================= */

function extractDrupalSettingsJson(html) {
  const $ = cheerio.load(html);
  const raw = $('script[type="application/json"][data-drupal-selector="drupal-settings-json"]').first().html();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function extractAjaxPageState(html) {
  const mTheme = html.match(/"theme"\s*:\s*"([^"]+)"/);
  const mLibs = html.match(/"libraries"\s*:\s*"([^"]+)"/);
  return { theme: mTheme ? mTheme[1] : "", libraries: mLibs ? mLibs[1] : "" };
}

async function fetchTeatroEspanolViewsPage(page, errors) {
  const base = "https://www.teatroespanol.es";
  const programUrl = `${base}/programacion`;
  const html = await fetchText(programUrl, { headers: { accept: "text/html,*/*;q=0.9" } });

  const settings = extractDrupalSettingsJson(html);
  let theme = "";
  let libraries = "";

  if (settings?.ajaxPageState) {
    theme = settings.ajaxPageState.theme || "";
    libraries = settings.ajaxPageState.libraries || "";
  } else {
    const ap = extractAjaxPageState(html);
    theme = ap.theme;
    libraries = ap.libraries;
  }

  if (!theme || !libraries) {
    errors.push({ source: "teatroespanol", venue: "ajax", message: "No pude extraer ajax_page_state (theme/libraries)." });
    return null;
  }

  const endpoint = `${base}/views/ajax?_wrapper_format=drupal_ajax`;

  const form = new URLSearchParams();
  form.set("view_name", "schedule");
  form.set("view_display_id", "schedule");
  form.set("view_args", "");
  form.set("view_path", "/programacion");
  form.set("view_base_path", "programacion");
  form.set("pager_element", "0");
  form.set("page", String(page));
  form.set("ajax_page_state[theme]", theme);
  form.set("ajax_page_state[libraries]", libraries);

  try {
    const res = await requestWithRetry(
      endpoint,
      {
        method: "POST",
        headers: {
          accept: "application/json, text/plain, */*",
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
          "x-requested-with": "XMLHttpRequest",
          origin: base,
          referer: programUrl
        },
        body: form.toString()
      },
      { tries: 3 }
    );

    const txt = res.text();

    if (looksLikeHtml(txt)) throw new Error("Expected JSON but got HTML");
    return JSON.parse(txt);
  } catch (e) {
    errors.push({ source: "teatroespanol", venue: `ajax:page:${page}`, message: String(e?.message || e) });
    return null;
  }
}

function extractInsertedHtmlFromDrupalAjax(payload) {
  if (!Array.isArray(payload)) return "";
  for (const cmd of payload) {
    if (cmd && typeof cmd === "object" && cmd.command === "insert" && typeof cmd.data === "string") {
      if (cmd.data.includes("views-row")) return cmd.data;
    }
  }
  return payload.map((x) => (x && typeof x.data === "string" ? x.data : "")).join("\n");
}

async function scrapeTeatroEspanolAJAX(errors) {
  const base = "https://www.teatroespanol.es";
  const out = [];
  const maxPages = 4;

  for (let page = 0; page < maxPages; page++) {
    const payload = await fetchTeatroEspanolViewsPage(page, errors);
    if (!payload) break;

    const html = extractInsertedHtmlFromDrupalAjax(payload);
    if (!html || !html.includes("views-row")) break;

    const $ = cheerio.load(html);
    const rows = $("div.views-row");
    if (!rows.length) break;

    rows.each((_, el) => {
      const $row = $(el);

      const $titleA = $row.find(".show-content .title a, .field--name-node-title a").first();
      const title = normSpace($titleA.text());
      const href = $titleA.attr("href") || "";
      const link = href ? (href.startsWith("http") ? href : `${base}${href}`) : "";
      if (!title || !link) return;

      const subtitle =
        normSpace($row.find(".field--name-field-secondary-subtitle").first().text()) ||
        normSpace($row.find(".subtitle").first().text());

      const dateText = normSpace($row.find(".date-range").first().text());
      const endDate = parseSpanishEndDate(dateText);

      const img = $row.find(".show-image img, picture img").first().attr("src") || "";
      const image = img ? (img.startsWith("http") ? img : `${base}${img}`) : "";

      const venue = "Teatro Español";
      const address = "Pl. de Santa Ana, 4, Madrid";

      out.push({
        source: "teatroespanol",
        kind: "theatre",
        title,

        credits: truncateForUI(subtitle || "", 160),
        deck: "",

        author: "",
        director: "",
        company: "",
        choreographer: "",
        cast: [],

        startDate: "",
        endDate,
        dateText,

        venue,
        address,
        mapsQuery: `${venue}, ${address}`,
        mapsUrl: toMapsUrl(`${venue}, ${address}`),
        link,
        image
      });
        link: href.startsWith("http") ? href : `${url}${href}`
      }));
    });

    await sleep(120);
  } catch (e) {
    errors.push({ source: "teatrodelbarrio", venue: "teatrodelbarrio", message: String(e?.message || e) });
  }

  return dedupeBy(out, (x) => x.link);
}

/* =========================================================
   MAIN
   ========================================================= */
function filterActive(items) {
  const now = Date.now();
  return items.filter((it) => {
    const end = isoToMs(it.endDate);
    if (end !== Infinity) return end >= now - 24 * 60 * 60 * 1000;
    const start = isoToMs(it.startDate);
    if (start !== Infinity) return start >= now - 7 * 24 * 60 * 60 * 1000;
    return false;
  });
}

async function main() {
  const errors = [];

  const theatre = [];
  const dance = [];

  // 1) CDN (Valle + María) Programación + enrich; fallback (jina -> ajax) + INAEM (si hace falta)
  theatre.push(...(await scrapeCDNProgramacion(errors)));

  // 2) CANAL REST (teatro + danza) + dateText editorial
  const canal = await scrapeCanalREST(errors);
  theatre.push(...canal.theatre);
  dance.push(...canal.dance);

  // 3) Nave10 + Matadero desactivado
  theatre.push(...(await scrapeNave10Theatre(errors)));
  theatre.push(...(await scrapeMataderoTheatreDisabled()));
  const [cdn, canal, espanol, nave10, pradillo, barrio] = await Promise.all([
    scrapeCDN(errors),
    scrapeCanal(errors),
    scrapeTeatroEspanol(errors),
    scrapeNave10(errors),
    scrapePradillo(errors),
    scrapeTeatroDelBarrio(errors)
  ]);

  // 4) Español AJAX, Pradillo, Barrio
  theatre.push(...(await scrapeTeatroEspanolAJAX(errors)));
  theatre.push(...(await scrapePradillo(errors)));
  theatre.push(...(await scrapeTeatroDelBarrio(errors)));
  const theatreRaw = dedupeBy([
    ...cdn,
    ...canal.theatre,
    ...espanol,
    ...nave10,
    ...pradillo,
    ...barrio
  ], (x) => x.link);

  const theatreUnique = dedupeBy(theatre, (x) => x.link || `${x.source}:${x.title}`);
  const danceUnique = dedupeBy(dance, (x) => x.link || `${x.source}:${x.title}`);
  const danceRaw = dedupeBy([...canal.dance], (x) => x.link);

  const nowMs = Date.now();
  const theatreActive = theatreUnique.filter((it) => !isExpired(it, nowMs));
  const danceActive = danceUnique.filter((it) => !isExpired(it, nowMs));
  const theatreActive = filterActive(theatreRaw);
  const danceActive = filterActive(danceRaw);

  const theatrePicked = pickWithCaps(theatreActive, LIMITS.theatreMax, CAPS_THEATRE);
  const dancePicked = pickWithCaps(danceActive, LIMITS.danceMax, CAPS_DANCE);
  const theatreFinal = pickWithCaps(theatreActive, LIMITS.theatreMax, CAPS_THEATRE).map(sanitizeForOutput);
  const danceFinal = pickWithCaps(danceActive, LIMITS.danceMax, CAPS_DANCE).map(sanitizeForOutput);

  const theatreFinal = theatrePicked.map(sanitizeForOutput);
  const danceFinal = dancePicked.map(sanitizeForOutput);
  const mixTheatre = theatreFinal.reduce((acc, it) => ((acc[it.source] = (acc[it.source] || 0) + 1), acc), {});
  const mixDance = danceFinal.reduce((acc, it) => ((acc[it.source] = (acc[it.source] || 0) + 1), acc), {});

  const out = {
    updatedAt: new Date().toISOString(),
    theatre: theatreFinal,
    dance: danceFinal,
    meta: {
      limits: LIMITS,
      caps: { theatre: CAPS_THEATRE, dance: CAPS_DANCE },
      sources: {
        theatre: [...new Set(theatreFinal.map((x) => x.source))],
        dance: [...new Set(danceFinal.map((x) => x.source))]
      },
      counts: {
        theatreCollected: theatre.length,
        danceCollected: dance.length,
        theatreUnique: theatreUnique.length,
        danceUnique: danceUnique.length,
        theatreCollected: theatreRaw.length,
        danceCollected: danceRaw.length,
        theatreActive: theatreActive.length,
        danceActive: danceActive.length,
        theatreFinal: theatreFinal.length,
        danceFinal: danceFinal.length
      },
      mix: {
        theatre: tallyBySource(theatreFinal),
        dance: tallyBySource(danceFinal)
      },
      mix: { theatre: mixTheatre, dance: mixDance },
      errors
    }
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + "\n", "utf-8");

  console.log(`OK: wrote ${OUT_PATH}`);
  console.log(`Mix theatre:`, out.meta.mix.theatre);
  console.log(`Mix dance:`, out.meta.mix.dance);
  if (errors.length) console.warn(`WARN: ${errors.length} source errors (see meta.errors).`);
  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fs.writeFile(OUT_PATH, JSON.stringify(out, null, 2), "utf8");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
main().catch(async (err) => {
  const fallback = {
    updatedAt: new Date().toISOString(),
    theatre: [],
    dance: [],
    meta: {
      counts: { theatreCollected: 0, danceCollected: 0, theatreActive: 0, danceActive: 0, theatreFinal: 0, danceFinal: 0 },
      mix: { theatre: {}, dance: {} },
      errors: [{ source: "main", venue: "main", message: String(err?.stack || err?.message || err) }]
    }
  };
  try {
    await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
    await fs.writeFile(OUT_PATH, JSON.stringify(fallback, null, 2), "utf8");
  } catch {}
  process.exitCode = 1;
});
