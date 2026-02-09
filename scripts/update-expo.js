import fetch from "node-fetch";
import fs from "fs";
import { XMLParser } from "fast-xml-parser";

const FEED_URL = "https://www.esmadrid.com/opendata/agenda_v1_es.xml";

// ---------- helpers ----------
function safeText(v){ return (v ?? "").toString().trim(); }

function toArray(v){
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function norm(s){
  return safeText(s)
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
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

// ---------- main ----------
const res = await fetch(FEED_URL, { headers: { "user-agent": "paseandomadrid-bot/1.0" } });
if (!res.ok) throw new Error(`esmadrid fetch failed: ${res.status}`);

const xml = await res.text();

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: true,
  trimValues: true
});

const data = parser.parse(xml);

// Intentamos localizar la lista de eventos sea cual sea el nodo raíz
const root = data?.agenda ?? data?.response ?? data;
const events =
  root?.eventos?.evento ||
  root?.eventos ||
  root?.events?.event ||
  root?.events ||
  root?.evento ||
  [];

const list = toArray(events);

// Heurística: detectar exposiciones por palabras clave en cualquier campo de texto
const EXPO_KEYS = [
  "exposicion", "exposiciones",
  "fotografia", "foto", "photo",
  "museo", "galeria", "arte contemporaneo"
];

function isExhibition(ev){
  const texts = deepStrings(ev).map(norm);
  return EXPO_KEYS.some(k => texts.some(t => t.includes(k)));
}

function pickUrl(ev){
  const u = pickFirst(ev, ["url", "link", "enlace", "web"]);
  return safeText(u);
}

function pickTitle(ev){
  return safeText(pickFirst(ev, ["title", "titulo", "name", "nombre"])) || "—";
}

function pickVenue(ev){
  return safeText(
    pickFirst(ev, [
      "venue", "lugar", "place", "organizer",
      "localizacion", "location", "centro"
    ])
  );
}

function pickDates(ev){
  const start = pickFirst(ev, ["start", "fechaInicio", "fechainicio", "startDate", "dateStart", "inicio"]);
  const end   = pickFirst(ev, ["end", "fechaFin", "fechafin", "endDate", "dateEnd", "fin"]);
  return { start: safeText(start) || null, end: safeText(end) || null };
}

function pickAddress(ev){
  return safeText(pickFirst(ev, ["address", "direccion", "streetAddress", "dir"]));
}

function pickExcerpt(ev){
  const desc = pickFirst(ev, ["excerpt", "entradilla", "description", "descripcion", "resumen"]);
  return safeText(desc);
}

// Filtrado EXPO + orden por fecha (si existe)
const expoItemsRaw = list.filter(isExhibition).map(ev => {
  const { start, end } = pickDates(ev);

  return {
    title: pickTitle(ev),
    venue: pickVenue(ev),
    start,
    end,
    url: pickUrl(ev) || null,
    address: pickAddress(ev) || "",
    excerpt: pickExcerpt(ev) || ""
  };
});

// Ordenar por start si es ISO o parseable
expoItemsRaw.sort((a,b) => {
  const ta = a.start ? Date.parse(a.start) : Infinity;
  const tb = b.start ? Date.parse(b.start) : Infinity;
  return ta - tb;
});

// Curación “automática” mínima: 8 items, sin duplicados por (title+venue)
const seen = new Set();
const expoItems = [];
for (const it of expoItemsRaw){
  const key = norm(`${it.title}__${it.venue}`);
  if (seen.has(key)) continue;
  seen.add(key);
  expoItems.push(it);
  if (expoItems.length >= 8) break;
}

const out = {
  updatedAt: new Date().toISOString(),
  groups: [
    {
      category: "exhibitions",
      deck: "Selección automática desde agenda cultural de Madrid.",
      items: expoItems
    },
    // Dejamos el slot para “theatre” (Cartelera) para el siguiente paso
    {
      category: "theatre",
      deck: "Pendiente de automatización (siguiente paso).",
      items: []
    }
  ]
};

fs.mkdirSync("data", { recursive: true });
fs.writeFileSync("data/agenda-monthly.json", JSON.stringify(out, null, 2), "utf8");

console.log("Expo updated:", expoItems.length, "items");
