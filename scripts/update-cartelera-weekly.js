#!/usr/bin/env node
/**
 * Update Cartelera (Weekly) — COOLtura ✅ BLINDADO (CDN PROGRAMACIÓN + fallback JINA + FICHA HORARIOS + CANAL REST + ESPAÑOL AJAX + PRADILLO + BARRIO + NAVE10)
 * - Genera /data/cartelera-weekly.json
 * - Agenda plural y curada (cupo por fuente)
 * - Teatro: 10 items (caps estrictos por fuente)
 * - Danza: 2 items (Canal)
 * - ❌ Circo NO entra aquí (va en Con niños)
 * - Sin venta de entradas en salida (UI decide links; aquí solo guardamos link)
 * - Pin Google Maps siempre (search api=1)
 * - Rotación por endDate + filtro vencidos
 *
 * Requiere: npm i cheerio@1
 */

import fs from "node:fs/promises";
import path from "node:path";
import https from "node:https";
import zlib from "node:zlib";
import { URL } from "node:url";
import * as cheerio from "cheerio";

const OUT_PATH = path.join(process.cwd(), "data", "cartelera-weekly.json");

const LIMITS = { theatreMax: 10, danceMax: 2 };

// Caps editoriales (estrictos)
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
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";

const MONTHS = {
  enero: 0,
  febrero: 1,
  marzo: 2,
  abril: 3,
  mayo: 4,
  junio: 5,
  julio: 6,
  agosto: 7,
  septiembre: 8,
  setiembre: 8,
  octubre: 9,
  noviembre: 10,
  diciembre: 11,
  ene: 0,
  feb: 1,
  mar: 2,
  abr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  ago: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dic: 11
};

function normSpace(v) {
  return String(v || "").replace(/\s+/g, " ").trim();
}

function stripHtml(html) {
  return normSpace(String(html || "").replace(/<[^>]+>/g, " "));
}

function normMonthKey(v) {
  return String(v || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function toMapsUrl(query) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query || "")}`;
}

function toJinaUrl(url) {
  const u = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  return `https://r.jina.ai/${u}`;
}

function truncateForUI(v, max) {
  const s = normSpace(v);
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

function isoToMs(iso) {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? t : Infinity;
}

function parseSpanishStartDate(dateText) {
  const s = normSpace(dateText).toLowerCase();
  if (!s) return "";

  // 13 feb 2026 - 5 abr 2026
  let m = s.match(
    /\b(\d{1,2})\s+([a-záéíóúñ]+)\s+(\d{4})\s*[-–]\s*(\d{1,2})\s+([a-záéíóúñ]+)\s+(\d{4})\b/i
  );
  if (m) {
    const d1 = Number(m[1]);
    const mon = MONTHS[normMonthKey(m[2])];
    const y = Number(m[3]);
    if (Number.isFinite(mon)) return new Date(y, mon, d1, 0, 0, 0).toISOString();
  }

  // 13 feb – 5 abr 2026  (año opcional)
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

  // 13 febrero 5 abril 2026 (raro)
  m = s.match(/\b(\d{1,2})\s*([a-záéíóúñ]+)\s*(\d{1,2})\s*([a-záéíóúñ]+)\s*(\d{4})\b/i);
  if (m) {
    const d1 = Number(m[1]);
    const mon = MONTHS[normMonthKey(m[2])];
    const y = Number(m[5]);
    if (Number.isFinite(mon)) return new Date(y, mon, d1, 0, 0, 0).toISOString();
  }

  // del 13 al 15 de febrero de 2026
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
  const s = normSpace(dateText).toLowerCase();
  if (!s) return "";

  // 13 feb 2026 - 5 abr 2026
  let m = s.match(
    /\b(\d{1,2})\s+([a-záéíóúñ]+)\s+(\d{4})\s*[-–]\s*(\d{1,2})\s+([a-záéíóúñ]+)\s+(\d{4})\b/i
  );
  if (m) {
    const d2 = Number(m[4]);
    const mon = MONTHS[normMonthKey(m[5])];
    const y = Number(m[6]);
    if (Number.isFinite(mon)) return new Date(y, mon, d2, 23, 59, 59).toISOString();
  }

  // 13 feb – 5 abr 2026  (año opcional)
  m = s.match(/\b(\d{1,2})\s*([a-záéíóúñ]{3,})\s*[-–]\s*(\d{1,2})\s*([a-záéíóúñ]{3,})(?:\s*(\d{4}))?/i);
  if (m) {
    const d2 = Number(m[3]);
    const mon1 = MONTHS[normMonthKey(m[2])];
    const mon2 = MONTHS[normMonthKey(m[4])];
    const yHint = m[5] ? Number(m[5]) : new Date().getFullYear();
    let y2 = yHint;
    if (Number.isFinite(mon1) && Number.isFinite(mon2) && mon1 > mon2) y2 = yHint + 1;
    if (Number.isFinite(mon2)) return new Date(y2, mon2, d2, 23, 59, 59).toISOString();
  }

  // 13 febrero 5 abril 2026 (raro)
  m = s.match(/\b(\d{1,2})\s*([a-záéíóúñ]+)\s*(\d{1,2})\s*([a-záéíóúñ]+)\s*(\d{4})\b/i);
  if (m) {
    const d2 = Number(m[3]);
    const mon = MONTHS[normMonthKey(m[4])];
    const y = Number(m[5]);
    if (Number.isFinite(mon)) return new Date(y, mon, d2, 23, 59, 59).toISOString();
  }

  // del 13 al 15 de febrero de 2026
  m = s.match(/\bdel\s+(\d{1,2})\s+al\s+(\d{1,2})\s+de\s+([a-záéíóúñ]+)\s+de\s+(\d{4})\b/i);
  if (m) {
    const d2 = Number(m[2]);
    const mon = MONTHS[normMonthKey(m[3])];
    const y = Number(m[4]);
    if (Number.isFinite(mon)) return new Date(y, mon, d2, 23, 59, 59).toISOString();
  }

  return "";
}

function parseJsonSafe(s, fallback = null) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

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
    return isoToMs(a.startDate) - isoToMs(b.startDate);
  });
}

