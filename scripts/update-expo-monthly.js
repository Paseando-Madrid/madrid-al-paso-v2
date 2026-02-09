/**
 * scripts/update-expo.js
 * Genera: data/agenda-monthly.json
 * Fuente: Open Data esMadrid (XML)
 * Objetivo: exposiciones curadas por sedes + fotografía, con pin (mapsUrl).
 */

import fs from "fs";
import { XMLParser } from "fast-xml-parser";

const FEED_URL = "https://www.esmadrid.com/opendata/agenda_v1_es.xml";

/* ====== Prioridad editorial de sedes (las que definimos) ====== */
const VENUE_PRIORITY = [
  "fundación telefónica",
  "espacio fundación telefónica",
  "fundacion telefonica",
  "fundación mapfre",
  "fundacion mapfre",
  "coam",
  "colegio oficial de arquitectos",
  "colegio oficial de arquitectos de madrid",
  "casa encendida",
  "la casa encendida",
  "círculo de bellas artes",
  "circulo de bellas artes",
  "matadero",
  "caixaforum",
  "caixa forum",
  "tabacalera",
  "condeduque",
  "centrocentro"
].map(s => norm(s));

/* ====== Keywords EXPO (más estrictas) ====== */
const EXPO_KEYS = [
  "exposición", "exposicion", "exposiciones",
  "fotografía", "fotografia",
  "muestra", "retrospectiva", "instalación", "instalacion",
  "comisari", "colección", "coleccion",
  "arte", "galería", "galeria"
].map(s => norm(s));

/* ====== Anti-ruido (lo que NO queremos en EXPO) ====== */
const EXCLUDE_KEYS = [
  "fútbol", "futbol", "baloncesto", "tenis",
  "atlético", "atletico", "real madrid", "copa", "liga",
  "concierto", "gira", "tour", "entradas",
  "teatro", "musical", "ópera", "opera", "danza",
  "partido", "semifinal", "ida", "vuelta"
].map(s => norm(s));

/* ================= Helpers ================= */

function safeText(v){ return (v ?? "").toString().trim(); }

function norm(s){
  return safeText(s)
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function decodeHtmlEntities(str){
  // Para casos tipo &iexcl; &ordm; &ntilde; etc. sin meter librerías
  return safeText(str)
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&aacute;/g, "á").replace(/&eacute;/g, "é").replace(/&iacute;/g, "í").replace(/&oacute;/g, "ó").replace(/&uacute;/g, "ú")
    .replace(/&Aacute;/g, "Á").replace(/&Eacute;/g, "É").replace(/&Iacute;/g, "Í").replace(/&Oacute;/g, "Ó").replace(/&Uacute;/g, "Ú")
    .replace(/&ntilde;/g, "ñ").replace(/&Ntilde;/g, "Ñ")
    .replace(/&ordm;/g, "º")
    .replace(/&iexcl;/g, "¡")
    .replace(/&iquest;/g, "¿");
}

