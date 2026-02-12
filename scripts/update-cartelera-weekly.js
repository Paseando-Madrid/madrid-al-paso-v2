/**
 * Update Cartelera (Weekly)
 * - Genera /data/cartelera-weekly.json
 * - Teatro: mezcla multi-sede (cupos), sin venta entradas en salida
 * - Danza: sub-bloque dentro de Cartelera (cupos) (de momento Canal best-effort)
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
  theatreMax: 10, // teatro total
  danceMax: 3     // danza total (sub-bloque)
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
  { method = "GET", headers = {}, body = null, timeoutMs = 20000, maxRedirects = 5 } = {}
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
          "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
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
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timeout after ${timeoutMs}ms for ${urlStr}`)));

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
      await sleep(350 * (i + 1));
    }
  }
  throw lastErr;
}

async function fetchText(url, opts, meta) {
  const res = await requestWithRetry(url, opts, meta);
  return res.text();
}

async function fetchJson(url, opts, meta) {
  const txt = await fetchText(url, opts, meta);
  return JSON.parse(txt);
}

/* ========================================================= */

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

/* ---------------- JSON-LD (Matadero / Nave10) ---------------- */

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

/* =========================================================
   FUENTES (CARTELERA)
   ========================================================= */

/**
 * A) CDN (Valle-Inclán / María Guerrero)
 * Fuente BLINDADA: WordPress AJAX JSON
 * POST https://dramatico.inaem.gob.es/wp-admin/admin-ajax.php
 * action=get-cdn-events mes/year
 */
async function scrapeCDNMonth({ venueKey, venueName }, month, year) {
  const url = "https://dramatico.inaem.gob.es/wp-admin/admin-ajax.php";
  const body = new URLSearchParams({
    action: "get-cdn-events",
    mes: String(month),
    year: String(year)
  }).toString();

  // Esta fuente devuelve JSON directamente
  const json = await fetchJson(
    url,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
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
      // sacamos lo último como sala si existe
      const parts = locTxt.split("|").map((x) => normSpace(x)).filter(Boolean);
      const space = parts.length >= 2 ? parts[parts.length - 1] : "";

      out.push({
        source: venueKey,
        kind: "theatre",
        title,
        credits: "",
        deck: "",
        startDate: "", // CDN da hora/fecha por pases, pero no siempre fecha ISO por obra. Lo dejamos a futuro.
        endDate: "",
        dateText: "", // si quieres, luego lo formateamos por “próximas funciones”
        venue: venueName,
        address: "C. de Plazuela de Ana Diosdado, 1, Madrid", // aproximación (Centro Dramático Nacional)
        mapsQuery: `${venueName}, Madrid`,
        mapsUrl: toMapsUrl(`${venueName}, Madrid`),
        link,
        image: "",
        _space: space,
        _time: ev?.hora ? String(ev.hora) : ""
      });
    }
  }

  // dedupe por link
  return dedupeBy(out, (x) => x.link);
}

async function scrapeCDN() {
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
      const a = await scrapeCDNMonth(v, m1, y1);
      const b = await scrapeCDNMonth(v, m2, y2);
      out.push(...a, ...b);
    } catch (e) {
      console.warn(`[WARN] CDN ${v.venueKey} fallo: ${e?.message || e}`);
    }
  }

  // Aquí vienen pases; vamos a deduplicar por título+venue y quedarnos con “una entrada por obra”
  const byWork = new Map();
  for (const it of out) {
    const k = `${it.source}__${it.title}`;
    if (!byWork.has(k)) byWork.set(k, it);
  }
  return [...byWork.values()];
}

/**
 * B) Teatros del Canal (best-effort)
 * Si hay 403 en Actions: devolvemos [] y seguimos.
 */
async function scrapeCanalSection(section) {
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
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        origin: "https://www.teatroscanal.com",
        referer: "https://www.teatroscanal.com/"
      },
      body
    },
    { tries: 2, allowStatuses: [403] }
  );

  if (res.status === 403) {
    console.warn(`[WARN] Canal 403 (bloqueo a Actions). Se omite Canal esta vez.`);
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

      const $card = $(a).closest("div");
      const title = normSpace($card.find("h3,h2,.title").first().text()) || text || null;
      if (!title) return null;

      const img = $card.find("img").first().attr("src") || "";
      const rawTxt = normSpace($card.text());
      const dateText = rawTxt.match(
        /(\b\d{1,2}\s+de\s+\w+\s+de\s+\d{4}\b)|(\bDel\s+\d{1,2}\s+al\s+\d{1,2}\s+de\s+\w+\s+de\s+\d{4}\b)|(\b\d{1,2}\s+y\s+\d{1,2}\s+de\s+\w+\s+de\s+\d{4}\b)/i
      );
      const dateStr = dateText ? normSpace(dateText[0]) : "";

      return { title, link: href, image: img, dateText: dateStr };
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
 * C) Nave 10 (JSON-LD por evento)
 */
