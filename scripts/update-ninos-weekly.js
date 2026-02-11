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

/* ==========================================================
   🎯 ALLOWLIST DURA — SOLO ESTAS SEDES
   ========================================================== */

const ALLOWED_VENUES = [
  "matadero madrid",
  "centro cultural casa del reloj",
  "centro cultural galileo",
  "centro de cultura contemporanea conde duque",
  "centro de cultura contemporánea conde duque",
  "conde duque",
  "centro cultural clara del rey",
  "museo abc",

  // Retiro
  "teatro municipal de titeres",
  "teatro municipal de títeres"
];

// Exclusión explícita
const EXCLUDE_VENUE_KEYS = [
  "centro cultural lope de vega"
];

const EXCLUDE_TEXT_KEYS = ["campamento", "campus"];

const ALLOWED_SOURCE_TYPES = new Set([
  "ProgramacionDestacadaAgendaCultura",
  "Talleres",
  "TeatroPerformance",
  "ActividadesCulturales",
  "CuentacuentosTiteresMarionetas",
  "ExcursionesItinerariosVisitas",
  "FiestasCarnavales",
  "Exposiciones"
]);

/* ==========================================================
   UTILIDADES
   ========================================================== */

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

  return null;
}

function mapType(sourceType, text) {
  const t = norm(text);

  if (sourceType === "Talleres") return "taller";

  if (sourceType === "TeatroPerformance") {
    if (t.includes("titer") || t.includes("títer") || t.includes("marionet") || t.includes("guiñol")) return "titeres";
    if (t.includes("circo") || t.includes("magia")) return "familia";
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

function dateText(dtstart) {
  const s = safeStr(dtstart);
  return s ? s.split(" ")[0] : "";
}

function isMidnightDtstart(dtstart) {
  const s = safeStr(dtstart);
  return /(\s|T)00:00:00(\.0+)?/.test(s);
}

function timeText(ev) {
  const raw = safeStr(ev?.time);
  const dt  = safeStr(ev?.dtstart);

  if (isMidnightDtstart(dt)) return "";
  if (raw && raw !== "00:00") return raw;

  const m = dt.match(/(\d{2}:\d{2})/);
  if (!m) return "";
  return m[1] === "00:00" ? "" : m[1];
}

function stripHtmlBasic(s) {
  return safeStr(s)
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/p>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildEditorialDescription(raw) {
  let d = stripHtmlBasic(raw);
  d = d.replace(/\bL\d:\s*/gi, "");
  if (!d) return "";
  if (d.length <= 220) return d;

  const max = 220;
  const min = 180;
  let cut = d.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > min) cut = cut.slice(0, lastSpace);
  return cut.replace(/[,:;.\s]+$/g, "") + "…";
}

/* ==========================================================
   MAIN
   ========================================================== */

async function main() {

  let current = { updatedAt: new Date().toISOString(), autoItems: [], manualItems: [] };
  if (fs.existsSync(OUT_PATH)) {
    try {
      current = JSON.parse(fs.readFileSync(OUT_PATH, "utf8"));
    } catch {}
  }

  const res = await fetch(FEED_URL, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  const data = await res.json();
  const graph = Array.isArray(data?.["@graph"]) ? data["@graph"] : [];

  const autoItems = [];
  const seen = new Set();

  for (const ev of graph) {

    const title = safeStr(ev.title);
    const descriptionRaw = safeStr(ev.description);
    const text = `${title} ${stripHtmlBasic(descriptionRaw)}`.trim();
    if (!text) continue;

    if (includesAny(text, EXCLUDE_TEXT_KEYS)) continue;

    const venue = safeStr(ev["event-location"]);
    if (!venueAllowed(venue)) continue;

    const sourceType = getSourceType(ev["@type"]);
    if (!sourceType || !ALLOWED_SOURCE_TYPES.has(sourceType)) continue;

    const ageRange = extractAgeRange(text);
    const infantil = looksInfantil(text) || !!ageRange;
    if (!infantil) continue;

    const uid = safeStr(ev.uid);
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);

    const url = safeStr(ev.link);
    if (!url) continue;

    const address = safeStr(ev?.address?.["street-address"] || "");
    const mapsQuery = venue ? `${venue} Madrid` : "Madrid";

    const time = timeText(ev);
    const description = buildEditorialDescription(descriptionRaw);

    autoItems.push({
      uid,
      title,
      venue,
      dtstart: safeStr(ev.dtstart),
      dtend: safeStr(ev.dtend),
      dateText: dateText(ev.dtstart),
      time,
      type: mapType(sourceType, text),
      sourceType,
      ageRange: ageRange || "",
      free: Number(ev.free) === 1,
      price: safeStr(ev.price),
      link: url,
      address,
      mapsQuery,
      mapsUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapsQuery)}`,
      description
    });
  }

  autoItems.sort((a, b) =>
    (a.dateText || "").localeCompare(b.dateText || "") ||
    (a.time || "").localeCompare(b.time || "") ||
    a.title.localeCompare(b.title)
  );

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
