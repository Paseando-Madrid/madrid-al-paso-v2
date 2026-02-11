/**
 * Cooltura — Update ninos-weekly.json (CURACIÓN FINA + UI PREMIUM)
 * - Schema estable: { updatedAt, autoItems, manualItems }
 * - autoItems: SOLO sedes allowlist (dura)
 * - manualItems: se preserva tal cual en el JSON actual
 * - Hora: NO mostrar “00:00” ni medianoche (dtstart 00:00:00.0) => time=""
 * - Descripción: campo description (extracto editorial 180–220 chars aprox.)
 *
 * Node 18+ (fetch disponible)
 */

import fs from "node:fs";
import path from "node:path";

const FEED_URL =
  "https://datos.madrid.es/portal/site/egob/menuitem.ac61933d6ee3c31cae77ae7784f1a5a0/?vgnextoid=00149033f2201410VgnVCM100000171f5a0aRCRD&format=json&file=0&filename=206974-0-agenda-eventos-culturales-100&mgmtid=6c0b6d01df986410VgnVCM2000000c205a0aRCRD&preview=full";

const OUT_PATH = path.join("data", "ninos-weekly.json");

// ========= Curación (AUTOMATIZADO) — SOLO sedes permitidas =========
// Regla dura: en autoItems solo entran eventos cuyo event-location matchea (includes, normalizado) alguna de estas sedes:
const ALLOWED_VENUES = [
  "matadero madrid",
  "centro cultural casa del reloj",
  "centro cultural galileo",
  "centro de cultura contemporanea conde duque",
  "centro de cultura contemporánea conde duque",
  "conde duque",
  "centro cultural clara del rey",
  "museo abc"
];

// Fuera explícitamente por curación (aunque pudieran pasar por keywords)
const EXCLUDE_VENUE_KEYS = [
  "centro cultural lope de vega"
];

// Si aparece cualquiera de estos, fuera (aunque sea sede buena)
const EXCLUDE_TEXT_KEYS = ["campamento", "campus"];

// Tipos de la fuente admitidos (mantengo tu set; la curación principal es sedes + infantil)
const ALLOWED_SOURCE_TYPES = new Set([
  "ProgramacionDestacadaAgendaCultura",
  "Talleres",
  "TeatroPerformance",
  "ActividadesCulturales",
  "CuentacuentosTiteresMarionetas",
  "ExcursionesItinerariosVisitas",
  "FiestasCarnavales",
  "Exposiciones" // conditional
]);

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function safeStr(s) {
  return s == null ? "" : String(s).trim();
}

function getSourceType(typeValue) {
  if (!typeValue) return null;
  const t = Array.isArray(typeValue) ? typeValue[0] : typeValue;
  const parts = String(t).split("/");
  return parts[parts.length - 1] || null;
}

function includesAny(text, keys) {
  const t = norm(text);
  return keys.some((k) => t.includes(norm(k)));
}

function venueAllowed(venueRaw) {
  const v = norm(venueRaw);
  if (!v) return false;
  if (includesAny(v, EXCLUDE_VENUE_KEYS)) return false;
  return ALLOWED_VENUES.some((k) => v.includes(norm(k)));
}

function looksInfantil(text) {
  const t = norm(text);
  return [
    "niñ",
    "infantil",
    "familia",
    "familiar",
    "en familia",
    "peques",
    "peque",
    "bebe",
    "bebes",
    "cuentacuentos",
    "titer",
    "títer",
    "marionet",
    "guiñol",
    "circo",
    "payaso",
    "magia"
  ].some((k) => t.includes(norm(k)));
}

function extractAgeRange(text) {
  const t = norm(text);

  let m = t.match(/de\s*(\d{1,2})\s*(a|hasta)\s*(\d{1,2})\s*anos/);
  if (m) return `${m[1]}–${m[3]}`;

  m = t.match(/(\d{1,2})\s*-\s*(\d{1,2})\s*anos/);
  if (m) return `${m[1]}–${m[2]}`;

  m = t.match(/a partir de\s*(\d{1,2})/);
  if (m) return `${m[1]}+`;

  m = t.match(/\+(\d{1,2})/);
  if (m) return `${m[1]}+`;

  m = t.match(/(\d{1,2})\s*y\s*(\d{1,2})\s*anos/);
  if (m) return `${m[1]}–${m[2]}`;

  return null;
}

