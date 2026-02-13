/**
 * Update Cartelera (Weekly) — COOLtura ✅ BLINDADO (CDN PROGRAMACIÓN + FICHA HORARIOS + CANAL REST + ESPAÑOL AJAX)
 * - Genera /data/cartelera-weekly.json
 * - Agenda plural y curada (cupo por fuente)
 * - Teatro: 10 items (mix garantizado)
 * - Danza: 2 items (Canal)
 * - Sin venta de entradas en salida (UI decide links; aquí solo guardamos link)
 * - Pin Google Maps siempre (search api=1)
 * - Rotación por fecha de finalización (endDate) + filtro vencidos
 *
 * CDN (dramatico.inaem.gob.es)
 * - NO usa admin-ajax (WAF).
 * - Scrapea PROGRAMACIÓN estable:
 *   - https://dramatico.inaem.gob.es/programacion/teatro-maria-guerrero/
 *   - https://dramatico.inaem.gob.es/programacion/teatro-valle-inclan/
 * - Extrae desde la tarjeta: title + autor/director si aparecen + rango (dateText básico) + link /evento/*
 * - Enrich por ficha /evento/*:
 *   - Horarios/días (panel izquierdo) ✅ selector estable:
 *     div.col-lg-5.col-left .box-title .detail > p
 *   - JSON-LD (startDate/endDate si existen)
 *   - equipo box (author/director/cast/company/choreographer)
 *   - og:image
 *
 * CANAL (teatroscanal.com)
 * - REST estable: /wp-json/tribe/events/v1/events
 * - 404 en page>n => fin de paginación (NO error)
 * - dateText editorial (día/rango + hora) ✅
 *
 * TEATRO ESPAÑOL (teatroespanol.es)
 * - Drupal Views AJAX: /views/ajax?_wrapper_format=drupal_ajax
 *
 * Requiere: npm i cheerio@1
 */

import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import zlib from "node:zlib";
import { URL } from "node:url";
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

async function fetchJsonSafe(url, opts = {}, meta = {}) {
  const txt = await fetchText(url, opts, meta);
  if (looksLikeHtml(txt)) {
    const snip = txt.slice(0, 260).replace(/\s+/g, " ");
    throw new Error(`Expected JSON but got HTML. Snippet: ${snip}`);
  }
  try {
    return JSON.parse(txt);
  } catch (e) {
    const snip = txt.slice(0, 260).replace(/\s+/g, " ");
    throw new Error(`JSON.parse failed. Snippet: ${snip}`);
  }
}

/* =========================================================
   Helpers
   ========================================================= */

function normSpace(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
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

function pickFirstSentence(text, max = 210) {
  const t = normSpace(text);
  if (!t) return "";
  const cut = t.split(". ").slice(0, 2).join(". ");
  return cut.length > max ? cut.slice(0, max - 1) + "…" : cut;
}

function truncateForUI(text, max = 160) {
  const t = normSpace(text);
  if (!t) return "";
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/* --------- Fechas --------- */

const MONTHS = {
  enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5,
  julio: 6, agosto: 7, septiembre: 8, setiembre: 8,
  octubre: 9, noviembre: 10, diciembre: 11,
  ene: 0, feb: 1, mar: 2, abr: 3, may: 4, jun: 5, jul: 6, ago: 7, sep: 8, oct: 9, nov: 10, dic: 11
};

function normMonthKey(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function parseSpanishEndDate(dateText) {
  const s0 = normSpace(dateText);
  const s = s0.toLowerCase();
  if (!s) return "";

  // "23 ENE - 01 MAR" / "13 FEB - 05 ABR 2026"
  let m = s.match(/\b(\d{1,2})\s*([a-záéíóúñ]{3,})\s*[-–]\s*(\d{1,2})\s*([a-záéíóúñ]{3,})(?:\s*(\d{4}))?/i);
  if (m) {
    const d2 = Number(m[3]);
    const mon = MONTHS[normMonthKey(m[4])];
    const y = m[5] ? Number(m[5]) : new Date().getFullYear();
    if (Number.isFinite(mon)) return new Date(y, mon, d2, 23, 59, 59).toISOString();
  }

  // "23 Enero7 Marzo 2026" (Teatro Español a veces sin separadores)
  m = s.match(/\b(\d{1,2})\s*([a-záéíóúñ]+)\s*(\d{1,2})\s*([a-záéíóúñ]+)\s*(\d{4})\b/i);
  if (m) {
    const d2 = Number(m[3]);
    const mon = MONTHS[normMonthKey(m[4])];
    const y = Number(m[5]);
    if (Number.isFinite(mon)) return new Date(y, mon, d2, 23, 59, 59).toISOString();
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
}

function sanitizeForOutput(it) {
  const creditsShort = truncateForUI(it.credits || "", 160);
  return {
    source: it.source,
    kind: it.kind,
    title: it.title,

    credits: creditsShort,
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

    picked.push(it);
    counts.set(src, n + 1);
  }

  // Pasada 2: relleno controlado (sin dar extra a Nave10)
  if (picked.length < totalMax) {
    const fillOrder = [
      "teatroespanol",
      "cdn-valle-inclan",
      "cdn-maria-guerrero",
      "teatrodelbarrio",
      "pradillo",
      "canal",
      "nave10"
    ];

    for (const src of fillOrder) {
      if (picked.length >= totalMax) break;
      if (!(src in capsBySource)) continue;

      const baseCap = capsBySource[src] ?? 0;
      const hard = src === "nave10" ? baseCap : baseCap + 1;

      for (const it of sorted) {
        if (picked.length >= totalMax) break;
        if (it.source !== src) continue;
        if (hard === 0) continue;

        if (picked.some((p) => p.link && it.link && p.link === it.link)) continue;

        const n = counts.get(src) || 0;
        if (n >= hard) continue;

        picked.push(it);
        counts.set(src, n + 1);
      }
    }
  }

  return picked.slice(0, totalMax);
}

function tallyBySource(items) {
  return items.reduce((acc, x) => {
    acc[x.source] = (acc[x.source] || 0) + 1;
    return acc;
  }, {});
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
      }
    } catch (_) {}
  }
  return out;
}

function pickEventFromJsonLd(arr) {
  const events = arr.filter(
    (o) => o && typeof o === "object" && /Event$/i.test(String(o["@type"] || ""))
  );
  if (events.length) return events[0];
  return arr.find((o) => o && typeof o === "object" && o.name && o.url) || null;
}

function normKeyLabel(s) {
  return normSpace(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
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
      }
    });
  });

  if (cast.length) out.cast = [...new Set(cast)].slice(0, 8);
  return out;
}

