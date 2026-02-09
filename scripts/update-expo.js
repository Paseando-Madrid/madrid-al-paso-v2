/**
 * scripts/update-expo.js
 * Genera: data/agenda-monthly.json
 * Fuente: Open Data esMadrid (XML) — agenda_v1_es.xml
 * Estructura: <serviceList><service>...</service></serviceList>
 *
 * Objetivo EXPO (Cooltura):
 * - 8 expos máx.
 * - Prioridad por sedes institucionales (Telefónica, Mapfre, CBA, CaixaForum, Matadero, Casa Encendida, COAM, etc.)
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

function toArray(v){
  return Array.isArray(v) ? v : v ? [v] : [];
}

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
    .replace(/&ntilde;/g, "ñ").replace(/&Ntilde;/g, "Ñ")
    .replace(/&ordm;/g, "º")
    .replace(/&iexcl;/g, "¡")
    .replace(/&iquest;/g, "¿");
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

function looksLikeAddress(v){
  const x = norm(v);
  if(!x) return false;

  // señales fuertes de “esto es una dirección”
  const starts = ["de ","del ","paseo ","calle ","plaza ","av ","avenida ","c/","pza ","pte ","paseo de "];
  if (starts.some(s => x.startsWith(s))) return true;

  // número / coma típica
  if (/\d/.test(x)) return true;
  if (x.includes(", ")) return true;

  return false;
}

/**
 * URL clean:
 * - quita query (?utm_...) y hash
 * - se queda con host+pathname en minúsculas
 * - si no parsea, devuelve string normalizado “a pelo”
 */
function cleanUrlForMatch(rawUrl){
  const u0 = safeText(rawUrl);
  if(!u0) return "";
  try{
    const u = new URL(u0);
    // IMPORTANTE: solo host + pathname (sin query/hash)
    return `${u.host}${u.pathname}`.toLowerCase();
  }catch{
    // fallback: quita query/hash manual
    return u0.split("#")[0].split("?")[0].toLowerCase();
  }
}

/**
 * extrae URL desde basicData.web aunque venga raro
 * (a veces puede venir como string, array, objeto)
 */
function extractWeb(svc){
  const w = svc?.basicData?.web;
  if (!w) return "";

  if (typeof w === "string") return safeText(w);

  if (Array.isArray(w)) {
    // primer string útil
    for (const item of w){
      const v = (typeof item === "string") ? item : (item?.["@_href"] || item?.href || item?.url);
      const s = safeText(v);
      if (s) return s;
    }
    return "";
  }

  if (typeof w === "object") {
    const v = w?.["@_href"] || w?.href || w?.url || w?.link;
    return safeText(v);
  }

  return "";
}

/* ================== Editorial ================== */
/**
 * ✅ VENUE_RULES por URL (slugs / paths habituales).
 * Orden importa: lo específico primero.
 */
const VENUE_RULES = [
  // Fundación Telefónica
  ["espacio-fundacion-telefonica", "Fundación Telefónica"],
  ["fundacion-telefonica", "Fundación Telefónica"],

  // Fundación MAPFRE
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

  // La Casa Encendida
  ["la-casa-encendida", "La Casa Encendida"],
  ["casa-encendida", "La Casa Encendida"],

  // COAM
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
  const u = cleanUrlForMatch(url);
  if(!u) return "";
  for (const [needle, label] of VENUE_RULES){
    if (u.includes(needle)) return label;
  }
  return "";
}

/**
 * ✅ ADDRESS_RULES (cuando la “sede” no viene, pero la dirección sí).
 * Regla: si la sede viene por ADDRESS -> exigimos EXPO_KEYS (para no colar planes genéricos).
 */
const ADDRESS_RULES = [
  // Telefónica: C/ Fuencarral 3 (muy típico)
  ["fuencarral", "Fundación Telefónica"],

  // MAPFRE Recoletos (paseo de recoletos 23 aprox)
  ["recoletos", "Fundación MAPFRE (Sala Recoletos)"],

  // CBA: Alcalá 42
  ["alcala, 42", "Círculo de Bellas Artes"],
  ["de alcala, 42", "Círculo de Bellas Artes"],

  // CaixaForum: Paseo del Prado 36
  ["paseo del prado", "CaixaForum Madrid"],
  ["prado, 36", "CaixaForum Madrid"],
  ["del prado, 36", "CaixaForum Madrid"],

  // Matadero: Plaza de Legazpi 8
  ["legazpi", "Matadero Madrid"],
  ["plaza de legazpi", "Matadero Madrid"],

  // Casa Encendida: Ronda de Valencia 2
  ["ronda de valencia", "La Casa Encendida"],
  ["valencia, 2", "La Casa Encendida"],

  // COAM: Hortaleza 63 (frecuente)
  ["hortaleza", "COAM"],
  ["hortaleza, 63", "COAM"],

  // CentroCentro: Plaza de Cibeles 1
  ["cibeles", "CentroCentro"],
  ["cibeles, 1", "CentroCentro"],

  // CondeDuque: Conde Duque 9 / 11
  ["conde duque", "CondeDuque"],

  // Sala Alcalá 31: Alcalá 31
  ["alcala, 31", "Sala Alcalá 31"],
  ["de alcala, 31", "Sala Alcalá 31"],

  // Tabacalera: Embajadores 53
  ["embajadores", "Tabacalera"],
  ["embajadores, 53", "Tabacalera"],
];