function mapType(sourceType, text) {
  const t = norm(text);

  if (sourceType === "Talleres") return "taller";

  if (sourceType === "TeatroPerformance") {
    if (t.includes("titer") || t.includes("títer") || t.includes("marionet") || t.includes("guiñol")) return "titeres";
    if (t.includes("circo") || t.includes("payaso") || t.includes("magia")) return "familia";
    return "teatro";
  }

  if (sourceType === "CuentacuentosTiteresMarionetas") return "titeres";
  if (sourceType === "ExcursionesItinerariosVisitas") return "visita";
  if (sourceType === "Exposiciones") return "visita";
  if (sourceType === "ProgramacionDestacadaAgendaCultura") return "visita";
  if (sourceType === "FiestasCarnavales") return "familia";
  if (sourceType === "ActividadesCulturales") return "actividad";

  return "actividad";
}

function audienceFinal(audienceRaw, text, ageRange) {
  const a = norm(audienceRaw);
  const t = norm(text);

  if (a.includes("niñ") || a.includes("infantil")) return "niños";
  if (a.includes("famil")) return "familia";
  if (ageRange) return "niños";
  if (t.includes("familia") || t.includes("familiar") || t.includes("en familia")) return "familia";
  if (t.includes("niñ") || t.includes("infantil") || t.includes("peques") || t.includes("bebe")) return "niños";
  return "familia";
}

function tagsFor(text, type, ageRange) {
  const t = norm(text);
  const tags = new Set();

  if (
    t.includes("en familia") ||
    t.includes("familiar") ||
    t.includes("familia") ||
    ["visita", "titeres", "teatro"].includes(type)
  ) {
    tags.add("diversion-en-familia");
  }

  if (
    t.includes("todos los publicos") ||
    t.includes("apto para todos los publicos") ||
    (["visita", "titeres", "teatro"].includes(type) && !ageRange)
  ) {
    tags.add("todos-los-publicos");
  }

  if (ageRange && ageRange.includes("–")) tags.delete("todos-los-publicos");
  return [...tags];
}

function dateText(dtstart) {
  const s = safeStr(dtstart);
  return s ? s.split(" ")[0] : "";
}

function isMidnightDtstart(dtstart) {
  const s = safeStr(dtstart);
  if (!s) return false;
  // Casos típicos: "2026-03-28 00:00:00.0" o ISO "...T00:00:00..."
  return (
    s.includes(" 00:00:00") ||
    s.includes("T00:00:00") ||
    /(\s|T)00:00:00(\.0+)?/.test(s)
  );
}

// Hora robusta + regla premium: NO devolver "00:00" ni medianoche
function timeText(ev) {
  const raw = safeStr(ev?.time);
  const dt  = safeStr(ev?.dtstart);

  // Si dtstart es medianoche => sin hora real
  if (isMidnightDtstart(dt)) return "";

  // Si hay time, respétalo salvo "00:00"
  if (raw) return raw === "00:00" ? "" : raw;

  // Si no hay time, extrae HH:MM de dtstart, pero elimina "00:00"
  const m = dt.match(/(\d{2}:\d{2})/);
  if (!m) return "";
  return m[1] === "00:00" ? "" : m[1];
}

function ensureAddress(ev) {
  return safeStr(ev?.address?.["street-address"] || "");
}

function ensureUrl(ev) {
  return safeStr(ev?.link || "");
}

function buildMapsQuery(venue, address) {
  const v = safeStr(venue);
  const a = safeStr(address);
  if (v && a) return `${v}, ${a}, Madrid`;
  if (v) return `${v} Madrid`;
  if (a) return `${a} Madrid`;
  return "Madrid";
}

// Teatro: solo entra si parece infantil/familiar (evita teatro adulto)
function isAllowedTheatre(text, ageRange) {
  const t = norm(text);
  if (ageRange) return true;

  return (
    t.includes("infantil") ||
    t.includes("familiar") ||
    t.includes("en familia") ||
    t.includes("niñ") ||
    t.includes("titer") ||
    t.includes("títer") ||
    t.includes("marionet") ||
    t.includes("guiñol") ||
    t.includes("circo") ||
    t.includes("magia")
  );
}

