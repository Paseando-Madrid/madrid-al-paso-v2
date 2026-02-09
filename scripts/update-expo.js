/**
 * scripts/update-expo.js
 * Genera: data/agenda-monthly.json
 * Fuente: Open Data esMadrid (XML)
 * Objetivo: EXPO curada por sedes (prioridad) + anti-ruido.
 *
 * Node 18+ (GitHub Actions) trae fetch global.
 * Requiere: fast-xml-parser@4
 */

import fs from "fs";
import { XMLParser } from "fast-xml-parser";

const FEED_URL = "https://www.esmadrid.com/opendata/agenda_v1_es.xml";

/* ================== Helpers base ================== */
function safeText(v){ return (v ?? "").toString().trim(); }

function norm(s){
  return safeText(s)
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
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

function toArray(v){
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * Pick FIRST non-empty value for any key, searching DEEPLY in nested objects.
 */
function pickDeep(obj, keys){
  const keySet = new Set(keys);
  let found = "";

  (function walk(x){
    if(found) return;
    if(!x) return;

    if(typeof x === "string" || typeof x === "number"){
      return;
    }

    if(Array.isArray(x)){
      for(const it of x){
        walk(it);
        if(found) return;
      }
      return;
    }

    if(typeof x === "object"){
      for(const [k, v] of Object.entries(x)){
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

  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    const dd = m[1].padStart(2, "0");
    const mm = m[2].padStart(2, "0");
    const yyyy = m[3];
    const d = new Date(`${yyyy}-${mm}-${dd}T12:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function fmtRange(startISO, endISO){
  const fmt = (iso) => {
    if(!iso) return "";
    try{
      const d = new Date(iso);
      return d.toLocaleDateString("es-ES", { day:"2-digit", month:"short", year:"numeric" });
    }catch{ return ""; }
  };
  const a = fmt(startISO);
  const b = fmt(endISO);
  if(a && b) return `${a} → ${b}`;
  return a || b || "";
}

function mapsUrlFromQuery(q){
  const query = safeText(q);
  if(!query) return null;
  return `https://www.google.com/maps?q=${encodeURIComponent(query)}`;
}

function haystack(ev){
  return norm(decodeHtmlEntities(deepStrings(ev).join(" | ")));
}

/* ================== Editorial: sedes objetivo ================== */
const VENUE_PRIORITY = [
  "fundación telefónica","espacio fundación telefónica","fundacion telefonica",
  "fundación mapfre","fundacion mapfre",
  "coam","colegio oficial de arquitectos","colegio oficial de arquitectos de madrid",
  "casa encendida","la casa encendida",
  "círculo de bellas artes","circulo de bellas artes",
  "matadero","caixaforum","caixa forum",
  "tabacalera","conde duque","condeduque","centrocentro","centro centro"
].map(norm);

/* ================== Keywords EXPO ================== */
const EXPO_KEYS = [
  "exposición","exposicion","exposiciones",
  "fotografía","fotografia","foto","photography",
  "muestra","retrospectiva","instalación","instalacion",
  "comisari","colección","coleccion",
  "arte","galería","galeria",
  "contemporáneo","contemporaneo"
].map(norm);

/* ================== Anti-ruido ================== */
const EXCLUDE_KEYS = [
  "fútbol","futbol","baloncesto","tenis","atletico","atlético",
  "real madrid","copa","liga","partido","semifinal","ida","vuelta",
  "concierto","gira","tour","entradas","vip",
  "teatro","musical","ópera","opera","danza","performance"
].map(norm);

/* ================== Extracción “loose” (DEEP) ================== */
function pickTitle(ev){
  const raw = pickDeep(ev, ["title","titulo","name","nombre"]);
  return decodeHtmlEntities(raw) || "—";
}

function pickUrl(ev){
  const u = pickDeep(ev, ["web","url","link","enlace"]);
  return safeText(u) || null;
}

function pickDates(ev){
  const startRaw = pickDeep(ev, [
    "dtstart","start","inicio","fechaInicio","fechainicio","dateStart","datestart","fecha","date"
  ]);
  const endRaw = pickDeep(ev, [
    "dtend","end","fin","fechaFin","fechafin","dateEnd","dateend"
  ]);
  return { start: toISODateGuess(startRaw), end: toISODateGuess(endRaw) };
}

function pickVenueLoose(ev){
  return safeText(pickDeep(ev, [
    "nombrert","venue","lugar","place","localizacion","localización","location",
    "organizer","organizador","centro","espacio","entidad"
  ]));
}

function pickAddressLoose(ev){
  return safeText(pickDeep(ev, ["address","direccion","dirección","streetAddress","dir"]));
}

function inferVenueFromUrlOrText(url, h){
  const hit = VENUE_PRIORITY.find(v => h.includes(v));
  if(hit) return hit;

  const u = norm(url || "");
  const rules = [
    ["fundacion-telefonica", "Fundación Telefónica"],
    ["fundacion-mapfre", "Fundación MAPFRE"],
    ["coam", "COAM"],
    ["casa-encendida", "La Casa Encendida"],
    ["circulo-bellas-artes", "Círculo de Bellas Artes"],
    ["matadero", "Matadero"],
    ["caixaforum", "CaixaForum"],
    ["tabacalera", "Tabacalera"],
    ["conde-duque", "CondeDuque"],
    ["condeduque", "CondeDuque"],
    ["centrocentro", "CentroCentro"],
    ["centro-centro", "CentroCentro"]
  ];
  for (const [needle, label] of rules){
    if(u.includes(needle)) return label;
  }
  return "";
}

function hasExpoSignals(h, title, url){
  const t = norm(title);
  const u = norm(url || "");
  return (
    EXPO_KEYS.some(k => h.includes(k) || t.includes(k)) ||
    u.includes("exposicion") || u.includes("exposiciones") ||
    VENUE_PRIORITY.some(v => h.includes(v))
  );
}

function hasExcludedSignals(h, title, url){
  const t = norm(title);
  const u = norm(url || "");
  return EXCLUDE_KEYS.some(k => h.includes(k) || t.includes(k) || u.includes(k));
}

function scoreItem(item){
  let s = 0;
  const t = norm(item.title);
  const v = norm(item.venue);
  const u = norm(item.url || "");
  const h = norm(item._hay || "");

  if (v && VENUE_PRIORITY.some(p => v.includes(p))) s += 30;
  if (VENUE_PRIORITY.some(p => h.includes(p))) s += 15;

  if (t.includes("fotograf")) s += 12;
  if (EXPO_KEYS.some(k => t.includes(k))) s += 6;
  if (u.includes("agenda")) s += 2;

  if (!item.venue) s -= 4;
  if (hasExcludedSignals(h, item.title, item.url)) s -= 100;

  return s;
}

/* ================== localizar eventos (ROBUSTO) ================== */
function collectByKey(obj, key, out){
  if (!obj) return;
  if (Array.isArray(obj)) {
    obj.forEach(x => collectByKey(x, key, out));
    return;
  }
  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      if (k === key) out.push(v);
      collectByKey(v, key, out);
    }
  }
}

/* ================== Main ================== */
async function main(){
  const res = await fetch(FEED_URL, {
    headers: { "user-agent": "paseandomadrid-bot/1.0" },
    cache: "no-store"
  });
  if (!res.ok) throw new Error(`esmadrid fetch failed: ${res.status}`);

  const xml = await res.text();

  // DEBUG para verificar si es XML real o HTML/bloqueo
  console.log("Feed status:", res.status);
  console.log("Feed content-type:", res.headers.get("content-type") || "—");
  console.log("XML length:", xml.length);
  console.log("XML head:", xml.slice(0, 200).replace(/\s+/g, " "));

  if (xml.length < 200 || /<html|<!doctype/i.test(xml)) {
    throw new Error("Feed no parece XML válido (puede ser HTML/bloqueo).");
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    parseTagValue: true,
    trimValues: true
  });

  const parsed = parser.parse(xml);
  const root = parsed?.agenda ?? parsed?.response ?? parsed;

  const buckets = [];
  collectByKey(root, "evento", buckets);
  collectByKey(root, "event", buckets);

  const list = buckets.flatMap(v => toArray(v)).filter(x => x && typeof x === "object");

  console.log("Total raw events:", list.length);

  // 1) candidatos
  const candidates = list
    .map(ev => {
      const title = pickTitle(ev);
      const url = pickUrl(ev);
      if(!title || !url) return null;

      const h = haystack(ev);
      const { start, end } = pickDates(ev);

      let venue = pickVenueLoose(ev);
      let address = pickAddressLoose(ev);
      if(!venue) venue = inferVenueFromUrlOrText(url, h);

      const dateText = fmtRange(start, end);
      const mapsUrl = mapsUrlFromQuery([venue || title, "Madrid"].filter(Boolean).join(", "));

      return { title, venue, address: address || "", start, end, dateText, url, mapsUrl, _hay: h };
    })
    .filter(Boolean);

  console.log("Candidates with title+url:", candidates.length);

  const expoCandidates = candidates.filter(it => {
    const h = it._hay || "";
    return hasExpoSignals(h, it.title, it.url) && !hasExcludedSignals(h, it.title, it.url);
  });

  console.log("Expo candidates after filters:", expoCandidates.length);

  const seen = new Set();
  const ranked = expoCandidates
    .map(it => ({ ...it, _score: scoreItem(it) }))
    .sort((a,b) => b._score - a._score)
    .filter(it => {
      const key = norm(`${it.title}__${it.venue}`);
      if(seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 8)
    .map(({ _score, _hay, ...rest }) => rest);

  if (ranked.length === 0) {
    const seen2 = new Set();
    const fallback = candidates
      .map(it => ({ ...it, _score: scoreItem(it) }))
      .filter(it => !hasExcludedSignals(it._hay || "", it.title, it.url))
      .sort((a,b) => b._score - a._score)
      .filter(it => {
        const key = norm(`${it.title}__${it.venue}`);
        if(seen2.has(key)) return false;
        seen2.add(key);
        return true;
      })
      .slice(0, 8)
      .map(({ _score, _hay, ...rest }) => rest);

    ranked.push(...fallback);
  }

  console.log("Final Expo items:", ranked.length);

  const out = {
    updatedAt: new Date().toISOString(),
    groups: [
      { category: "exhibitions", deck: "Selección automática desde agenda cultural de Madrid (curada por prioridad editorial).", items: ranked },
      { category: "theatre", deck: "Pendiente de automatización (siguiente paso).", items: [] }
    ]
  };

  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync("data/agenda-monthly.json", JSON.stringify(out, null, 2), "utf8");

  console.log("Expo updated:", ranked.length, "items");
}

main().catch(err => {

