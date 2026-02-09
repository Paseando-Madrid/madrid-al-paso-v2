/**
 * scripts/update-expo.js
 * Genera: data/agenda-monthly.json
 * Fuente: Open Data esMadrid (XML) — agenda_v1_es.xml
 * Estructura: <serviceList><service>...</service></serviceList>
 *
 * Objetivo EXPO (Cooltura):
 * - 8 expos máx.
 * - Prioridad por sedes (Telefónica, Mapfre, CBA, CaixaForum, Matadero, Casa Encendida, COAM, etc.)
 * - Anti-ruido duro (deporte, conciertos, teatro, etc.)
 * - Venue = nombre del centro / sede
 * - Address = calle + número
 * - Decode HTML entities en title
 */

import fs from "fs";
import { XMLParser } from "fast-xml-parser";

const FEED_URL = "https://www.esmadrid.com/opendata/agenda_v1_es.xml";

/* ================== Helpers ================== */
function safeText(v){ return (v ?? "").toString().trim(); }
function norm(s){
  return safeText(s)
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function toArray(v){ return Array.isArray(v) ? v : v ? [v] : []; }

function decodeHtmlEntities(str){
  return safeText(str)
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&aacute;/g, "á").replace(/&eacute;/g, "é").replace(/&iacute;/g, "í").replace(/&oacute;/g, "ó").replace(/&uacute;/g, "ú")
    .replace(/&Aacute;/g, "Á").replace(/&Eacute;/g, "É").replace(/&Iacute;/g, "Í").replace(/&Oacute;/g, "Ó").replace(/&Uacute;/g, "Ú")
    .replace(/&ntilde;/g, "ñ").replace(/&Ntilde;/g, "Ñ");
}

function deepStrings(obj, out = []){
  if (!obj) return out;
  if (typeof obj === "string" || typeof obj === "number") { out.push(String(obj)); return out; }
  if (Array.isArray(obj)) { obj.forEach(x => deepStrings(x, out)); return out; }
  if (typeof obj === "object") { Object.values(obj).forEach(v => deepStrings(v, out)); }
  return out;
}

function mapsUrlFromQuery(q){
  const s = safeText(q);
  return s ? `https://www.google.com/maps?q=${encodeURIComponent(s)}` : "";
}

/**
 * Busca la primera coincidencia deep de una clave (por nombre exacto)
 * Útil porque el XML viene anidado.
 */
function pickDeepByKeys(obj, keys){
  const keySet = new Set(keys);
  let found = "";
  (function walk(x){
    if(found) return;
    if(!x) return;
    if(Array.isArray(x)){ x.forEach(walk); return; }
    if(typeof x === "object"){
      for(const [k,v] of Object.entries(x)){
        if(found) return;
        if(keySet.has(k)){
          const s = safeText(v);
          if(s) { found = s; return; }
        }
        walk(v);
      }
    }
  })(obj);
  return found;
}

/* ================== Editorial ================== */
// Sedes preferidas (ranking)
const VENUE_PRIORITY = [
  "fundación telefónica",
  "espacio fundación telefónica",
  "fundación mapfre",
  "coam",
  "casa encendida",
  "la casa encendida",
  "círculo de bellas artes",
  "matadero",
  "caixaforum",
  "tabacalera",
  "conde duque",
  "condeduque",
  "centrocentro",
  "centro centro",
  "centrocentro cibeles",
  "centro centro"
].map(norm);

// Señales expo
const EXPO_KEYS = [
  "exposición","exposicion","exposiciones",
  "muestra","retrospectiva",
  "instalación","instalacion",
  "fotografía","fotografia",
  "colección","coleccion",
  "arte","galería","galeria",
  "contemporáneo","contemporaneo"
].map(norm);

// Anti-ruido duro (incluye deporte)
const EXCLUDE_KEYS = [
  "atlético","atletico","real madrid","copa","liga","partido","semifinal","ida","vuelta",
  "fútbol","futbol","baloncesto","tenis","atletismo",
  "concierto","gira","tour","dj","sesión","session","club",
  "teatro","musical","ópera","opera","danza","performance",
  "taller","workshop","curso","clase",
  "ruta","visita guiada","tour guiado"
].map(norm);

