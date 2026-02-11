/**
 * Cooltura — Update ninos-weekly.json (SAFE MODE)
 * - Preserves schema: { updatedAt, autoItems, manualItems }
 * - autoItems is regenerated from municipal feed (embudo editorial por sedes)
 * - manualItems stays as-is from current file
 *
 * Node 18+ (fetch available)
 */

import fs from "node:fs";
import path from "node:path";

const FEED_URL =
  "https://datos.madrid.es/portal/site/egob/menuitem.ac61933d6ee3c31cae77ae7784f1a5a0/?vgnextoid=00149033f2201410VgnVCM100000171f5a0aRCRD&format=json&file=0&filename=206974-0-agenda-eventos-culturales-100&mgmtid=6c0b6d01df986410VgnVCM2000000c205a0aRCRD&preview=full";

const OUT_PATH = path.join("data", "ninos-weekly.json");

// ========= Filters (closed rules) =========
// Embudo fuerte: SOLO sedes curadas (Centro/Chamberí/Legazpi + Retiro/Quinta por decisión editorial)
const BASE_VENUES = [
  // Retiro (títeres)
  "teatro municipal de titeres",
  "teatro municipal de títeres",
  "teatro de titeres del retiro",
  "teatro de títeres del retiro",

  // Quinta (decisión editorial: se mantiene aunque no sea “centro”)
  "espacio abierto quinta de los molinos",
  "parque quinta de los molinos",

  // Chamberí / Centro
  "centro cultural galileo",
  "conde duque",
  "centro de cultura contemporanea conde duque",
  "centro cultural clara del rey",

  // Arganzuela / Legazpi
  "centro cultural casa del reloj",
  "matadero madrid"
];

// “Auto if enters” (do NOT make base venues)
const SOFT_VENUES = ["circo price", "teatro circo price", "caixaforum"];

// Si aparece cualquiera de estos, fuera (aunque sea sede buena)
const EXCLUDE_KEYS = ["campamento", "campus"];

// Tipos de la fuente admitidos
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

function venueMatch(venue, list) {
  const v = norm(venue);
  return list.some((k) => v.includes(norm(k)));
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

// Hora robusta: usa `time` si existe; si no, saca HH:MM de dtstart
function timeText(ev) {
  const t = safeStr(ev?.time);
  if (t) return t;

  const s = safeStr(ev?.dtstart);
  const m = s.match(/(\d{2}:\d{2})/);
  return m ? m[1] : "";
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

// Teatro: solo entra si parece infantil/familiar (evita Lope de Vega + teatro adulto)
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
    const description = safeStr(ev.description);
    const text = `${title} ${description}`.trim();
    if (!text) continue;

    // Hard excludes (campamentos/campus)
    if (includesAny(text, EXCLUDE_KEYS)) continue;

    const venue = safeStr(ev["event-location"]);
    const inBase = venueMatch(venue, BASE_VENUES);
    const inSoft = venueMatch(venue, SOFT_VENUES);

    // ✅ Embudo editorial: SOLO sedes base o soft (NO temporadas por barrios)
    if (!(inBase || inSoft)) continue;

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

    // Si no es infantil/familia, fuera (embudo con niños)
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

    autoItems.push({
      uid,
      title,
      venue,
      dtstart: safeStr(ev.dtstart),
      dtend: safeStr(ev.dtend),
      dateText: dateText(ev.dtstart),
      time: timeText(ev),
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
      tags: tagsFor(text, type, ageRange)
    });
  }

  // Sort stable
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