function extractOgImage($) {
  return (
    $('meta[property="og:image"]').attr("content") ||
    $('meta[name="twitter:image"]').attr("content") ||
    ""
  );
}

/* =========================================================
   CDN — PROGRAMACIÓN estable + ENRICH HORARIOS (ficha)
   ========================================================= */

function cdnVenueMeta(source) {
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
  return { venue: "Centro Dramático Nacional", address: "Madrid", mapsQuery: "Centro Dramático Nacional, Madrid" };
}

function extractDateTextFromCDNCard($detail) {
  // En tu HTML: <p>13 FEB - 05 ABR | <strong>Teatro María Guerrero</strong> | Sala</p>
  const p = $detail.find("p").filter((_, el) => {
    const t = normSpace(cheerio.load($(el).html() || "").text());
    return /\b\d{1,2}\s+[A-ZÁÉÍÓÚÑ]{3}\s*[-–]\s*\d{1,2}\s+[A-ZÁÉÍÓÚÑ]{3}/.test(t);
  }).first();

  const txt = normSpace(stripHtml(p.html() || ""));
  const m = txt.match(/\b(\d{1,2}\s+[A-ZÁÉÍÓÚÑ]{3}\s*[-–]\s*\d{1,2}\s+[A-ZÁÉÍÓÚÑ]{3})(?:\s+(\d{4}))?/);
  if (!m) return "";
  return `${m[1]}${m[2] ? " " + m[2] : ""}`;
}

function parseCdnAuthorDirectorFromDetail($detail) {
  // Casos:
  // 1) <p>Texto y dirección <strong>Alfredo Sanzol</strong></p>
  // 2) <p>Dramaturgia <strong>X</strong><br>Dirección <strong>Y</strong>...</p>
  const out = { author: "", director: "", credits: "" };

  // elegimos los <p> de ficha que NO sean el de fechas-rango
  const ps = $detail.find("p").toArray().map((el) => {
    const html = cheerio.load(el).root().html() || "";
    const text = normSpace(stripHtml(html));
    return { el, html, text };
  });

  const ficha = ps.filter(p => p.text && !/\b\d{1,2}\s+[A-ZÁÉÍÓÚÑ]{3}\s*[-–]\s*\d{1,2}\s+[A-ZÁÉÍÓÚÑ]{3}/.test(p.text));

  const blob = ficha.map(x => x.text).join(" · ");

  // Texto y dirección X => author=director=X
  let m = blob.match(/\bTexto\s+y\s+dirección\s+(.+)$/i);
  if (m) {
    const person = normSpace(m[1]);
    out.author = person;
    out.director = person;
    out.credits = truncateForUI(person, 160);
    return out;
  }

  // Dramaturgia / Texto / Autor
  m = blob.match(/\b(Dramaturgia|Texto|Autor(?:ía)?)\s+(.+?)(?=(Dirección|Dirección asociada|$))/i);
  if (m) out.author = normSpace(m[2]);

  // Dirección
  m = blob.match(/\bDirección(?:\s+asociada)?\s+(.+?)(?=($|Dirección asociada|Producción|Compañ[ií]a))/i);
  if (m) out.director = normSpace(m[1]);

  const bits = [];
  if (out.author) bits.push(out.author);
  if (out.director) bits.push(out.director);
  out.credits = truncateForUI(bits.join(" · "), 160);

  return out;
}

