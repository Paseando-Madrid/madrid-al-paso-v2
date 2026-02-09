/**
 * update-expo-monthly.js
 * Genera: data/agenda-monthly.json
 * Fuente: Open Data esMadrid (XML)
 * Objetivo: llenar group "exhibitions" con una selección breve (editorial).
 */

import fs from "fs";
import { XMLParser } from "fast-xml-parser";

const FEED_URL = "https://www.esmadrid.com/opendata/agenda_v1_es.xml";

// Prioridad editorial de sedes (lo que me pediste)
const VENUE_PRIORITY = [
  "fundación telefónica",
  "espacio fundación telefónica",
  "fundacion telefonica",
  "fundacion mapfre",
  "fundación mapfre",
  "sala recoletos (fundación mapfre)",
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
].map(n => n.toLowerCase());

const KEYWORDS_EXPO = [
  "exposición", "exposicion", "exposiciones",
  "fotografía", "fotografia",
  "muestra", "retrospectiva", "comisariad",
  "arte", "galería", "galeria"
].map(k => k.toLowerCase());

function safeText(v) {
  return (v ?? "").toString().trim();
}

function norm(v) {
  return safeText(v).toLowerCase();
}

function toISODateGuess(v) {
  const s = safeText(v);
  if (!s) return null;

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

function withinNextDays(iso, days = 90) {
  if (!iso) return true; // si no hay fecha, no descartamos
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return true;

  const now = new Date();
  const max = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  return d >= now && d <= max;
}

function pickFirst(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null) return obj[k];
  }
  return null;
}

function findCandidates(root) {
  // Buscamos objetos que parezcan eventos (título + link)
  const out = [];

  function walk(node) {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node !== "object") return;

    const title = pickFirst(node, ["title", "titulo", "nombre", "name"]);
    const link  = pickFirst(node, ["link", "url", "enlace"]);
    if (title && link) out.push(node);

    for (const k of Object.keys(node)) walk(node[k]);
  }

  walk(root);
  return out;
}

function looksLikeExhibition(ev) {
  // Heurística: keywords en el “texto” total del objeto
  const hay = norm(JSON.stringify(ev));
  return KEYWORDS_EXPO.some(k => hay.includes(k));
}

function extractEvent(ev) {
  const title = safeText(pickFirst(ev, ["title", "titulo", "nombre", "name"]));
  const url   = safeText(pickFirst(ev, ["link", "url", "enlace"]));

  // lugar/sede (depende de cómo venga el XML)
  const venue = safeText(
    pickFirst(ev, [
      "venue", "lugar", "place", "localizacion", "localización",
      "organizer", "organizador", "direccion", "dirección"
    ])
  );

  // fecha
  const startRaw =
    pickFirst(ev, ["start", "inicio", "fechaInicio", "fechainicio", "date", "fecha", "dateStart", "datestart"]) ||
    pickFirst(ev, ["@_start", "@_inicio"]);

  const start = toISODateGuess(startRaw);

  return { title, venue, start, url };
}

function scoreExpoItem(item) {
  let s = 0;
  const t = norm(item.title);
  const v = norm(item.venue);

  if (t.includes("fotograf")) s += 4; // prioriza foto
  if (VENUE_PRIORITY.some(p => v.includes(p))) s += 10; // prioriza sedes

  // si no hay sede, penaliza un poco (pero no lo elimina)
  if (!v) s -= 1;

  return s;
}

async function main() {
  const res = await fetch(FEED_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`Feed fetch failed: ${res.status}`);

  const xml = await res.text();
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    trimValues: true
  });
  const parsed = parser.parse(xml);

  const raw = findCandidates(parsed);

  // Extrae, filtra y ordena expos
  const exhibitions = raw
    .filter(looksLikeExhibition)
    .map(extractEvent)
    .filter(it => it.title && it.url)
    .filter(it => withinNextDays(it.start, 120))
    .map(it => ({ ...it, _score: scoreExpoItem(it) }))
    .sort((a, b) => {
      if (b._score !== a._score) return b._score - a._score;
      const da = a.start ? new Date(a.start).getTime() : Number.MAX_SAFE_INTEGER;
      const db = b.start ? new Date(b.start).getTime() : Number.MAX_SAFE_INTEGER;
      return da - db;
    })
    .slice(0, 10)
    .map(({ _score, ...rest }) => rest);

  // Dejamos theatre vacío por ahora (siguiente paso)
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
