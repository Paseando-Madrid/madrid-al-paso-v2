/**
 * Update Cartelera (Weekly) — COOLtura
 * - Genera /data/cartelera-weekly.json
 * - Agenda plural y curada (cupo por fuente)
 * - Teatro: 10 items (mix garantizado)
 * - Danza: 2 items (Canal)
 * - Sin venta de entradas en salida
 * - Pin Google Maps siempre (search api=1)
 * - Rotación por fecha de finalización (endDate) + filtro vencidos
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

const LIMITS = {
  theatreMax: 10,
  danceMax: 3
};

// Cupos editoriales EXACTOS (tu regla)
const CAPS_THEATRE = {
  nave10: 2,
  "cdn-maria-guerrero": 1,
  "cdn-valle-inclan": 2,
  teatrodelbarrio: 1,
  pradillo: 1,
  teatroespanol: 1,
  canal: 2,
  matadero: 0 // Matadero NO entra en Cartelera (irá a otras cards)
};

// Danza (solo Canal)
const CAPS_DANCE = {
  canal: 2
};

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

        // Redirects
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
      await sleep(400 * (i + 1));
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

/* --------- Fechas: parse endDate desde dateText (best-effort) --------- */

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
  diciembre: 11
};

function normMonthKey(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function parseSpanishEndDate(dateText) {
  const s = normSpace(dateText).toLowerCase();
  if (!s) return "";

  // "Del 12 al 15 de febrero de 2026" => end = 15 feb 2026 23:59:59
  let m = s.match(
    /\bdel\s+(\d{1,2})\s+al\s+(\d{1,2})\s+de\s+([a-záéíóúñ]+)\s+de\s+(\d{4})\b/i
  );
  if (m) {
    const d2 = Number(m[2]);
    const mon = MONTHS[normMonthKey(m[3])];
    const y = Number(m[4]);
    if (Number.isFinite(mon)) return new Date(y, mon, d2, 23, 59, 59).toISOString();
  }

  // "12 de febrero de 2026" => end = ese día 23:59:59
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
  // NO venta entradas: no incluimos offers/tickets nunca.
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

/* =========================================================
   Selector plural por cupos
   ========================================================= */

function pickWithCaps(items, totalMax, capsBySource) {
  const sorted = sortByEndThenStart(items);
  const picked = [];
  const counts = new Map();

  // 1) Primera pasada: cupos estrictos por fuente (curación dura)
  for (const it of sorted) {
    if (picked.length >= totalMax) break;
    const src = it.source || "other";

    if (!(src in capsBySource)) continue;         // fuente no permitida
    const cap = capsBySource[src];
    if (cap === 0) continue;                       // excluida
    const n = counts.get(src) || 0;
    if (n >= cap) continue;

    // dedupe por link
    if (picked.some((p) => p.link && it.link && p.link === it.link)) continue;

    picked.push(it);
    counts.set(src, n + 1);
  }

  // 2) Relleno controlado: solo fuentes permitidas, sin monopolios
  // (si falla Valle-Inclán o Canal, rellenamos con el resto, pero sin dar más a Nave10)
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
      const hard = src === "nave10" ? baseCap : baseCap + 1; // Nave10 NO recibe extra

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
   FUENTES (CARTELERA)
   ========================================================= */

/**
 * A) CDN (Valle-Inclán / María Guerrero)
 * WP AJAX JSON:
 * POST https://dramatico.inaem.gob.es/wp-admin/admin-ajax.php
 * action=get-cdn-events mes/year
 *
 * Nota: el endpoint NO filtra por sede; venueKey aquí es etiqueta.
 */
async function scrapeCDNMonth({ venueKey, venueName }, month, year, errors) {
  const url = "https://dramatico.inaem.gob.es/wp-admin/admin-ajax.php";
  const body = new URLSearchParams({
    action: "get-cdn-events",
    mes: String(month),
    year: String(year)
  }).toString();

  const json = await fetchJsonSafe(
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
    { tries: 3 }
  );

  const out = [];
  const days = Array.isArray(json?.response) ? json.response : [];
  for (const day of days) {
    const eventos = Array.isArray(day?.eventos) ? day.eventos : [];
    for (const ev of eventos) {
      const title = normSpace(ev?.titulo);
      const link = ev?.url ? String(ev.url) : "";
      if (!title || !link) continue;

      // localizacion trae HTML: "Teatro X | Sala Y"
      const locTxt = stripHtml(ev?.localizacion || "");
      const parts = locTxt.split("|").map((x) => normSpace(x)).filter(Boolean);
      const space = parts.length >= 2 ? parts[parts.length - 1] : "";

      out.push({
        source: venueKey,
        kind: "theatre",
        title,
        credits: stripHtml(ev?.subtitulo || ""),
        deck: "",
        startDate: "",
        endDate: "",
        dateText: "",
        venue: venueName,
        address: "C. de Plazuela de Ana Diosdado, 1, Madrid",
        mapsQuery: `${venueName}, Madrid`,
        mapsUrl: toMapsUrl(`${venueName}, Madrid`),
        link,
        image: "",
        _space: space
      });
    }
  }

  return dedupeBy(out, (x) => x.link);
}

async function scrapeCDN(errors) {
  const venues = [
    { venueKey: "cdn-valle-inclan", venueName: "Teatro Valle-Inclán" },
    { venueKey: "cdn-maria-guerrero", venueName: "Teatro María Guerrero" }
  ];

  // dos meses: actual + siguiente
  const now = new Date();
  const y1 = now.getFullYear();
  const m1 = now.getMonth() + 1;
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const y2 = next.getFullYear();
  const m2 = next.getMonth() + 1;

  const out = [];
  for (const v of venues) {
    try {
      const a = await scrapeCDNMonth(v, m1, y1, errors);
      const b = await scrapeCDNMonth(v, m2, y2, errors);
      out.push(...a, ...b);
    } catch (e) {
      errors.push({
        source: "cdn",
        venue: v.venueKey,
        message: String(e?.message || e)
      });
    }
  }

  // Dedupe por "obra" (source + title)
  const byWork = new Map();
  for (const it of out) {
    const k = `${it.source}__${it.title}`;
    if (!byWork.has(k)) byWork.set(k, it);
  }
  return [...byWork.values()];
}

/**
 * B) Teatros del Canal (best-effort AJAX)
 * Si hay 403 en Actions: devolvemos [] y seguimos (sin inventar).
 */
async function scrapeCanalSection(section, errors) {
  const url = "https://www.teatroscanal.com/wp-admin/admin-ajax.php";
  const body = new URLSearchParams({
    action: "get_todos_espectaculos",
    section,
    page: "1",
    ppp: "24"
  }).toString();

  const res = await requestWithRetry(
    url,
    {
      method: "POST",
      headers: {
        accept: "text/html, */*;q=0.8",
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "x-requested-with": "XMLHttpRequest",
        origin: "https://www.teatroscanal.com",
        referer: "https://www.teatroscanal.com/"
      },
      body
    },
    { tries: 2, allowStatuses: [403] }
  );

  if (res.status === 403) {
    errors.push({
      source: "canal",
      venue: `admin-ajax:${section}`,
      message: "403 (bloqueo a GitHub Actions). Canal omitido esta vez."
    });
    return [];
  }

  const html = res.text();
  const $ = cheerio.load(html);

  const cards = $("a")
    .map((_, a) => {
      const href = $(a).attr("href");
      const text = normSpace($(a).text());
      if (!href) return null;
      if (!/^https?:\/\//.test(href)) return null;
      if (!/teatroscanal\.com/.test(href)) return null;

      const $card = $(a).closest("article,div");
      const title = normSpace($card.find("h3,h2,.title").first().text()) || text || null;
      if (!title) return null;

      const img = $card.find("img").first().attr("src") || "";
      const rawTxt = normSpace($card.text());

      const dateTextMatch = rawTxt.match(
        /(\b\d{1,2}\s+de\s+\w+\s+de\s+\d{4}\b)|(\bDel\s+\d{1,2}\s+al\s+\d{1,2}\s+de\s+\w+\s+de\s+\d{4}\b)|(\b\d{1,2}\s+y\s+\d{1,2}\s+de\s+\w+\s+de\s+\d{4}\b)/i
      );
      const dateText = dateTextMatch ? normSpace(dateTextMatch[0]) : "";

      return { title, link: href, image: img, dateText };
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
    startDate: "",
    endDate: parseSpanishEndDate(c.dateText || ""),
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
 * C) Nave 10 (JSON-LD por evento)
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
  const events = arr.filter((o) => o && typeof o === "object" && /Event$/i.test(String(o["@type"] || "")));
  if (events.length) return events[0];
  return arr.find((o) => o && typeof o === "object" && o.name && o.url) || null;
}

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
    } catch (e) {
      errors.push({ source: "nave10", venue: "activity", message: String(e?.message || e) });
    }
  }
  return out;
}

/**
 * D) Matadero TEATRO adulto — NO entra en Cartelera (lo dejamos aquí por si en el futuro lo reactivas)
 * Devuelve [] por diseño editorial.
 */
async function scrapeMataderoTheatreDisabled() {
  return [];
}

/**
 * E) Teatro Pradillo (Divi)
 */
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

/**
 * F) Teatro del Barrio (Elementor)
 */
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

/**
 * G) Teatro Español (HTML /programacion) — (por ahora)
 * (Si quieres blindaje total, lo migramos a Drupal Views AJAX en el siguiente paso.)
 */
async function scrapeTeatroEspanol(errors) {
  const base = "https://www.teatroespanol.es";
  const url = `${base}/programacion`;
  const html = await fetchText(url);
  const $ = cheerio.load(html);

  const items = $("div.views-row")
    .map((_, el) => {
      const $row = $(el);

      const $titleA = $row.find(".show-content .title a").first();
      const title = normSpace($titleA.text());
      const href = $titleA.attr("href") || "";
      const link = href ? (href.startsWith("http") ? href : `${base}${href}`) : "";
      if (!title || !link) return null;

      const subtitle = normSpace($row.find(".field--name-field-secondary-subtitle").first().text());
      const where = normSpace($row.find(".field--name-field-location").first().text());

      const dateText = normSpace($row.find(".date-range").first().text());
      const endDate = parseSpanishEndDate(dateText);

      const img = $row.find(".show-image img").first().attr("src") || "";
      const image = img ? (img.startsWith("http") ? img : `${base}${img}`) : "";

      const venue = "Teatro Español";
      const address = "Pl. de Santa Ana, 4, Madrid";

      return {
        source: "teatroespanol",
        kind: "theatre",
        title,
        credits: subtitle ? subtitle : "",
        deck: where ? where : "",
        startDate: "",
        endDate,
        dateText,
        venue,
        address,
        mapsQuery: `${venue}, ${address}`,
        mapsUrl: toMapsUrl(`${venue}, ${address}`),
        link,
        image
      };
    })
    .get()
    .filter(Boolean);

  return dedupeBy(items, (x) => x.link);
}

/* =========================================================
   MAIN
   ========================================================= */

async function main() {
  const errors = [];

  const theatre = [];
  const dance = [];

  // 1) CDN (Valle + María)
  theatre.push(...(await scrapeCDN(errors)));

  // 2) Canal (teatro + danza) (best-effort; si 403, queda 0)
  theatre.push(...(await scrapeCanalSection("teatro", errors)));
  dance.push(...(await scrapeCanalSection("danza", errors)));

  // 3) Nave10 (sí) + Matadero (NO en Cartelera)
  theatre.push(...(await scrapeNave10Theatre(errors)));
  theatre.push(...(await scrapeMataderoTheatreDisabled()));

  // 4) Español, Pradillo, Barrio
  theatre.push(...(await scrapeTeatroEspanol(errors)));
  theatre.push(...(await scrapePradillo(errors)));
  theatre.push(...(await scrapeTeatroDelBarrio(errors)));

  // Dedupe fuerte
  const theatreUnique = dedupeBy(theatre, (x) => x.link || `${x.source}:${x.title}`);
  const danceUnique = dedupeBy(dance, (x) => x.link || `${x.source}:${x.title}`);

  // Rotación (vencidos fuera)
  const nowMs = Date.now();
  const theatreActive = theatreUnique.filter((it) => !isExpired(it, nowMs));
  const danceActive = danceUnique.filter((it) => !isExpired(it, nowMs));

  // Selección plural por cupos + orden por endDate
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
      caps: {
        theatre: CAPS_THEATRE,
        dance: CAPS_DANCE
      },
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