// Inferencia de sede desde URL (cuando no viene clara)
function inferVenueFromUrl(url){
  const u = norm(url || "");
  const rules = [
    ["fundacion-telefonica", "Fundación Telefónica"],
    ["fundacion-mapfre", "Fundación MAPFRE"],
    ["circulo-bellas-artes", "Círculo de Bellas Artes"],
    ["casa-encendida", "La Casa Encendida"],
    ["matadero", "Matadero"],
    ["caixaforum", "CaixaForum"],
    ["tabacalera", "Tabacalera"],
    ["conde-duque", "CondeDuque"],
    ["condeduque", "CondeDuque"],
    ["centrocentro", "CentroCentro"],
    ["alcala-31", "Sala Alcalá 31"]
  ];
  for (const [needle, label] of rules){
    if(u.includes(needle)) return label;
  }
  return "";
}

function isExpoCandidate(h){
  return EXPO_KEYS.some(k => h.includes(k)) || VENUE_PRIORITY.some(v => h.includes(v));
}

function isExcluded(h){
  return EXCLUDE_KEYS.some(k => h.includes(k));
}

function scoreItem({ title, venue, url, hay }){
  let s = 0;
  const t = norm(title);
  const v = norm(venue);
  const u = norm(url);
  const h = norm(hay);

  // sedes prioridad
  if (VENUE_PRIORITY.some(p => v.includes(p))) s += 40;
  if (VENUE_PRIORITY.some(p => h.includes(p))) s += 18;

  // señales expo
  if (t.includes("fotograf")) s += 10;
  if (EXPO_KEYS.some(k => t.includes(k))) s += 6;

  // penalizaciones
  if (!venue) s -= 6;
  if (isExcluded(h) || isExcluded(t) || isExcluded(u)) s -= 200;

  return s;
}

/* ================== Main ================== */
async function main(){
  const res = await fetch(FEED_URL);
  if (!res.ok) throw new Error(`Feed fetch failed: ${res.status}`);

  const xml = await res.text();
  const parser = new XMLParser({ ignoreAttributes:false });
  const parsed = parser.parse(xml);

  const services = toArray(parsed?.serviceList?.service);
  console.log("Total raw services:", services.length);

  const candidates = services.map(s => {
    const titleRaw = safeText(s?.basicData?.name);
    const url = safeText(s?.basicData?.web);

    if (!titleRaw || !url) return null;

    const title = decodeHtmlEntities(titleRaw);

    // Dirección (geoData.address suele ser "de Alcalá, 42")
    const address = safeText(s?.geoData?.address);

    // Intento de sede (muchas veces viene en basicData.relatedService / basicData.entity / organization...)
    let venue =
      pickDeepByKeys(s, ["organization", "organizacion", "entity", "entidad", "place", "lugar", "venue", "centro", "espacio"]) ||
      "";

    // Si venue viene vacío o parece una calle ("de Alcalá, 42"), inferimos por URL
    if (!venue || norm(venue).includes("de ") || /\d/.test(venue)) {
      const inferred = inferVenueFromUrl(url);
      if (inferred) venue = inferred;
    }

    // Haystack completo
    const hay = norm(deepStrings(s).join(" | "));

    // filtros EXPO + anti-ruido
    if (!isExpoCandidate(hay)) return null;
    if (isExcluded(hay) || isExcluded(title) || isExcluded(url)) return null;

    // Si venue sigue pareciendo dirección, lo dejamos vacío y usamos address para maps
    const venueLooksAddress = venue && (/\d/.test(venue) || norm(venue).startsWith("de "));
    const venueFinal = venueLooksAddress ? "" : venue;

    const mapsQuery = [venueFinal || title, address, "Madrid"].filter(Boolean).join(", ");
    const mapsUrl = mapsUrlFromQuery(mapsQuery);

    return { title, venue: venueFinal, address, dateText:"", url, mapsUrl, _hay: hay };
  }).filter(Boolean);

  console.log("Expo candidates:", candidates.length);

  // ranking + dedup
  const seen = new Set();
  const ranked = candidates
    .map(it => ({ ...it, _score: scoreItem({ title: it.title, venue: it.venue, url: it.url, hay: it._hay }) }))
    .sort((a,b) => b._score - a._score)
    .filter(it => {
      const key = norm(`${it.title}__${it.venue || it.address}`);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 8)
    .map(({ _score, _hay, ...rest }) => rest);

  const out = {
    updatedAt: new Date().toISOString(),
    groups: [
      {
        category: "exhibitions",
        deck: "Selección automática desde la agenda cultural de Madrid (curada por prioridad editorial).",
        items: ranked
      },
      {
        category: "theatre",
        deck: "Pendiente de automatización (siguiente paso).",
        items: []
      }
    ]
  };

  fs.mkdirSync("data", { recursive:true });
  fs.writeFileSync("data/agenda-monthly.json", JSON.stringify(out, null, 2), "utf8");

  console.log("Expo updated:", ranked.length, "items");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

