/**
 * update-expo-monthly.js
 * Genera: data/agenda-monthly.json
 * Fuente: Open Data esMadrid (XML)
 * Objetivo: llenar group "exhibitions" con una selección breve (editorial).
 */

import fs from "fs";
import { XMLParser } from "fast-xml-parser";

const FEED_URL = "https://www.esmadrid.com/opendata/agenda_v1_es.xml";

// Prioridad editorial de sedes
const VENUE_PRIORITY = [
  "fundación telefónica",
  "espacio fundación telefónica",
  "fundacion telefonica",
  "fundacion mapfre",
  "fundación mapfre",
  "casa encendida",
  "la casa encendida",
  "coam",
  "colegio oficial de arquitectos",
  "colegio oficial de arquitectos de madrid",
  "circulo de bellas artes",
  "círculo de bellas artes",
  "matadero",
  "caixaforum",
  "caixa forum",
  "tabacalera",
  "condeduque",
  "centrocentro"
];

const KEYWORDS_EXPO = [
  "exposición", "exposicion", "exposiciones",
  "fotografía", "fotografia",
  "muestra", "retrospectiva", "comisariad",
  "arte", "galería", "galeria"
];

// ---------------- helpers ----------------
function safeText(v){ return (v ?? "").toString().trim(); }

function norm(v){
  return safeText(v)
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, ""); // quita acentos
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
  return null;
}

function deepStrings(obj, out = []){
  if (!obj) return out;
  if (typeof obj === "string" || typeof obj === "number"){ out.push(String(obj)); return out; }
  if (Array.isArray(obj)){ obj.forEach(x => deepStrings(x, out)); return out; }
  if (typeof obj === "object"){ Object.values(obj).forEach(v => deepStrings(v, out)); }
  return out;
}

function toISODateGuess(v){
  const s = safeText(v);
  if (!s) return null;

  // ISO
  if (/^\d{4}-\d{2}-\d{2}/.test(s)){
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  // dd/mm/yyyy
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m){
    const dd = m[1].padStart(2, "0");
    const mm = m[2].padStart(2, "0");
    const yyyy = m[3];
    const d = new Date(`${yyyy}-${mm}-${dd}T12:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function withinNextDays(iso, days = 120){
  if (!iso) return true; // si no hay fecha, no descartamos
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return true;
  const now = new Date();
  const max = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  return d >= now && d <= max;
}

// ---------------- extraction ----------------
function extractFromKnownPaths(parsed){
  const root = parsed?.agenda ?? parsed?.response ?? parsed;
  const events =
    root?.eventos?.evento ||
    root?.eventos ||
    root?.events?.event ||
    root?.events ||
    root?.evento ||
    [];
  return toArray(events);
}

function walkCandidates(root){
  // fallback: encontrar “eventos” por presencia de campos típicos
  const out = [];

  function walk(node){
    if (!node) return;
    if (Array.isArray(node)){ node.forEach(walk); return; }
    if (typeof node !== "object") return;

    const title = pickFirst(node, ["title","titulo","nombre","name"]);
    const link  = pickFirst(node, ["link","url","enlace","web"]);
    if (title && link) out.push(node);

    for (const k of Object.keys(node)) walk(node[k]);
  }

  walk(root);
  return out;
}

function looksLikeExhibition(ev){
  const texts = deepStrings(ev).map(norm);
  return KEYWORDS_EXPO.map(norm).some(k => texts.some(t => t.includes(k)));
}

function extractEvent(ev){
  const title = safeText(pickFirst(ev, ["title","titulo","nombre","name"]));
  const url   = safeText(pickFirst(ev, ["link","url","enlace","web"]));

  const venue = safeText(pickFirst(ev, [
    "venue","lugar","place","localizacion","localización",
    "organizer","organizador","centro","location"
  ]));

  const address = safeText(pickFirst(ev, ["address","direccion","dirección","streetAddress"]));

  const startRaw =
    pickFirst(ev, ["start","inicio","fechaInicio","fechainicio","dateStart","datestart","fecha","date"]) ||
    pickFirst(ev, ["@_start","@_inicio"]);

  const start = toISODateGuess(startRaw);

  return { title, venue, address, start, url: url || null };
}

function scoreExpoItem(item){
  let s = 0;
  const t = norm(item.title);
  const v = norm(item.venue);

  if (t.includes("fotograf")) s += 4; // prioriza foto
  if (VENUE_PRIORITY.map(norm).some(p => v.includes(p))) s += 10; // prioriza sedes
  if (!v) s -= 1;

  return s;
}

// ---------------- main ----------------
async function main(){
  const res = await fetch(FEED_URL, { headers: { "user-agent": "paseandomadrid-bot/1.0" } });
  if (!res.ok) throw new Error(`Feed fetch failed: ${res.status}`);

  const xml = await res.text();
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    trimValues: true,
    parseTagValue: true
  });

  const parsed = parser.parse(xml);

  // 1) Intento por rutas conocidas (lo más fiable)
  let raw = extractFromKnownPaths(parsed);

  // 2) fallback walker si viene raro
  if (!raw.length) raw = walkCandidates(parsed);

  const exhibitions = raw
    .filter(looksLikeExhibition)
    .map(extractEvent)
    .filter(it => it.title && it.url)
    .filter(it => withinNextDays(it.start, 120))
    .map(it => ({ ...it, _score: scoreExpoItem(it) }))
    .sort((a,b) => {
      if (b._score !== a._score) return b._score - a._score;
      const da = a.start ? Date.parse(a.start) : Infinity;
      const db = b.start ? Date.parse(b.start) : Infinity;
      return da - db;
    })
    .slice(0, 10)
    .map(({ _score, ...rest }) => rest);

  const out = {
    updatedAt: new Date().toISOString(),
    groups: [
      {
        category: "exhibitions",
        deck: "Selección automática desde agenda cultural de Madrid (curada por prioridad editorial).",
        items: exhibitions
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

  console.log("Expo monthly updated:", exhibitions.length, "items");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
