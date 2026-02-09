/**
 * scripts/update-expo.js
 * Genera: data/agenda-monthly.json
 * Fuente: Open Data esMadrid (XML)
 * Objetivo: EXPO curada por sedes prioridad + foco foto. 8 items máx.
 *
 * Nota: En Node 18+ existe fetch global. No hace falta node-fetch.
 */

import fs from "fs";
import { XMLParser } from "fast-xml-parser";

const FEED_URL = "https://www.esmadrid.com/opendata/agenda_v1_es.xml";

/* ===== Prioridad editorial de sedes ===== */
const VENUE_PRIORITY_RAW = [
  "Fundación Telefónica",
  "Espacio Fundación Telefónica",
  "Fundación Mapfre",
  "Sala Recoletos",
  "COAM",
  "Colegio Oficial de Arquitectos",
  "Colegio Oficial de Arquitectos de Madrid",
  "La Casa Encendida",
  "Círculo de Bellas Artes",
  "Matadero",
  "CaixaForum",
  "Tabacalera",
  "CondeDuque",
  "CentroCentro"
];

function safeText(v){ return (v ?? "").toString().trim(); }

function norm(s){
  return safeText(s)
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/* Slugs típicos en URLs de esMadrid para reforzar la detección de sede */
const VENUE_SLUG_HINTS = [
  { slug: "fundacion-telefonica", venue: "Fundación Telefónica" },
  { slug: "espacio-fundacion-telefonica", venue: "Fundación Telefónica" },
  { slug: "fundacion-mapfre", venue: "Fundación Mapfre" },
  { slug: "coam", venue: "COAM" },
  { slug: "casa-encendida", venue: "La Casa Encendida" },
  { slug: "circulo-bellas-artes", venue: "Círculo de Bellas Artes" },
  { slug: "matadero", venue: "Matadero" },
  { slug: "caixaforum", venue: "CaixaForum" },
  { slug: "tabacalera", venue: "Tabacalera" },
  { slug: "condeduque", venue: "CondeDuque" },
  { slug: "centrocentro", venue: "CentroCentro" }
];

const VENUE_PRIORITY = VENUE_PRIORITY_RAW.map(v => norm(v));

/* ===== Keywords expo ===== */
const EXPO_KEYS = [
  "exposicion", "exposición", "exposiciones",
  "fotografia", "fotografía",
  "muestra", "retrospectiva", "instalacion", "instalación",
  "comisari", "coleccion", "colección",
  "arte", "galeria", "galería"
].map(norm);

/* ===== Anti-ruido ===== */
const EXCLUDE_KEYS = [
  "futbol", "fútbol", "baloncesto", "tenis",
  "atletico", "atlético", "real madrid", "copa", "liga",
  "concierto", "gira", "tour", "entradas",
  "musical", "opera", "ópera", "danza",
  "partido", "semifinal", "ida", "vuelta"
].map(norm);

function toArray(v){ return !v ? [] : (Array.isArray(v) ? v : [v]); }

function pickFirst(obj, keys){
  for (const k of keys){
    const v = obj?.[k];
    if (v !== undefined && v !== null && safeText(v) !== "") return v;
  }
  return "";
}

function decodeHtmlEntities(str){
  // suficiente para esMadrid sin meter libs
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

function mapsUrlFromQuery(q){
  const query = safeText(q).trim();
  if(!query) return null;
  return `https://www.google.com/maps?q=${encodeURIComponent(query)}`;
}

/* 1) Recolectar “candidatos” robustamente caminando todo el XML parseado */
function findCandidates(root){
  const out = [];
  function walk(node){
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node !== "object") return;

    const title = pickFirst(node, ["title","titulo","name","nombre"]);
    const link  = pickFirst(node, ["link","url","enlace","web"]);
    if (title && link) out.push(node);

    for (const k of Object.keys(node)) walk(node[k]);
  }
  walk(root);
  return out;
}

function haystack(ev){
  return norm(decodeHtmlEntities(JSON.stringify(ev)));
}

function inferVenueFromUrl(url){
  const u = norm(url);
  const hit = VENUE_SLUG_HINTS.find(h => u.includes(h.slug));
  return hit ? hit.venue : "";
}

function inferVenueFromText(h){
  const hit = VENUE_PRIORITY.find(v => h.includes(v));
  if (!hit) return "";
  // recupera “bonito” desde RAW (misma posición)
  const idx = VENUE_PRIORITY.indexOf(hit);
  return idx >= 0 ? VENUE_PRIORITY_RAW[idx] : "";
}

/* Regla editorial: entra si (a) parece expo y (b) NO es ruido y (c) cae en sedes objetivo (texto o url) */
function isExpoForUs(ev){
  const h = haystack(ev);

  const hasExpo = EXPO_KEYS.some(k => h.includes(k));
  if(!hasExpo) return false;

  const hasExcluded = EXCLUDE_KEYS.some(k => h.includes(k));
  if(hasExcluded) return false;

  const url = safeText(pickFirst(ev, ["link","url","enlace","web"]));
  const venueByUrl = inferVenueFromUrl(url);
  const venueByTxt = inferVenueFromText(h);

  return Boolean(venueByUrl || venueByTxt);
}

function extract(ev){
  const title = decodeHtmlEntities(pickFirst(ev, ["title","titulo","name","nombre"])) || "—";
  const url   = safeText(pickFirst(ev, ["link","url","enlace","web"])) || null;

  const h = haystack(ev);

  const venueLoose = decodeHtmlEntities(pickFirst(ev, [
    "venue","lugar","place","localizacion","localización","location","centro","espacio","organizer","organizador"
  ]));

  const venue = venueLoose || inferVenueFromUrl(url || "") || inferVenueFromText(h) || "";

  const address = decodeHtmlEntities(pickFirst(ev, ["address","direccion","dirección","streetAddress","dir"])) || "";

  const startRaw = pickFirst(ev, ["start","inicio","fechaInicio","fechainicio","startDate","dateStart","fecha","date"]);
  const endRaw   = pickFirst(ev, ["end","fin","fechaFin","fechafin","endDate","dateEnd"]);
  const start = toISODateGuess(startRaw);
  const end   = toISODateGuess(endRaw);

  // Pin: sede + dirección si existe
  const mapsQuery = [venue, address, "Madrid"].filter(Boolean).join(", ");
  const mapsUrl = mapsUrlFromQuery(mapsQuery);

  return { title, venue, address, start, end, url, mapsUrl };
}

function score(item){
  let s = 0;
  const t = norm(item.title);
  const v = norm(item.venue);

  // prioridad: sedes
  if (v && VENUE_PRIORITY.some(p => v.includes(p))) s += 20;

  // prioridad: fotografía
  if (t.includes("fotograf")) s += 8;

  // si falta venue, baja (pero no mata)
  if (!v) s -= 3;

  // si hay start, un poco mejor
  if (item.start) s += 2;

  return s;
}

async function main(){
  const res = await fetch(FEED_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`esmadrid fetch failed: ${res.status}`);

  const xml = await res.text();
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    trimValues: true
  });

  const parsed = parser.parse(xml);
  const raw = findCandidates(parsed);

  const expo = raw
    .filter(isExpoForUs)
    .map(extract)
    .filter(it => it.title && it.url) // mínimos
    .map(it => ({ ...it, _score: score(it) }))
    .sort((a,b) => {
      if (b._score !== a._score) return b._score - a._score;
      const ta = a.start ? new Date(a.start).getTime() : Number.MAX_SAFE_INTEGER;
      const tb = b.start ? new Date(b.start).getTime() : Number.MAX_SAFE_INTEGER;
      return ta - tb;
    });

  // dedup title+venue
  const seen = new Set();
  const items = [];
  for (const it of expo){
    const key = norm(`${it.title}__${it.venue}`);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(it);
    if (items.length >= 8) break;
  }

  const out = {
    updatedAt: new Date().toISOString(),
    groups: [
      {
        category: "exhibitions",
        deck: "Selección automática desde agenda cultural de Madrid (curada por sedes prioridad + foco fotografía).",
        items
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

  console.log("Expo updated:", items.length, "items");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