async function scrapeNave10Theatre() {
  const listUrl = "https://www.nave10matadero.es/programacion?field_category%5B14%5D=14";
  const html = await fetchText(listUrl);
  const $ = cheerio.load(html);

  const links = $("a")
    .map((_, a) => $(a).attr("href"))
    .get()
    .filter(Boolean)
    .map((href) => (href.startsWith("http") ? href : `https://www.nave10matadero.es${href}`))
    .filter((href) => /\/actividades\//.test(href));

  const uniqueLinks = [...new Set(links)].slice(0, 14);

  const out = [];
  for (const url of uniqueLinks) {
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
  }
  return out;
}

/**
 * D) Matadero TEATRO adulto (categoría 185) + JSON-LD filtrado
 */
async function scrapeMataderoTheatre() {
  const listUrl = "https://www.mataderomadrid.org/programacion?f%5B0%5D=category%3A185";
  const html = await fetchText(listUrl);
  const $ = cheerio.load(html);

  const links = $("a.field-group-link, a.field-group-link[href]")
    .map((_, a) => $(a).attr("href"))
    .get()
    .filter(Boolean)
    .map((href) => (href.startsWith("http") ? href : `https://www.mataderomadrid.org${href}`))
    .filter((href) => /\/programacion\//.test(href));

  const uniqueLinks = [...new Set(links)].slice(0, 18);

  const out = [];
  for (const url of uniqueLinks) {
    const page = await fetchText(url);
    const jsonLd = extractJsonLdObjects(page);
    const ev = pickEventFromJsonLd(jsonLd);
    if (!ev?.name) continue;

    const locationName = ev.location?.name || "";
    const desc = stripHtml(ev.description || "");
    const cls = classifyMataderoEvent({ name: ev.name, description: desc, locationName });
    if (cls !== "theatre") continue;

    out.push({
      source: "matadero",
      kind: "theatre",
      title: normSpace(ev.name),
      credits: "",
      deck: pickFirstSentence(desc, 210),
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
 * E) Teatro Pradillo (Divi)
 * items en article.et_pb_post
 */
async function scrapePradillo() {
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

      const img = $(el).find(".et_pb_image_container img").first().attr("src") || "";

      return {
        source: "pradillo",
        kind: "theatre",
        title,
        credits: "",
        deck: "",
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
 * cards en div.article[id^="post-"]
 */
async function scrapeTeatroDelBarrio() {
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

      // imagen: background-image inline en .image-wrap
      const style = $(el).find(".image-wrap").first().attr("style") || "";
      const m = style.match(/background-image:\s*url\(["']?([^"')]+)["']?\)/i);
      const image = m ? m[1] : "";

      return {
        source: "teatrodelbarrio",
        kind: "theatre",
        title,
        credits: "",
        deck: "",
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
 * G) Teatro Español (HTML /programacion)
 * Estructura robusta: div.views-row con:
 * - show-content .title a
 * - .date-range
 * - location text
 * - tickets link (IGNORADO)
 */
async function scrapeTeatroEspanol() {
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

      // date-range: texto limpio (editorial)
      const dateText = normSpace($row.find(".date-range").first().text());

      // imagen (si está)
      const img = $row.find(".show-image img").first().attr("src") || "";
      const image = img ? (img.startsWith("http") ? img : `${base}${img}`) : "";

      const credits = subtitle ? subtitle : "";
      const venue = "Teatro Español";
      const address = "Pl. de Santa Ana, 4, Madrid";

      return {
        source: "teatroespanol",
        kind: "theatre",
        title,
        credits,
        deck: where ? where : "",
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
   SELECCIÓN / CUPO
   ========================================================= */

function cap(items, max) {
  return items.slice(0, Math.max(0, max));
}

function sortEditorial(items) {
  const parse = (s) => {
    const t = Date.parse(s || "");
    return Number.isFinite(t) ? t : Infinity;
  };
  // Si no hay startDate, mantenemos estable (Infinity)
  return [...items].sort((a, b) => parse(a.startDate) - parse(b.startDate));
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

async function main() {
  const theatre = [];
  const dance = [];

  // 1) CDN (Valle-Inclán + María Guerrero)
  const cdn = await scrapeCDN();
  theatre.push(...cdn);

  // 2) Canal (best-effort) -> teatro + danza
  const canalTheatre = await scrapeCanalSection("teatro");
  const canalDance = await scrapeCanalSection("danza");
  theatre.push(...canalTheatre);
  dance.push(...canalDance);

  // 3) Nave10 + Matadero
  theatre.push(...(await scrapeNave10Theatre()));
  theatre.push(...(await scrapeMataderoTheatre()));

  // 4) Español, Pradillo, Barrio
  theatre.push(...(await scrapeTeatroEspanol()));
  theatre.push(...(await scrapePradillo()));
  theatre.push(...(await scrapeTeatroDelBarrio()));

  // Dedupe
  const theatreUnique = dedupeBy(theatre, (x) => x.link || `${x.source}:${x.title}`);
  const danceUnique = dedupeBy(dance, (x) => x.link || `${x.source}:${x.title}`);

  // Orden + cupos
  const theatreFinal = cap(sortEditorial(theatreUnique), LIMITS.theatreMax).map(sanitizeForOutput);
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
  console.log(
    `Sources in theatre: ${[...new Set(theatreFinal.map((x) => x.source))].join(", ")}`
  );
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