function inferVenueFromAddress(address){
  const a = norm(address);
  if(!a) return "";
  for (const [needle, label] of ADDRESS_RULES){
    if (a.includes(norm(needle))) return label;
  }
  return "";
}

/**
 * Lista “válida” (filtro institucional).
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

// Señales EXPO
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

  if (!venue) s -= 300;
  if (!VALID_VENUES.has(venue)) s -= 300;
  if (isExcluded(h) || isExcluded(t) || isExcluded(u)) s -= 500;

  return s;
}

/* ================== Main ================== */
async function main(){
  const res = await fetch(FEED_URL, {
    headers: { "user-agent": "paseandomadrid-bot/1.0" },
    cache: "no-store"
  });
  if (!res.ok) throw new Error(`Feed fetch failed: ${res.status}`);

  const xml = await res.text();
  const parser = new XMLParser({ ignoreAttributes:false });
  const parsed = parser.parse(xml);

  const services = toArray(parsed?.serviceList?.service);
  console.log("Total raw services:", services.length);

  let keptAfterNoise = 0;
  let keptWithValidVenue = 0;

  const candidates = services.map(s => {
    const titleRaw = safeText(s?.basicData?.name);
    const url = extractWeb(s);

    if (!titleRaw || !url) return null;

    const title = decodeHtmlEntities(titleRaw);
    const address = safeText(s?.geoData?.address);
    const hay = norm(deepStrings(s).join(" | "));

    // Anti-ruido primero (siempre)
    if (isExcluded(hay) || isExcluded(title) || isExcluded(url)) return null;
    keptAfterNoise++;

    // 0) inferimos sede temprano:
    //    A) por URL (fuerte, permite pasar aunque falten EXPO_KEYS)
    //    B) por ADDRESS (solo ayuda, pero exige EXPO_KEYS)
    const inferredByUrl = inferVenueFromUrl(url);
    const inferredByAddr = inferVenueFromAddress(address);

    const isValidUrlVenue = inferredByUrl && VALID_VENUES.has(inferredByUrl);
    const isValidAddrVenue = inferredByAddr && VALID_VENUES.has(inferredByAddr);

    // Señal EXPO mínima:
    // - Si hay sede válida por URL -> NO exigimos EXPO_KEYS (feed pobre)
    // - Si hay sede válida solo por ADDRESS -> SÍ exigimos EXPO_KEYS (para no meter “planes” genéricos)
    // - Si no hay sede válida -> fuera
    if (!isValidUrlVenue) {
      if (!isValidAddrVenue) return null;
      if (!hasExpoSignals(hay) && !hasExpoSignals(title) && !hasExpoSignals(url)) return null;
    }

    // 1) venue por campos (si existe)
    let venue =
      pickDeepByKeys(s, ["venue","lugar","place","centro","espacio","entity","entidad","organization","organizacion"]) ||
      "";

    // 2) limpiar venue si parece dirección
    if (venue && looksLikeAddress(venue)) venue = "";

    // 3) fijar venue por inferencias (prioridad: URL > ADDRESS)
    if (isValidUrlVenue) venue = inferredByUrl;
    else if (isValidAddrVenue) venue = inferredByAddr;

    // 4) regla editorial: sin sede institucional válida, fuera
    if (!venue || !VALID_VENUES.has(venue)) return null;
    keptWithValidVenue++;

    const mapsQuery = [venue, address, "Madrid"].filter(Boolean).join(", ");
    const mapsUrl = mapsUrlFromQuery(mapsQuery);

    return { title, venue, address, dateText:"", url, mapsUrl, _hay: hay };
  }).filter(Boolean);

  console.log("Kept after noise:", keptAfterNoise);
  console.log("Kept with valid venue:", keptWithValidVenue);
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