function toArray(v){
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function pickFirst(obj, keys){
  for (const k of keys){
    const v = obj?.[k];
    if (v !== undefined && v !== null && safeText(v) !== "") return v;
  }
  return "";
}

function deepStrings(obj, out = []){
  if (!obj) return out;
  if (typeof obj === "string" || typeof obj === "number") { out.push(String(obj)); return out; }
  if (Array.isArray(obj)) { obj.forEach(x => deepStrings(x, out)); return out; }
  if (typeof obj === "object") { Object.values(obj).forEach(v => deepStrings(v, out)); }
  return out;
}

function toISODateGuess(v){
  const s = safeText(v);
  if(!s) return null;

  // ISO (yyyy-mm-dd...)
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  // dd/mm/yyyy
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    const dd = m[1].padStart(2, "0");
    const mm = m[2].padStart(2, "0");
    const yyyy = m[3];
    const d = new Date(`${yyyy}-${mm}-${dd}T12:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  // fallback
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function mapsUrlFromQuery(q){
  const query = safeText(q).trim();
  if(!query) return null;
  return `https://www.google.com/maps?q=${encodeURIComponent(query)}`;
}

function pickTitle(ev){
  const raw = pickFirst(ev, ["title", "titulo", "name", "nombre"]);
  return decodeHtmlEntities(raw) || "—";
}

function pickUrl(ev){
  const u = pickFirst(ev, ["url", "link", "enlace", "web"]);
  return safeText(u) || null;
}

function pickDates(ev){
  const startRaw = pickFirst(ev, ["start", "fechaInicio", "fechainicio", "startDate", "dateStart", "inicio", "fecha"]);
  const endRaw   = pickFirst(ev, ["end", "fechaFin", "fechafin", "endDate", "dateEnd", "fin"]);
  return { start: toISODateGuess(startRaw), end: toISODateGuess(endRaw) };
}

function pickVenueLoose(ev){
  // Intentos “típicos” (a veces vienen en nodos raros)
  return safeText(pickFirst(ev, [
    "venue", "lugar", "place", "organizer", "organizador",
    "localizacion", "localización", "location", "centro", "espacio"
  ]));
}

function pickAddressLoose(ev){
  return safeText(pickFirst(ev, ["address", "direccion", "dirección", "streetAddress", "dir"]));
}

function pickExcerpt(ev){
  const desc = pickFirst(ev, ["excerpt", "entradilla", "description", "descripcion", "resumen"]);
  return decodeHtmlEntities(desc);
}

function haystack(ev){
  // Todo el contenido del evento para detectar sedes aunque no venga en un campo "venue"
  return norm(decodeHtmlEntities(deepStrings(ev).join(" | ")));
}

function isExhibition(ev){
  const h = haystack(ev);

  // Debe tener señales de expo
  const hasExpo = EXPO_KEYS.some(k => h.includes(k));
  if(!hasExpo) return false;

  // Y no debe tener señales fuertes de deporte / conciertos / teatro
  const hasExcluded = EXCLUDE_KEYS.some(k => h.includes(k));
  if(hasExcluded) return false;

  return true;
}

function inferVenueFromPriority(ev){
  const h = haystack(ev);
  const hit = VENUE_PRIORITY.find(v => h.includes(v));
  return hit ? hit : "";
}

function titleLooksLikeExpo(title){
  const t = norm(title);
  return EXPO_KEYS.some(k => t.includes(k));
}

function scoreItem(item){
  let s = 0;
  const t = norm(item.title);
  const v = norm(item.venue);

  // foto arriba
  if (t.includes("fotograf")) s += 5;

  // sedes prioridad arriba
  if (v && VENUE_PRIORITY.some(p => v.includes(p))) s += 12;

  // si no tenemos venue, penalizamos
  if (!v) s -= 2;

  // si el título no tiene señales de expo, baja (aun si el evento pasó el filtro por texto)
  if (!titleLooksLikeExpo(item.title)) s -= 1;

  return s;
}

/* ================= Main ================= */

async function main(){
  const res = await fetch(FEED_URL, {
    headers: { "user-agent": "paseandomadrid-bot/1.0" },
    cache: "no-store"
  });
  if (!res.ok) throw new Error(`esmadrid fetch failed: ${res.status}`);

  const xml = await res.text();
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    parseTagValue: true,
    trimValues: true
  });
  const parsed = parser.parse(xml);

  // localizar eventos
  const root = parsed?.agenda ?? parsed?.response ?? parsed;
  const events =
    root?.eventos?.evento ||
    root?.eventos ||
    root?.events?.event ||
    root?.events ||
    root?.evento ||
    [];

  const list = toArray(events);

  // Filtra expos + extrae campos + intenta recuperar venue por prioridad
  const rawExpo = list
    .filter(isExhibition)
    .map(ev => {
      const { start, end } = pickDates(ev);

      // venue/address "loose"
      let venue = pickVenueLoose(ev);
      let address = pickAddressLoose(ev);

      // si viene vacío, intenta inferir por lista de sedes
      if (!venue) {
        const inferred = inferVenueFromPriority(ev);
        venue = inferred ? inferred : "";
      }

      const title = pickTitle(ev);
      const url = pickUrl(ev);

      const mapsQuery = [venue || title, "Madrid"].filter(Boolean).join(", ");
      const mapsUrl = mapsUrlFromQuery(mapsQuery);

      return {
        title,
        venue,
        address: address || "",
        start,
        end,
        url,
        mapsUrl,
        excerpt: pickExcerpt(ev) || ""
      };
    })
    .filter(it => it.url && it.title);

  // Dedup (title+venue)
  const seen = new Set();
  const uniq = [];
  for (const it of rawExpo){
    const key = norm(`${it.title}__${it.venue}`);
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(it);
  }

  // Orden editorial: score desc, luego fecha asc
  const sorted = uniq
    .map(it => ({ ...it, _score: scoreItem(it) }))
    .sort((a,b) => {
      if (b._score !== a._score) return b._score - a._score;
      const ta = a.start ? new Date(a.start).getTime() : Number.MAX_SAFE_INTEGER;
      const tb = b.start ? new Date(b.start).getTime() : Number.MAX_SAFE_INTEGER;
      return ta - tb;
    })
    .slice(0, 8)
    .map(({ _score, ...rest }) => rest);

  const out = {
    updatedAt: new Date().toISOString(),
    groups: [
      {
        category: "exhibitions",
        deck: "Selección automática desde agenda cultural de Madrid (curada por prioridad editorial).",
        items: sorted
      },
      {
        category: "theatre",
        deck: "Pendiente de automatización (siguiente paso).",
        items: []
      }
    ]
  };

  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync("data/agenda-monthly.json", JSON.stringify(out, null, 2), "utf8");

  console.log("Expo updated:", sorted.length, "items");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
