/**
 * scripts/update-expo.js
 * Genera: data/agenda-monthly.json
 * Fuente: Open Data esMadrid (XML) — agenda_v1_es.xml
 * Estructura real: <serviceList><service>...</service></serviceList>
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

function deepStrings(obj, out = []){
  if (!obj) return out;
  if (typeof obj === "string" || typeof obj === "number") { out.push(String(obj)); return out; }
  if (Array.isArray(obj)) { obj.forEach(x => deepStrings(x, out)); return out; }
  if (typeof obj === "object") { Object.values(obj).forEach(v => deepStrings(v, out)); }
  return out;
}

function pick(obj, keys){
  for (const k of keys){
    if (obj?.[k]) return safeText(obj[k]);
  }
  return "";
}

function mapsUrlFromQuery(q){
  return q ? `https://www.google.com/maps?q=${encodeURIComponent(q)}` : "";
}

/* ================== Editorial ================== */
const VENUE_PRIORITY = [
  "fundación telefónica","fundación mapfre","casa encendida",
  "círculo de bellas artes","matadero","caixaforum",
  "tabacalera","conde duque","centrocentro"
].map(norm);

const EXPO_KEYS = [
  "exposición","exposiciones","fotografía","muestra",
  "retrospectiva","arte","galería","instalación"
].map(norm);

const EXCLUDE_KEYS = [
  "concierto","teatro","musical","ópera","danza"
].map(norm);

/* ================== Main ================== */
async function main(){
  const res = await fetch(FEED_URL);
  if (!res.ok) throw new Error("Feed fetch failed");

  const xml = await res.text();
  const parser = new XMLParser({ ignoreAttributes:false });
  const parsed = parser.parse(xml);

  const services = toArray(parsed?.serviceList?.service);

  console.log("Total raw services:", services.length);

  const candidates = services.map(s => {
    const title = pick(s?.basicData, ["name"]);
    const venue = pick(s?.geoData, ["address","district"]);
    const url   = pick(s?.basicData, ["web"]);
    if (!title || !url) return null;

    const hay = norm(deepStrings(s).join(" "));
    if (!EXPO_KEYS.some(k => hay.includes(k))) return null;
    if (EXCLUDE_KEYS.some(k => hay.includes(k))) return null;

    return {
      title,
      venue,
      dateText: "",
      url,
      mapsUrl: mapsUrlFromQuery(venue + ", Madrid")
    };
  }).filter(Boolean);

  console.log("Expo candidates:", candidates.length);

  const ranked = candidates
    .slice(0, 8);

  const out = {
    updatedAt: new Date().toISOString(),
    groups: [
      {
        category: "exhibitions",
        deck: "Selección automática desde la agenda cultural de Madrid.",
        items: ranked
      }
    ]
  };

  fs.mkdirSync("data", { recursive:true });
  fs.writeFileSync("data/agenda-monthly.json", JSON.stringify(out,null,2));

  console.log("Expo updated:", ranked.length, "items");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