function extractCdnScheduleFromEventLeftPanel($) {
  // ✅ Selector estable guardado:
  // div.col-lg-5.col-left .box-title .detail > p
  // <strong>13 FEB - 5 ABR 2026</strong><br>De martes a domingo a las 20:00 | Duración: ...
  const p = $("div.col-lg-5.col-left .box-title .detail > p").first();
  if (!p.length) return { scheduleText: "", rangeText: "" };

  const rangeText = normSpace(p.find("strong").first().text() || "");
  // obtener texto completo preservando el contenido tras <br>
  const html = p.html() || "";
  const normalized = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n");

  const lines = stripHtml(normalized).split("\n").map(normSpace).filter(Boolean);
  // normalmente: ["13 FEB - 5 ABR 2026", "De martes a domingo a las 20:00 | Duración: ..."]
  const scheduleLine = lines.find((x) => /a\s+las\s+\d{1,2}:\d{2}/i.test(x) || /martes|miércoles|jueves|viernes|sábado|domingo|lunes/i.test(x)) || "";
  const scheduleText = scheduleLine ? scheduleLine.split("|")[0].trim() : "";

  return { scheduleText, rangeText };
}

async function enrichDramaticoEventPage(item, errors) {
  if (!item?.link || !/dramatico\.inaem\.gob\.es\/evento\//.test(item.link)) return item;

  try {
    const html = await fetchText(item.link, {
      headers: {
        accept: "text/html,*/*;q=0.9",
        referer: "https://dramatico.inaem.gob.es/",
        origin: "https://dramatico.inaem.gob.es"
      }
    });

    const $ = cheerio.load(html);
    const equipo = parseEquipoBoxFromDramatico($);
    const jsonLd = extractJsonLdObjects(html);
    const ev = pickEventFromJsonLd(jsonLd);

    const enriched = { ...item };

    // JSON-LD dates (si existen)
    if (ev?.startDate && !enriched.startDate) enriched.startDate = String(ev.startDate);
    if (ev?.endDate && !enriched.endDate) enriched.endDate = String(ev.endDate);

    // OG image
    if (!enriched.image) {
      const og = extractOgImage($);
      if (og) enriched.image = og;
    }

    // equipo (si viene)
    if (equipo.author && !enriched.author) enriched.author = equipo.author;
    if (equipo.director && !enriched.director) enriched.director = equipo.director;
    if (equipo.company && !enriched.company) enriched.company = equipo.company;
    if (equipo.choreographer && !enriched.choreographer) enriched.choreographer = equipo.choreographer;
    if (Array.isArray(equipo.cast) && equipo.cast.length && (!Array.isArray(enriched.cast) || !enriched.cast.length)) {
      enriched.cast = equipo.cast;
    }

    // ✅ HORARIO/DÍAS desde panel izquierdo
    const { scheduleText, rangeText } = extractCdnScheduleFromEventLeftPanel($);

    // dateText editorial: preferimos rango + horario (lo que tú quieres)
    // - Si ya teníamos "13 FEB - 05 ABR", lo mantenemos como base
    // - Si la ficha da "13 FEB - 5 ABR 2026", lo usamos como rango mejor
    const baseRange = rangeText || enriched.dateText || "";
    const schedule = normSpace(scheduleText);
    if (baseRange && schedule) enriched.dateText = `${baseRange} · ${schedule}`;
    else if (schedule && !enriched.dateText) enriched.dateText = schedule;

    // endDate: si no vino JSON-LD, lo intentamos por parseo del rango (enriched.dateText o baseRange)
    if (!enriched.endDate) {
      const tryEnd = parseSpanishEndDate(enriched.dateText || baseRange);
      if (tryEnd) enriched.endDate = tryEnd;
    }

    // credits corto: si vacío, generarlo con autor/director
    if (!enriched.credits) {
      const bits = [];
      if (enriched.author) bits.push(enriched.author);
      if (enriched.director) bits.push(enriched.director);
      enriched.credits = truncateForUI(bits.slice(0, 2).join(" · "), 160);
    } else {
      enriched.credits = truncateForUI(enriched.credits, 160);
    }

    return enriched;
  } catch (e) {
    errors.push({
      source: "cdn",
      venue: item.source,
      message: `CDN enrich failed for ${item.link}: ${String(e?.message || e)}`
    });
    return item;
  }
}

async function scrapeCDNProgramacionPage(url, source, errors) {
  const meta = cdnVenueMeta(source);
  const html = await fetchText(url, { headers: { accept: "text/html,*/*;q=0.9" } });
  const $ = cheerio.load(html);

  const out = [];

  // ✅ Tu HTML real: tarjetas con class .item-event-resume + dentro .wrapper-detail .detail h2 a[href*="/evento/"]
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

    // imagen: preferimos el src del primer carousel item
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

async function scrapeCDNProgramacion(errors) {
  const mgUrl = "https://dramatico.inaem.gob.es/programacion/teatro-maria-guerrero/";
  const viUrl = "https://dramatico.inaem.gob.es/programacion/teatro-valle-inclan/";

  const mg = await scrapeCDNProgramacionPage(mgUrl, "cdn-maria-guerrero", errors);
  const vi = await scrapeCDNProgramacionPage(viUrl, "cdn-valle-inclan", errors);

  // Enrich por ficha: horarios + fechas finas + reparto si existe
  const base = [...mg, ...vi];
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

function canalDates(ev) {
  const start = ev?.start_date_utc || ev?.start_date || "";
  const end = ev?.end_date_utc || ev?.end_date || "";
  return { startDate: String(start || ""), endDate: String(end || "") };
}

// ✅ dateText editorial para Canal (día/rango + hora)
function weekdayEsShort(d){
  const w = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
  return w[d.getDay()];
}
function monthEsShort(d){
  const m = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
  return m[d.getMonth()];
}
function pad2(n){ return String(n).padStart(2, "0"); }

function fmtTimeFromIso(iso){
  if(!iso) return "";
  const d = new Date(iso);
  const hh = pad2(d.getHours());
  const mm = pad2(d.getMinutes());
  if (hh === "00" && mm === "00") return "";
  return `${hh}:${mm}`;
}

function canalDateText(ev){
  const start = ev?.start_date_utc || ev?.start_date || "";
  const end   = ev?.end_date_utc   || ev?.end_date   || "";
  if(!start) return "";

  const ds = new Date(start);
  const de = end ? new Date(end) : null;

  const time = fmtTimeFromIso(start);

  if(!de || ds.toDateString() === de.toDateString()){
    const day = `${weekdayEsShort(ds)} ${pad2(ds.getDate())} ${monthEsShort(ds)}`;
    return time ? `${day} · ${time}` : day;
  }

  const a = `${pad2(ds.getDate())} ${monthEsShort(ds)}`;
  const b = `${pad2(de.getDate())} ${monthEsShort(de)}`;
  const w1 = weekdayEsShort(ds);
  const w2 = weekdayEsShort(de);
  const wRange = (w1 && w2) ? `${w1}–${w2}` : "";

  const left = `Del ${a} al ${b}`;
  const mid  = wRange ? ` · ${wRange}` : "";
  const right= time ? ` · ${time}` : "";

  return `${left}${mid}${right}`;
}

async function fetchCanalEventsPage({ perPage, page, startDate, endDate }, errors) {
  const url = new URL("https://www.teatroscanal.com/wp-json/tribe/events/v1/events");
  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set("page", String(page));
  url.searchParams.set("start_date", startDate);
  url.searchParams.set("end_date", endDate);

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

    for (const ev of events) {
      const title = normSpace(ev?.title);
      const link = ev?.url ? String(ev.url) : "";
      if (!title || !link) continue;

      const { startDate: s, endDate: e } = canalDates(ev);
      const image = pickBestImageFromCanal(ev);

      const baseItem = {
        source: "canal",
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
        venue: "Teatros del Canal",
        address: "C. de Cea Bermúdez, 1, Madrid",
        mapsQuery: "Teatros del Canal, Madrid",
        mapsUrl: toMapsUrl("Teatros del Canal, Madrid"),
        link,
        image
      };

      if (isCanalDance(ev)) {
        dance.push({ ...baseItem, kind: "dance" });
      } else if (isCanalTheatre(ev)) {
        theatre.push({ ...baseItem, kind: "theatre" });
      }
    }

    if (theatre.length >= 60 && dance.length >= 20) break;
    await sleep(140);
  }

  return {
    theatre: dedupeBy(theatre, (x) => x.link),
    dance: dedupeBy(dance, (x) => x.link)
  };
}

/* =========================================================
   Nave 10 (JSON-LD por evento)
   ========================================================= */

async function scrapeNave10Theatre(errors) {
  const listUrl = "https://www.nave10matadero.es/programacion?field_category%5B14%5D=14";
  const html = await fetchText(listUrl);
  const $ = cheerio.load(html);

  const links = $("a")
    .map((_, a) => $(a).attr("href"))
    .get()
    .filter(Boolean)
    .map((href) => (href.startsWith("http") ? href : `https://www.nave10matadero.es${href}`))
    .filter((href) => /\/actividades\//.test(href));

  const uniqueLinks = [...new Set(links)].slice(0, 18);

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

      await sleep(120);
    } catch (e) {
      errors.push({ source: "nave10", venue: "activity", message: String(e?.message || e) });
    }
  }
  return out;
}

async function scrapeMataderoTheatreDisabled() {
  return [];
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
      const endDate = parseSpanishEndDate(dateText);

      const img = $(el).find(".et_pb_image_container img").first().attr("src") || "";

      return {
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
}

/* =========================================================
   Teatro del Barrio (Elementor)
   ========================================================= */

async function scrapeTeatroDelBarrio(errors) {
  const url = "https://teatrodelbarrio.com/";
  const html = await fetchText(url);
  const $ = cheerio.load(html);

  const items = $("div.article[id^='post-']")
    .map((_, el) => {
      const $titleA = $(el).find("h2.title").first().closest("a");
      const title = normSpace($(el).find("h2.title").first().text());
      const link = $titleA.attr("href") ? String($titleA.attr("href")) : "";
      if (!title || !link) return null;

      const dateText = normSpace($(el).find(".text-container > div").first().text());
      const endDate = parseSpanishEndDate(dateText);

      const style = $(el).find(".image-wrap").first().attr("style") || "";
      const m = style.match(/background-image:\s*url\(["']?([^"')]+)["']?\)/i);
      const image = m ? m[1] : "";

      return {
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
    });

    await sleep(120);
  }

  return dedupeBy(out, (x) => x.link);
}

/* =========================================================
   MAIN
   ========================================================= */

async function main() {
  const errors = [];

  const theatre = [];
  const dance = [];

  // 1) CDN (Valle + María) desde PROGRAMACIÓN (estable) + enrich (horarios)
  theatre.push(...(await scrapeCDNProgramacion(errors)));

  // 2) CANAL REST (teatro + danza) + dateText editorial
  const canal = await scrapeCanalREST(errors);
  theatre.push(...canal.theatre);
  dance.push(...canal.dance);

  // 3) Nave10 + Matadero desactivado
  theatre.push(...(await scrapeNave10Theatre(errors)));
  theatre.push(...(await scrapeMataderoTheatreDisabled()));

  // 4) Español AJAX (blindado), Pradillo, Barrio
  theatre.push(...(await scrapeTeatroEspanolAJAX(errors)));
  theatre.push(...(await scrapePradillo(errors)));
  theatre.push(...(await scrapeTeatroDelBarrio(errors)));

  const theatreUnique = dedupeBy(theatre, (x) => x.link || `${x.source}:${x.title}`);
  const danceUnique = dedupeBy(dance, (x) => x.link || `${x.source}:${x.title}`);

  const nowMs = Date.now();
  const theatreActive = theatreUnique.filter((it) => !isExpired(it, nowMs));
  const danceActive = danceUnique.filter((it) => !isExpired(it, nowMs));

  const theatrePicked = pickWithCaps(theatreActive, LIMITS.theatreMax, CAPS_THEATRE);
  const dancePicked = pickWithCaps(danceActive, LIMITS.danceMax, CAPS_DANCE);

  const theatreFinal = theatrePicked.map(sanitizeForOutput);
  const danceFinal = dancePicked.map(sanitizeForOutput);

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
        theatreActive: theatreActive.length,
        danceActive: danceActive.length,
        theatreFinal: theatreFinal.length,
        danceFinal: danceFinal.length
      },
      mix: {
        theatre: tallyBySource(theatreFinal),
        dance: tallyBySource(danceFinal)
      },
      errors
    }
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + "\n", "utf-8");

  console.log(`OK: wrote ${OUT_PATH}`);
  console.log(`Mix theatre:`, out.meta.mix.theatre);
  console.log(`Mix dance:`, out.meta.mix.dance);
  if (errors.length) console.warn(`WARN: ${errors.length} source errors (see meta.errors).`);
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