/**
 * Caps estrictos (NO rellena rompiendo caps).
 * Si faltan fuentes, devuelve menos items.
 */
function pickWithCapsStrict(items, max, caps) {
  const sorted = sortByEndThenStart(items);
  const picked = [];
  const count = new Map();

  for (const it of sorted) {
    if (picked.length >= max) break;
    const src = it.source || "other";
    if (!(src in caps)) continue;
    const cap = caps[src];
    if (cap === 0) continue;
    const n = count.get(src) || 0;
    if (n >= cap) continue;
    if (picked.some((p) => p.link === it.link)) continue;
    picked.push(it);
    count.set(src, n + 1);
  }
  return picked;
}

function sanitizeForOutput(it) {
  return {
    source: it.source || "",
    kind: it.kind || "theatre",
    title: it.title || "",
    credits: truncateForUI(it.credits || "", 160),
    deck: truncateForUI(it.deck || "", 200),
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
    mapsUrl: toMapsUrl(it.mapsQuery || ""),
    link: it.link || "",
    image: it.image || ""
  };
}

function isExpired(item, nowMs) {
  const end = isoToMs(item.endDate);
  if (end !== Infinity) return end < nowMs - 24 * 60 * 60 * 1000;
  return true;
}

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

async function requestRaw(urlStr, opts = {}) {
  return await new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
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
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks)
          })
        );
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`timeout ${urlStr}`)));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function decodeBody(body, headers) {
  const enc = String(headers?.["content-encoding"] || "").toLowerCase();
  try {
    if (enc.includes("br")) return zlib.brotliDecompressSync(body);
    if (enc.includes("gzip")) return zlib.gunzipSync(body);
    if (enc.includes("deflate")) return zlib.inflateSync(body);
  } catch {
    return body;
  }
  return body;
}

async function requestWithRetry(url, opts = {}, control = {}) {
  const tries = control.tries || 3;
  const allowStatuses = control.allowStatuses || [];
  let current = url;
  let lastError;

  for (let i = 0; i < tries; i++) {
    try {
      const res = await requestRaw(current, opts);
      if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.location) {
        current = new URL(res.headers.location, current).toString();
        continue;
      }
      if ((res.status >= 200 && res.status < 300) || allowStatuses.includes(res.status)) return res;
      lastError = new Error(`HTTP ${res.status} for ${current}`);
    } catch (e) {
      lastError = e;
    }
    await new Promise((r) => setTimeout(r, (i + 1) * 400));
  }

  throw lastError || new Error(`request failed ${url}`);
}

async function fetchText(url, opts = {}, control = {}) {
  const res = await requestWithRetry(url, opts, control);
  const out = decodeBody(res.body, res.headers);
  return Buffer.from(out).toString("utf8");
}

function sourceMeta(source) {
  if (source === "cdn-maria-guerrero") {
    return {
      venue: "Teatro María Guerrero",
      address: "C. de Tamayo y Baus, 4, Madrid",
      mapsQuery: "Teatro María Guerrero, Madrid"
    };
  }
  if (source === "cdn-valle-inclan") {
    return {
      venue: "Teatro Valle-Inclán",
      address: "C. de Plazuela de Ana Diosdado, 1, Madrid",
      mapsQuery: "Teatro Valle-Inclán, Madrid"
    };
  }
  return { venue: "", address: "", mapsQuery: "" };
}

function looksWaf(html) {
  const t = String(html || "").toLowerCase();
  return (
    t.includes("access denied") ||
    t.includes("captcha") ||
    t.includes("challenge") ||
    t.includes("cf-challenge") ||
    t.includes("cloudflare")
  );
}