// Limpieza ligera de HTML y prefijos L1/L2
function stripHtmlBasic(s) {
  return safeStr(s)
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/p>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// description editorial 180–220 aprox.
function buildEditorialDescription(raw) {
  let d = stripHtmlBasic(raw);

  // Quitar prefijos tipo "L1:" "L2:"
  d = d.replace(/\bL\d:\s*/gi, "");

  // Limpieza adicional
  d = d.replace(/\s+/g, " ").trim();

  if (!d) return "";

  // Si es muy corta, la dejamos tal cual
  if (d.length <= 220) return d;

  // Recorte suave: intenta cortar cerca de 220 sin partir palabra
  const max = 220;
  const min = 180;

  let cut = d.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > min) cut = cut.slice(0, lastSpace);

  return cut.replace(/[,:;.\s]+$/g, "") + "…";
}

async function main() {
  // 1) Read current file (preserve manualItems)
  let current = { updatedAt: new Date().toISOString(), autoItems: [], manualItems: [] };
  if (fs.existsSync(OUT_PATH)) {
    try {
      current = JSON.parse(fs.readFileSync(OUT_PATH, "utf8"));
    } catch {
      current = { updatedAt: new Date().toISOString(), autoItems: [], manualItems: [] };
    }
  }

  // 2) Fetch feed
  const res = await fetch(FEED_URL, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  const data = await res.json();
  const graph = Array.isArray(data?.["@graph"]) ? data["@graph"] : [];

  // 3) Build autoItems
  const autoItems = [];
  const seen = new Set();

  for (const ev of graph) {
    const title = safeStr(ev.title);
    const descriptionRaw = safeStr(ev.description);
    const text = `${title} ${stripHtmlBasic(descriptionRaw)}`.trim();
    if (!text) continue;

    // Hard excludes (campamentos/campus)
    if (includesAny(text, EXCLUDE_TEXT_KEYS)) continue;

    const venue = safeStr(ev["event-location"]);

    // ✅ Allowlist dura de sedes
    if (!venueAllowed(venue)) continue;

    const sourceType = getSourceType(ev["@type"]);
    if (!sourceType || !ALLOWED_SOURCE_TYPES.has(sourceType)) continue;

    // Exposiciones conditional for “visita con niños”
    if (sourceType === "Exposiciones") {
      const t = norm(text);
      const ok =
        (t.includes("visita") || t.includes("recorrido") || t.includes("guiada")) &&
        (t.includes("niñ") || t.includes("famil") || extractAgeRange(text));
      if (!ok) continue;
    }

    const audienceRaw = safeStr(ev.audience);
    const ageRange = extractAgeRange(text);

    const infantil =
      looksInfantil(text) ||
      norm(audienceRaw).includes("niñ") ||
      norm(audienceRaw).includes("famil") ||
      !!ageRange;

    // Si no es infantil/familia, fuera
    if (!infantil) continue;

    const uid = safeStr(ev.uid);
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);

    const url = ensureUrl(ev);
    if (!url) continue;

    const address = ensureAddress(ev);
    const mapsQuery = buildMapsQuery(venue, address);

    const type = mapType(sourceType, text);

    // ✅ Teatro: solo si es infantil/familiar
    if (type === "teatro" && !isAllowedTheatre(text, ageRange)) continue;

    // ✅ Hora premium: no “00:00” ni medianoche
    const time = timeText(ev);

    // ✅ Description editorial 180–220
    const description = buildEditorialDescription(descriptionRaw);

    autoItems.push({
      uid,
      title,
      venue,
      dtstart: safeStr(ev.dtstart),
      dtend: safeStr(ev.dtend),
      dateText: dateText(ev.dtstart),
      time, // "" si no hay hora real
      type,
      sourceType,
      audience: audienceFinal(audienceRaw, text, ageRange),
      ageRange: ageRange || "",
      free: Number(ev.free) === 1,
      price: safeStr(ev.price),
      link: url,
      address,
      mapsQuery,
      mapsUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapsQuery)}`,
      tags: tagsFor(text, type, ageRange),
      description // ✅ nuevo campo para overlay
    });
  }

  // Sort estable
  autoItems.sort(
    (a, b) =>
      (a.dateText || "").localeCompare(b.dateText || "") ||
      (a.time || "").localeCompare(b.time || "") ||
      a.title.localeCompare(b.title)
  );

  // 4) Output — preserve manualItems EXACTLY
  const out = {
    updatedAt: new Date().toISOString(),
    autoItems,
    manualItems: Array.isArray(current.manualItems) ? current.manualItems : []
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2), "utf8");

  console.log(`OK: wrote ${OUT_PATH}`);
  console.log(`autoItems: ${autoItems.length} · manualItems: ${out.manualItems.length}`);
}

main().catch((err) => {
  console.error("ERROR:", err?.message || err);
  process.exit(1);
});
