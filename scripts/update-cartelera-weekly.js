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
import * as cheerio from "cheerio";

const OUT_PATH = path.join(process.cwd(), "data", "cartelera-weekly.json");

const LIMITS = {
  theatreMax: 10, // total teatro (no más de 12 sumando danza)
  danceMax: 3
};

const UA =
  "Mozilla/5.0 (compatible; PaseandoMadridBot/1.0; +https://paseando-madrid.github.io/)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(url, opts = {}, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        redirect: "follow",
        headers: {
          "user-agent": UA,
          ...(opts.headers || {})
        },
        ...opts
      });
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
  const res = await fetchWithRetry(url, opts);
  return await res.text();
}

// (No se usa ahora, pero lo dejo por si ampliamos fuentes)
async function fetchJson(url, opts) {
  const res = await fetchWithRetry(url, opts);
  return await res.json();
}

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

  // fallback: algunos meten el Event como único objeto en array
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

  // Expo suele ir por términos / sedes, pero aquí lo usamos solo para filtrar teatro adulto:
  // Si loc sugiere "naves" o "nave 10" lo tratamos como teatro adulto.
  if (/\b(naves|nave 10)\b/.test(loc)) return "theatre";

  // si no, lo dejamos fuera (se tratará en expo/otros scrapers)
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
  });

  const html = await fetchText(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body
  });

  const $ = cheerio.load(html);

  // Estructura: tarjetas con enlaces e imágenes (varía). Vamos a lo robusto:
  const cards = $("a")
    .map((_, a) => {
      const href = $(a).attr("href");
      const text = normSpace($(a).text());
      if (!href) return null;

      // buscamos anclas que parezcan ficha
      if (!/^https?:\/\//.test(href)) return null;
      if (!/teatroscanal\.com/.test(href)) return null;

      // subir al contenedor para encontrar título/fecha/imagen
      const $card = $(a).closest("div");
      const title =
        normSpace($card.find("h3,h2,.title").first().text()) || text || null;

      if (!title) return null;

      // imagen
      const img = $card.find("img").first().attr("src") || null;

      // fecha: cualquier línea que contenga mes / año
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

  // Limpieza: dedupe por link
  const unique = dedupeBy(cards, (c) => c.link);

  // No metemos venta entradas: se ignora cualquier CTA
  return unique.map((c) => ({
    source: "canal",
    kind: section === "danza" ? "dance" : "theatre",
    title: c.title,
    credits: "", // se completa luego si scrapeamos detalle (opcional)
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
      credits: "", // se puede enriquecer en fase 2 (autor/dirección si aparecen en HTML)
      deck,
      startDate: ev.startDate || "",
      endDate: ev.endDate || "",
      dateText: "", // opcional: se formatea en renderer
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
  const listUrl = "https://www.mataderomadrid.org/programacion?f%5B0%5D=category%3A185";
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
      credits: "", // fase 2: autor/dirección si se extrae de HTML
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
  // Orden editorial simple: por proximidad de startDate si existe, si no deja estable.
  // (Se ajusta luego con reglas más finas por sede)
  const parse = (s) => {
    const t = Date.parse(s || "");
    return Number.isFinite(t) ? t : Infinity;
  };
  return [...items].sort((a, b) => parse(a.startDate) - parse(b.startDate));
}

function sanitizeForOutput(it) {
  // No queremos venta entradas: eliminamos cualquier url de offers/tickets aunque venga
  // (no la incluimos en nuestro schema final)
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

  // 1) CANAL (teatro + danza)
  const canalTheatre = await scrapeCanalSection("teatro");
  const canalDance = await scrapeCanalSection("danza");

  // 2) NAVE 10 (teatro)
  const nave10 = await scrapeNave10Theatre();

  // 3) MATADERO teatro adulto (filtro)
  const mataderoTheatre = await scrapeMataderoTheatre();

  // Composición inicial (más sedes vendrán en siguientes scrapers: Pradillo, Barrio, Español, Cuarta Pared)
  theatre.push(...canalTheatre, ...nave10, ...mataderoTheatre);
  dance.push(...canalDance);

  // Dedupe por link + título
  const theatreUnique = dedupeBy(theatre, (x) => x.link || `${x.source}:${x.title}`);
  const danceUnique = dedupeBy(dance, (x) => x.link || `${x.source}:${x.title}`);

  // Orden editorial (simple) + cupos
  const theatreFinal = cap(sortEditorial(theatreUnique), LIMITS.theatreMax).map(
    sanitizeForOutput
  );
  const danceFinal = cap(sortEditorial(danceUnique), LIMITS.danceMax).map(sanitizeForOutput);

  const out = {
    updatedAt: new Date().toISOString(),
    theatre: theatreFinal,
    dance: danceFinal,
    meta: {
      limits: LIMITS
    }
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