async function fetchCdnSmart(url, errors, venueTag) {
  try {
    const html = await fetchText(url, { headers: { accept: "text/html,*/*;q=0.9" } }, { tries: 2 });
    if (!looksWaf(html)) return html;
    errors.push({ source: "cdn", venue: venueTag, message: `waf on ${url} -> trying jina` });
  } catch (e) {
    errors.push({ source: "cdn", venue: venueTag, message: `direct fail ${url}: ${String(e?.message || e)}` });
  }

  try {
    const html = await fetchText(toJinaUrl(url), { headers: { accept: "text/plain,*/*;q=0.9" } }, { tries: 2 });
    return html;
  } catch (e) {
    errors.push({ source: "cdn", venue: venueTag, message: `jina fail ${url}: ${String(e?.message || e)}` });
    return "";
  }
}

function extractCdnCardDateText($detail) {
  // Espera un nodo cheerio (wrapper-detail .detail)
  const txt = normSpace(
    $detail
      .find("p")
      .toArray()
      .map((p) => stripHtml(cheerio.load(p).root().html() || ""))
      .join(" · ")
  );
  if (!txt) return "";

  // formatos tipo "13 FEB - 5 ABR 2026" o "13 feb – 5 abr"
  const m = txt.match(
    /\b(\d{1,2}\s*[A-Za-zÁÉÍÓÚáéíóúÑñ]{3,}\s*[-–]\s*\d{1,2}\s*[A-Za-zÁÉÍÓÚáéíóúÑñ]{3,}(?:\s*\d{4})?)\b/i
  );
  if (m) return normSpace(m[1]);

  const m2 = txt.match(/\b(del\s+\d{1,2}\s+al\s+\d{1,2}\s+de\s+[a-záéíóúñ]+\s+de\s+\d{4})\b/i);
  if (m2) return normSpace(m2[1]);

  return "";
}

function parseTeamBlock($) {
  const out = { author: "", director: "" };
  const txt = normSpace($("div.equipo.box-line").text());
  if (!txt) return out;

  let m = txt.match(/\bTexto\s+y\s+direcci[oó]n\s*:?\s*([^|·\n]+)/i);
  if (m) {
    out.author = normSpace(m[1]);
    out.director = normSpace(m[1]);
    return out;
  }

  m = txt.match(
    /\b(?:Texto|Dramaturgia|Autor(?:ía)?)\s*:?\s*([^|·\n]+?)(?=\b(?:Direcci[oó]n|Versi[oó]n\s+y\s+direcci[oó]n|$))/i
  );
  if (m) out.author = normSpace(m[1]);

  m = txt.match(
    /\b(?:Direcci[oó]n|Versi[oó]n\s+y\s+direcci[oó]n)\s*:?\s*([^|·\n]+?)(?=\b(?:Texto|Dramaturgia|Autor(?:ía)?|$))/i
  );
  if (m) out.director = normSpace(m[1]);

  return out;
}

function parseCdnDetailDate($) {
  // Selector estable guardado: div.col-lg-5.col-left .box-title .detail > p
  const p = $("div.col-lg-5.col-left .box-title .detail > p").first();
  if (!p.length) return { rangeText: "", scheduleText: "" };

  const rangeText = normSpace(p.find("strong").first().text());
  const html = (p.html() || "").replace(/<br\s*\/?>/gi, "\n");

  // OJO: stripHtml quita tags, luego split por salto
  const lines = String(html)
    .split(/\n+/)
    .map((ln) => stripHtml(ln))
    .map(normSpace)
    .filter(Boolean);

  const scheduleText =
    lines.find(
      (ln) =>
        ln !== rangeText &&
        /(a\s+las\s+\d{1,2}[:\.]\d{2}|\d{1,2}[:\.]\d{2}\s*h|lunes|martes|mi[eé]rcoles|jueves|viernes|s[áa]bado|domingo)/i.test(
          ln
        )
    ) || "";

  return {
    rangeText,
    scheduleText: scheduleText ? normSpace(scheduleText.split("| Duración")[0].split("|")[0]) : ""
  };
}

function buildCdnDateText(rangeText, scheduleText, fallback = "") {
  const range = normSpace(rangeText);
  const sch = normSpace(scheduleText);
  if (range && sch) return `${range} · ${sch}`;
  if (range) return `${range} · Consultar taquilla`;
  return normSpace(fallback);
}

function inferCdnSourceFromText(txt, fallback = "") {
  const t = normSpace(txt).toLowerCase();
  if (t.includes("maría guerrero") || t.includes("maria guerrero")) return "cdn-maria-guerrero";
  if (t.includes("valle-inclán") || t.includes("valle inclan") || t.includes("valle-inclan")) return "cdn-valle-inclan";
  return fallback || "cdn-valle-inclan";
}

/**
 * FIX CRÍTICO CDN:
 * - NO usar extractCdnCardDateText($("body")) (bug).
 * - Si panel izquierdo falla, fallback por regex en texto plano del documento.
 */
