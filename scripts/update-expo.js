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
 * - Venue = nombre del centro / sede (institucional)
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
/**
 * ✅ VENUE_RULES exactas por URL (slugs reales de esMadrid y/o fichas oficiales).
 * Orden importa: lo específico primero, lo genérico al final.
 */
const VENUE_RULES = [
  // Fundación Telefónica
  ["espacio-fundacion-telefonica", "Fundación Telefónica"],
  ["fundacion-telefonica", "Fundación Telefónica"],

  // Fundación MAPFRE (Sala Recoletos)
  ["fundacion-mapfre-sala-recoletos", "Fundación MAPFRE (Sala Recoletos)"],
  ["fundacion-mapfre", "Fundación MAPFRE"],

  // Círculo de Bellas Artes
  ["circulo-bellas-artes", "Círculo de Bellas Artes"],

  // CaixaForum
  ["caixaforum-madrid", "CaixaForum Madrid"],
  ["caixaforum", "CaixaForum Madrid"],

  // Matadero
  ["matadero-madrid", "Matadero Madrid"],
  ["matadero", "Matadero Madrid"],

  // La Casa Encendida (variantes reales)
  ["la-casa-encendida", "La Casa Encendida"],
  ["casa-encendida", "La Casa Encendida"],

  // COAM (variantes reales de agenda)
  ["servicio-historico-coam", "COAM"],
  ["matcoam-coam", "COAM"],
  // ⚠️ menos genérico (evita falsos positivos)
  ["-coam-", "COAM"],

  // CentroCentro
  ["centro-centro", "CentroCentro"],
  ["centrocentro", "CentroCentro"],

  // Sala Alcalá 31
  ["sala-alcala-31", "Sala Alcalá 31"],
  ["alcala-31", "Sala Alcalá 31"],

  // CondeDuque
  ["conde-duque", "CondeDuque"],
  ["condeduque", "CondeDuque"],

  // Tabacalera
  ["tabacalera-promocion-arte", "Tabacalera Promoción del Arte"],
  ["csa-tabacalera-lavapies", "CSA La Tabacalera (Lavapiés)"],
  ["tabacalera", "Tabacalera"],
];

function inferVenueFromUrl(url){
  const u = (url || "").toLowerCase();
  for (const [needle, label] of VENUE_RULES){
    if (u.includes(needle)) return label;
  }
  return "";
}

/**
 * Lista “válida” (para scoring y para el filtro institucional).
 */
const VALID_VENUES = new Set([
  "Fundación Telefónica",
  "Fundación MAPFRE",
  "Fundación MAPFRE (Sala Recoletos)",
  "Círculo de Bellas Artes",
  "CaixaForum Madrid",
  "Matadero Madrid",
  "La Casa Encendida",
  "COAM",
  "CentroCentro",
  "CondeDuque",
  "Sala Alcalá 31",
  "Tabacalera Promoción del Arte",
  "CSA La Tabacalera (Lavapiés)",
  "Tabacalera",
]);

const VENUE_PRIORITY = [
  "fundacion telefonica",
  "fundacion mapfre",
  "circulo de bellas artes",
  "caixaforum madrid",
  "matadero madrid",
  "la casa encendida",
  "coam",
  "centrocentro",
  "condeduque",
  "sala alcala 31",
  "tabacalera"
].map(norm);

// Señales expo (suaves)
const EXPO_KEYS = [
  "exposición","exposicion","exposiciones",
  "muestra","retrospectiva",
  "instalación","instalacion",
  "fotografía","fotografia",
  "colección","coleccion",
  "arte","galería","galeria",
  "contemporáneo","contemporaneo"
].map(norm);

// Anti-ruido duro
const EXCLUDE_KEYS = [
  // deporte
  "atlético","atletico","real madrid","copa","liga","partido","semifinal","ida","vuelta",
  "fútbol","futbol","baloncesto","tenis","atletismo",
  // música/escena
  "concierto","gira","tour","dj","sesión","session","club",
  "teatro","musical","ópera","opera","danza","performance",
  // eventos/planes no-expo
  "semana santa","saetas","mercado","juguete","feria","rastrillo",
  "tren","trenes","historico","históricos",
  // formación / actividades
  "taller","workshop","curso","clase",
  "ruta","visita guiada","tour guiado"
].map(norm);

function isExcluded(text){
  const x = norm(text);
  return EXCLUDE_KEYS.some(k => x.includes(k));
}

function hasExpoSignals(text){
  const x = norm(text);
  return EXPO_KEYS.some(k => x.includes(k));
}

function scoreItem({ title, venue, url, hay }){
  let s = 0;
  const t = norm(title);
  const v = norm(venue);
  const u = norm(url);
  const h = norm(hay);

  if (VENUE_PRIORITY.some(p => v.includes(p))) s += 60;
  if (VENUE_PRIORITY.some(p => h.includes(p))) s += 20;

  if (t.includes("fotograf")) s += 10;
  if (EXPO_KEYS.some(k => t.includes(k))) s += 6;

  // penalizaciones
  if (!venue) s -= 300;
  if (!VALID_VENUES.has(venue)) s -= 300;
  if (isExcluded(h) || isExcluded(t) || isExcluded(u)) s -= 500;

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
    const address = safeText(s?.geoData?.address);
    const hay = norm(deepStrings(s).join(" | "));

    // Anti-ruido primero (siempre)
    if (isExcluded(hay) || isExcluded(title) || isExcluded(url)) return null;

    // ✅ MEJORA: inferimos sede pronto por URL y decidimos si exigimos EXPO_KEYS
    const inferredEarly = inferVenueFromUrl(url);
    const isValidVenueFromUrl = inferredEarly && VALID_VENUES.has(inferredEarly);

    // Señal EXPO mínima:
    // - Si NO hay sede válida por URL, exigimos EXPO_KEYS
    // - Si hay sede válida por URL, permitimos pasar aunque falten EXPO_KEYS (feed "pobre")
    if (!isValidVenueFromUrl) {
      if (!hasExpoSignals(hay) && !hasExpoSignals(title) && !hasExpoSignals(url)) return null;
    }

    // 1) venue por campos (si existe)
    let venue =
      pickDeepByKeys(s, ["venue","lugar","place","centro","espacio","entity","entidad","organization","organizacion"]) ||
      "";

    // 2) limpiar: si parece dirección, no sirve
    const venueLooksAddress = venue && (/\d/.test(venue) || norm(venue).startsWith("de "));
    if (!venue || venueLooksAddress) venue = "";

    // 3) inferir por URL (reglas exactas) — usamos el inferredEarly
    if (inferredEarly) venue = inferredEarly;

    // ✅ Regla editorial: EXPO institucional -> sin sede válida, fuera
    if (!venue || !VALID_VENUES.has(venue)) return null;

    const mapsQuery = [venue, address, "Madrid"].filter(Boolean).join(", ");
    const mapsUrl = mapsUrlFromQuery(mapsQuery);

    return { title, venue, address, dateText:"", url, mapsUrl, _hay: hay };
  }).filter(Boolean);

  console.log("Expo candidates:", candidates.length);

  const seen = new Set();
  const ranked = candidates
    .map(it => ({ ...it, _score: scoreItem({ title: it.title, venue: it.venue, url: it.url, hay: it._hay }) }))
    .sort((a,b) => b._score - a._score)
    .filter(it => {
      const key = norm(`${it.title}__${it.venue}__${it.address}`);
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