function fallbackRangeFromTextDoc(docText) {
  const t = normSpace(docText);
  if (!t) return "";

  // rango tipo "13 FEB - 5 ABR 2026"
  let m = t.match(/\b(\d{1,2}\s*[A-Za-zÁÉÍÓÚáéíóúÑñ]{3,}\s*[-–]\s*\d{1,2}\s*[A-Za-zÁÉÍÓÚáéíóúÑñ]{3,}\s*\d{4})\b/);
  if (m) return normSpace(m[1]);

  // rango tipo "13 feb – 5 abr"
  m = t.match(/\b(\d{1,2}\s*[A-Za-zÁÉÍÓÚáéíóúÑñ]{3,}\s*[-–]\s*\d{1,2}\s*[A-Za-zÁÉÍÓÚáéíóúÑñ]{3,})\b/);
  if (m) return normSpace(m[1]);

  // "del 13 al 15 de febrero de 2026"
  m = t.match(/\b(del\s+\d{1,2}\s+al\s+\d{1,2}\s+de\s+[A-Za-zÁÉÍÓÚáéíóúÑñ]+\s+de\s+\d{4})\b/i);
  if (m) return normSpace(m[1]);

  return "";
}

async function enrichCdnEvent(item, errors) {
  const tries = [item.link, toJinaUrl(item.link)];
  const enriched = { ...item };

  for (const u of tries) {
    try {
      const html = await fetchText(
        u,
        {
          headers: {
            accept: u.includes("r.jina.ai") ? "text/plain,*/*;q=0.9" : "text/html,*/*;q=0.9"
          }
        },
        { tries: 2 }
      );

      const $ = cheerio.load(html);

      const title = normSpace($("h1").first().text()) || enriched.title;
      if (title) enriched.title = title;

      // Panel izquierdo (estable)
      const { rangeText, scheduleText } = parseCdnDetailDate($);

      // Fallback por regex en documento si no hay panel/rango
      const rangeFallback = rangeText || fallbackRangeFromTextDoc($.text());
      if (rangeFallback) {
        enriched.dateText = buildCdnDateText(rangeFallback, scheduleText, enriched.dateText);
        if (!enriched.startDate) enriched.startDate = parseSpanishStartDate(rangeFallback);
        if (!enriched.endDate) enriched.endDate = parseSpanishEndDate(rangeFallback);
      }

      const team = parseTeamBlock($);
      if (team.author && !enriched.author) enriched.author = team.author;
      if (team.director && !enriched.director) enriched.director = team.director;

      enriched.source = inferCdnSourceFromText($.text(), enriched.source);

      if (!enriched.image) {
        enriched.image = $("meta[property='og:image']").attr("content") || "";
      }

      if (u.includes("r.jina.ai")) errors.push({ source: "cdn", venue: enriched.source, message: `evento:jina:ok ${item.link}` });

      // Si ya tenemos endDate + dateText, paramos
      if (enriched.endDate && enriched.dateText) break;
    } catch (e) {
      if (u.includes("r.jina.ai")) errors.push({ source: "cdn", venue: item.source, message: `evento:jina:fail ${item.link}` });
    }
  }

  // Fallback prensa si falta autor/director
  if (!enriched.author || !enriched.director) {
    const m = String(item.link).match(/\/evento\/([^/?#]+)\/?/i);
    if (m) {
      const pressUrl = `https://dramatico.inaem.gob.es/prensa/${m[1]}/`;
      try {
        const txt = await fetchText(toJinaUrl(pressUrl), { headers: { accept: "text/plain,*/*;q=0.9" } }, { tries: 2 });
        const t = normSpace(txt);
        const ad = { author: "", director: "" };

        let mm = t.match(/\bTexto\s+y\s+direcci[oó]n\s*:?\s*([^|·\n]+)/i);
        if (mm) {
          ad.author = normSpace(mm[1]);
          ad.director = normSpace(mm[1]);
        }
        if (!ad.author) {
          mm = t.match(/\b(?:Texto|Dramaturgia|Autor(?:ía)?)\s*:?\s*([^|·\n]+)/i);
          if (mm) ad.author = normSpace(mm[1]);
        }
        if (!ad.director) {
          mm = t.match(/\b(?:Direcci[oó]n|Versi[oó]n\s+y\s+direcci[oó]n)\s*:?\s*([^|·\n]+)/i);
          if (mm) ad.director = normSpace(mm[1]);
        }

        if (ad.author && !enriched.author) enriched.author = ad.author;
        if (ad.director && !enriched.director) enriched.director = ad.director;
        errors.push({ source: "cdn", venue: enriched.source, message: `prensa:ok ${pressUrl}` });
      } catch {
        errors.push({ source: "cdn", venue: enriched.source, message: `prensa:fail ${pressUrl}` });
      }
    }
  }

  // Credits editorial corto
  if (!enriched.credits) {
    const bits = [];
    if (enriched.author) bits.push(enriched.author);
    if (enriched.director && enriched.director !== enriched.author) bits.push(enriched.director);
    enriched.credits = truncateForUI(bits.join(" · "), 160);
  }

  // Metas de sala
  const meta = sourceMeta(enriched.source);
  enriched.venue = enriched.venue || meta.venue;
  enriched.address = enriched.address || meta.address;
  enriched.mapsQuery = enriched.mapsQuery || meta.mapsQuery;
  enriched.mapsUrl = toMapsUrl(enriched.mapsQuery);

  return enriched;
}

async function scrapeCdnProgramacionPage(url, source, errors) {
  const html = await fetchCdnSmart(url, errors, source);
  if (!html) return [];
  const $ = cheerio.load(html);
  const out = [];

  // Selector estable guardado: div.item-event-resume + wrapper-detail .detail h2 a[href*='/evento/']
  $("div.item-event-resume").each((_, card) => {
    const $card = $(card);
    const $detail = $card.find(".wrapper-detail .detail").first();
    const $a = $detail.find("h2 a[href*='/evento/']").first();

    const title = normSpace($a.text());
    const href = $a.attr("href") || "";
    const link = href ? (href.startsWith("http") ? href : `https://dramatico.inaem.gob.es${href}`) : "";
    if (!title || !link) return;

    const meta = sourceMeta(source);
    const dateText = extractCdnCardDateText($detail);

    out.push(
      makeBaseItem({
        source,
        kind: "theatre",
        title,
        link,
        startDate: parseSpanishStartDate(dateText),
        endDate: parseSpanishEndDate(dateText),
        dateText,
        venue: meta.venue,
        address: meta.address,
        mapsQuery: meta.mapsQuery,
        mapsUrl: toMapsUrl(meta.mapsQuery),
        image:
          $card.find(".carousel-inner img").first().attr("src") ||
          $card.find("img").first().attr("src") ||
          "",
        company: "Centro Dramático Nacional"
      })
    );
  });

  const unique = dedupeBy(out, (x) => x.link);
  const enriched = [];
  for (const it of unique) {
    enriched.push(await enrichCdnEvent(it, errors));
  }

  // Mantener solo eventos con endDate (si no, no podemos rotar)
  return enriched.filter((x) => x.endDate);
}

async function scrapeCDN(errors) {
  const mgUrl = "https://dramatico.inaem.gob.es/programacion/teatro-maria-guerrero/";
  const viUrl = "https://dramatico.inaem.gob.es/programacion/teatro-valle-inclan/";

  const [mg, vi] = await Promise.all([
    scrapeCdnProgramacionPage(mgUrl, "cdn-maria-guerrero", errors),
    scrapeCdnProgramacionPage(viUrl, "cdn-valle-inclan", errors)
  ]);

  const all = dedupeBy([...mg, ...vi], (x) => x.link);
  const now = Date.now();
  const kept = all.filter((x) => !isExpired(x, now));
  errors.push({ source: "cdn", venue: "pipeline", message: `cdn: collected ${all.length}, kept ${kept.length}` });
  return kept;
}

// ---- CANAL (REST) — NO CIRCO AQUÍ ----
function canalContainsCirco(ev) {
  const t = normSpace(`${ev?.title || ""} ${ev?.url || ""} ${JSON.stringify(ev?.categories || [])}`).toLowerCase();
  return /(circo|circus|cirque|pandax|acrob|clown)/.test(t);
}

function canalIsDance(ev) {
  const t = normSpace(JSON.stringify(ev?.categories || [])).toLowerCase();
  return /danza/.test(t);
}

function canalIsTheatre(ev) {
  const t = normSpace(JSON.stringify(ev?.categories || [])).toLowerCase();
  return /teatro/.test(t);
}

function formatCanalDateText(startIso, endIso) {
  const d1 = new Date(startIso);
  const d2 = new Date(endIso);
  const mon = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const left = `${d1.getDate()} ${mon[d1.getMonth()]}`;
  const right = `${d2.getDate()} ${mon[d2.getMonth()]}`;

  const hh = String(d1.getHours()).padStart(2, "0");
  const mm = String(d1.getMinutes()).padStart(2, "0");
  const showHour = !(hh === "00" && mm === "00");
  return `${left} – ${right}${showHour ? ` · ${hh}:${mm}` : ""}`;
}

async function scrapeCanal(errors) {
  const theatre = [];
  const dance = [];

  let page = 1;
  let guard = 0;

  while (guard < 12) {
    guard += 1;

    const url = `https://www.teatroscanal.com/wp-json/tribe/events/v1/events?page=${page}&per_page=100`;
    let json;

    try {
      const txt = await fetchText(url, { headers: { accept: "application/json,*/*;q=0.9" } }, { tries: 2, allowStatuses: [400, 404] });
      json = parseJsonSafe(txt, null);
    } catch (e) {
      errors.push({ source: "canal", venue: "canal", message: `page ${page} ${String(e?.message || e)}` });
      break;
    }

    const events = Array.isArray(json?.events) ? json.events : [];
    if (!events.length) break;

    for (const ev of events) {
      if (canalContainsCirco(ev)) continue;

      const title = normSpace(ev?.title);
      const link = ev?.url || "";
      if (!title || !link) continue;

      const startRaw = ev?.start_date || ev?.start_date_utc;
      const endRaw = ev?.end_date || ev?.end_date_utc;
      if (!startRaw || !endRaw) continue;

      const startDate = new Date(startRaw).toISOString();
      const endDate = new Date(endRaw).toISOString();

      const base = makeBaseItem({
        source: "canal",
        title,
        link,
        startDate,
        endDate,
        dateText: formatCanalDateText(startDate, endDate),
        venue: "Teatros del Canal",
        address: "C. de Cea Bermúdez, 1, Madrid",
        mapsQuery: "Teatros del Canal, Madrid",
        mapsUrl: toMapsUrl("Teatros del Canal, Madrid"),
        image: ev?.image?.url || ev?.image?.sizes?.medium?.url || ""
      });

      if (canalIsDance(ev)) {
        dance.push({ ...base, kind: "dance" });
      } else if (canalIsTheatre(ev)) {
        theatre.push({ ...base, kind: "theatre" });
      }
    }

    page += 1;
  }

  return {
    theatre: dedupeBy(theatre, (x) => x.link),
    dance: dedupeBy(dance, (x) => x.link)
  };
}

// ---- TEATRO ESPAÑOL (Drupal Views AJAX) ----
function extractDrupalLibraries(html) {
  const s = String(html || "");

  // JSON en script
  let m = s.match(/"ajax_page_state"\s*:\s*\{[\s\S]*?"libraries"\s*:\s*"([^"]+)"/i);
  if (m) return m[1];

  // Input hidden
  m = s.match(/name="ajax_page_state\[libraries\]"\s+value="([^"]+)"/i);
  if (m) return m[1];

  return "";
}

function extractDrupalHtmlFromAjaxCommands(payload) {
  const arr = Array.isArray(payload) ? payload : [];
  let html = "";
  for (const cmd of arr) {
    if (typeof cmd?.data === "string" && cmd.data.includes("views-row")) html += `\n${cmd.data}`;
    if (typeof cmd?.html === "string" && cmd.html.includes("views-row")) html += `\n${cmd.html}`;
  }
  return html;
}

async function scrapeTeatroEspanol(errors) {
  const out = [];
  const base = "https://www.teatroespanol.es";
  let libraries = "";

  try {
    const initial = await fetchText(`${base}/programacion`, { headers: { accept: "text/html,*/*;q=0.9" } }, { tries: 2 });
    libraries = extractDrupalLibraries(initial);
    if (!libraries) {
      errors.push({ source: "teatroespanol", venue: "teatroespanol", message: "libraries empty (fallback POST without libraries will be attempted)" });
    }
  } catch (e) {
    errors.push({ source: "teatroespanol", venue: "teatroespanol", message: `init fail: ${String(e?.message || e)}` });
  }

  for (let page = 0; page < 30; page++) {
    const params = new URLSearchParams({
      view_name: "schedule",
      view_display_id: "schedule",
      view_path: "/programacion",
      view_base_path: "programacion",
      page: String(page),
      "ajax_page_state[theme]": "teatroespanol_v2"
    });

    // Solo añadimos libraries si las tenemos (si no, intentamos igualmente).
    if (libraries) params.set("ajax_page_state[libraries]", libraries);

    let payload;
    try {
      const txt = await fetchText(
        `${base}/views/ajax?_wrapper_format=drupal_ajax`,
        {
          method: "POST",
          headers: {
            accept: "application/json, text/javascript, */*; q=0.01",
            "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
            "x-requested-with": "XMLHttpRequest",
            origin: base,
            referer: `${base}/programacion`
          },
          body: params.toString()
        },
        { tries: 2 }
      );
      payload = parseJsonSafe(txt, []);
    } catch (e) {
      errors.push({ source: "teatroespanol", venue: "teatroespanol", message: `ajax page ${page} fail: ${String(e?.message || e)}` });
      break;
    }

    const html = extractDrupalHtmlFromAjaxCommands(payload);
    if (!html || !html.includes("views-row")) break;

    const $ = cheerio.load(html);
    const rows = $("div.views-row");
    if (!rows.length) break;

    rows.each((_, row) => {
      const $row = $(row);
      const $a = $row.find(".field-name-node-title a").first();
      const title = normSpace($a.text());
      const href = $a.attr("href") || "";
      const link = href ? (href.startsWith("http") ? href : `${base}${href}`) : "";
      if (!title || !link) return;

      const dateText = normSpace($row.find(".date-range").first().text());
      const endDate = parseSpanishEndDate(dateText);
      if (!endDate) return;

      out.push(
        makeBaseItem({
          source: "teatroespanol",
          kind: "theatre",
          title,
          link,
          dateText,
          startDate: parseSpanishStartDate(dateText),
          endDate,
          venue: "Teatro Español",
          address: "Pl. de Santa Ana, 4, Madrid",
          mapsQuery: "Teatro Español, Pl. de Santa Ana, 4, Madrid",
          mapsUrl: toMapsUrl("Teatro Español, Pl. de Santa Ana, 4, Madrid")
        })
      );
    });
  }

  const unique = dedupeBy(out, (x) => x.link);
  errors.push({ source: "teatroespanol", venue: "pipeline", message: `espanol: collected ${unique.length}` });
  return unique;
}

// ---- NAVE10 ----
async function scrapeNave10(errors) {
  const out = [];
  const tryPaths = [
    "https://www.nave10matadero.es/actividades/",
    "https://www.nave10matadero.es/actividades",
    "https://www.nave10matadero.es/programacion/",
    "https://www.nave10matadero.es/programacion",
    "https://www.nave10matadero.es/agenda/",
    "https://www.nave10matadero.es/agenda"
  ];

  let listing = "";
  let usedUrl = "";

  for (const p of tryPaths) {
    try {
      const txt = await fetchText(p, { headers: { accept: "text/html,*/*;q=0.9" } }, { tries: 2, allowStatuses: [404] });
      if (txt && !looksWaf(txt) && !/404/i.test(txt)) {
        listing = txt;
        usedUrl = p;
        break;
      }
    } catch {
      // ignore
    }
  }

  if (!listing) {
    errors.push({ source: "nave10", venue: "nave10", message: "listing unavailable (all tried paths failed)" });
    return out;
  }

  errors.push({ source: "nave10", venue: "nave10", message: `listing ok ${usedUrl}` });

  const $ = cheerio.load(listing);
  const links = new Set();

  $("a[href]").each((_, a) => {
    const href = $(a).attr("href") || "";
    if (!href) return;
    const abs = href.startsWith("http") ? href : `https://www.nave10matadero.es${href}`;
    if (/\.(jpg|jpeg|png|webp|pdf)(\?|$)/i.test(abs)) return;
    if (/nave10matadero\.es\/.+/i.test(abs)) {
      if (/\/actividades\//i.test(abs) || /\/programacion\//i.test(abs) || /\/agenda\//i.test(abs)) links.add(abs);
    }
  });

  for (const link of [...links].slice(0, 60)) {
    try {
      const html = await fetchText(link, { headers: { accept: "text/html,*/*;q=0.9" } }, { tries: 1, allowStatuses: [404] });
      if (!html || /404/i.test(html)) continue;

      const $$ = cheerio.load(html);
      const title =
        normSpace($$("h1").first().text()) || normSpace($$("meta[property='og:title']").attr("content"));
      if (!title) continue;

      let startDate = "";
      let endDate = "";

      const ldScripts = $$('script[type="application/ld+json"]').toArray();
      for (const sc of ldScripts) {
        const obj = parseJsonSafe($$(sc).html() || "", null);
        const arr = Array.isArray(obj) ? obj : obj ? [obj] : [];
        for (const x of arr) {
          if (x?.startDate && !startDate) startDate = new Date(x.startDate).toISOString();
          if (x?.endDate && !endDate) endDate = new Date(x.endDate).toISOString();
          if (Array.isArray(x?.subEvent)) {
            for (const y of x.subEvent) {
              if (y?.startDate && !startDate) startDate = new Date(y.startDate).toISOString();
              if (y?.endDate && !endDate) endDate = new Date(y.endDate).toISOString();
            }
          }
        }
      }

      if (!endDate) continue;

      out.push(
        makeBaseItem({
          source: "nave10",
          kind: "theatre",
          title,
          link,
          startDate,
          endDate,
          deck: truncateForUI(normSpace($$("meta[name='description']").attr("content") || ""), 200),
          venue: "Nave 10 Matadero",
          address: "Plaza de Legazpi, 8, Madrid",
          mapsQuery: "Nave 10 Matadero, Plaza de Legazpi 8, Madrid",
          mapsUrl: toMapsUrl("Nave 10 Matadero, Plaza de Legazpi 8, Madrid"),
          image: $$("meta[property='og:image']").attr("content") || ""
        })
      );
    } catch {
      // ignore
    }
  }

  const unique = dedupeBy(out, (x) => x.link);
  errors.push({ source: "nave10", venue: "pipeline", message: `nave10: collected ${unique.length}` });
  return unique;
}

// ---- PRADILLO ----
async function scrapePradillo(errors) {
  const out = [];
  try {
    const html = await fetchText("https://www.teatropradillo.com/", { headers: { accept: "text/html,*/*;q=0.9" } }, { tries: 2 });
    const $ = cheerio.load(html);

    $("article.et_pb_post").each((_, card) => {
      const $c = $(card);
      const $a = $c.find("h2 a").first();
      const title = normSpace($a.text());
      const href = $a.attr("href") || "";
      const link = href ? (href.startsWith("http") ? href : `https://www.teatropradillo.com${href}`) : "";
      if (!title || !link) return;

      // Mejor intento: meta + texto
      const dateText = normSpace($c.find(".post-meta").text()) || normSpace($c.text());
      const endDate = parseSpanishEndDate(dateText);
      if (!endDate) return;

      out.push(
        makeBaseItem({
          source: "pradillo",
          kind: "theatre",
          title,
          link,
          dateText,
          startDate: parseSpanishStartDate(dateText),
          endDate,
          venue: "Teatro Pradillo",
          address: "C. de Pradillo, 12, Madrid",
          mapsQuery: "Teatro Pradillo, Madrid",
          mapsUrl: toMapsUrl("Teatro Pradillo, Madrid")
        })
      );
    });
  } catch (e) {
    errors.push({ source: "pradillo", venue: "pradillo", message: String(e?.message || e) });
  }

  const unique = dedupeBy(out, (x) => x.link);
  errors.push({ source: "pradillo", venue: "pipeline", message: `pradillo: collected ${unique.length}` });
  return unique;
}

// ---- TEATRO DEL BARRIO ----
async function scrapeTeatroDelBarrio(errors) {
  const out = [];
  try {
    const html = await fetchText("https://teatrodelbarrio.com/", { headers: { accept: "text/html,*/*;q=0.9" } }, { tries: 2 });
    const $ = cheerio.load(html);

    $("div.article[id^='post-']").each((_, card) => {
      const $c = $(card);
      const $a = $c.find("h2.title a").first(); // selector correcto guardado
      const title = normSpace($a.text());
      const href = $a.attr("href") || "";
      const link = href ? (href.startsWith("http") ? href : `https://teatrodelbarrio.com${href}`) : "";
      if (!title || !link) return;

      const dateText = normSpace($c.text());
      const endDate = parseSpanishEndDate(dateText);
      if (!endDate) return;

      out.push(
        makeBaseItem({
          source: "teatrodelbarrio",
          kind: "theatre",
          title,
          link,
          dateText,
          startDate: parseSpanishStartDate(dateText),
          endDate,
          venue: "Teatro del Barrio",
          address: "C/ de Zurita, 20, Madrid",
          mapsQuery: "Teatro del Barrio, Madrid",
          mapsUrl: toMapsUrl("Teatro del Barrio, Madrid")
        })
      );
    });
  } catch (e) {
    errors.push({ source: "teatrodelbarrio", venue: "teatrodelbarrio", message: String(e?.message || e) });
  }

  const unique = dedupeBy(out, (x) => x.link);
  errors.push({ source: "teatrodelbarrio", venue: "pipeline", message: `barrio: collected ${unique.length}` });
  return unique;
}

function filterActive(items) {
  const nowMs = Date.now();
  return items.filter((it) => {
    const end = isoToMs(it.endDate);
    return end !== Infinity && end >= nowMs - 24 * 60 * 60 * 1000;
  });
}

function countMix(items) {
  const m = {};
  for (const it of items) m[it.source] = (m[it.source] || 0) + 1;
  return m;
}

// ---- MAIN ----
async function main() {
  const errors = [];

  const [cdnTheatre, canal, espanolTheatre, nave10Theatre, pradilloTheatre, barrioTheatre] = await Promise.all([
    scrapeCDN(errors),
    scrapeCanal(errors),
    scrapeTeatroEspanol(errors),
    scrapeNave10(errors),
    scrapePradillo(errors),
    scrapeTeatroDelBarrio(errors)
  ]);

  const theatreCollected = dedupeBy(
    [...cdnTheatre, ...espanolTheatre, ...nave10Theatre, ...pradilloTheatre, ...barrioTheatre, ...canal.theatre],
    (x) => x.link
  );

  const danceCollected = dedupeBy(canal.dance, (x) => x.link);

  const theatreActive = filterActive(theatreCollected);
  const danceActive = filterActive(danceCollected);

  const theatreFinal = pickWithCapsStrict(theatreActive, LIMITS.theatreMax, CAPS_THEATRE).map(sanitizeForOutput);
  const danceFinal = pickWithCapsStrict(danceActive, LIMITS.danceMax, CAPS_DANCE).map(sanitizeForOutput);

  const out = {
    updatedAt: new Date().toISOString(),
    theatre: theatreFinal,
    dance: danceFinal,
    meta: {
      counts: {
        theatreCollected: theatreCollected.length,
        danceCollected: danceCollected.length,
        theatreActive: theatreActive.length,
        danceActive: danceActive.length,
        theatreFinal: theatreFinal.length,
        danceFinal: danceFinal.length
      },
      mix: {
        theatre: countMix(theatreFinal),
        dance: countMix(danceFinal)
      },
      errors
    }
  };

  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fs.writeFile(OUT_PATH, `${JSON.stringify(out, null, 2)}\n`, "utf8");
}

main().catch(async (err) => {
  const fallback = {
    updatedAt: new Date().toISOString(),
    theatre: [],
    dance: [],
    meta: {
      counts: {
        theatreCollected: 0,
        danceCollected: 0,
        theatreActive: 0,
        danceActive: 0,
        theatreFinal: 0,
        danceFinal: 0
      },
      mix: { theatre: {}, dance: {} },
      errors: [{ source: "main", venue: "main", message: String(err?.stack || err?.message || err) }]
    }
  };

  try {
    await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
    await fs.writeFile(OUT_PATH, `${JSON.stringify(fallback, null, 2)}\n`, "utf8");
  } catch {
    // ignore
  }
  process.exitCode = 1;
});

