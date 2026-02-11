/**
 * Cooltura — Update ninos-weekly.json (SAFE MODE)
 * - Preserves schema: { updatedAt, autoItems, manualItems }
 * - autoItems is regenerated from municipal feed
 * - manualItems stays as-is from current file (or you can override by hardcoded list)
 *
 * Node 18+ (fetch available)
 */

import fs from "node:fs";
import path from "node:path";

const FEED_URL =
  "https://datos.madrid.es/portal/site/egob/menuitem.ac61933d6ee3c31cae77ae7784f1a5a0/?vgnextoid=00149033f2201410VgnVCM100000171f5a0aRCRD&format=json&file=0&filename=206974-0-agenda-eventos-culturales-100&mgmtid=6c0b6d01df986410VgnVCM2000000c205a0aRCRD&preview=full";

const OUT_PATH = path.join("data", "ninos-weekly.json");

// ========= Filters (closed rules) =========
const BASE_VENUES = [
  "teatro municipal de titeres",
  "teatro municipal de títeres",
  "teatro de titeres del retiro",
  "teatro de títeres del retiro",
  "espacio abierto quinta de los molinos",
  "parque quinta de los molinos",
  "centro cultural galileo",
  "centro cultural casa del reloj",
  "conde duque",
  "centro cultural clara del rey"
];

// “Auto if enters” (do NOT make base venues)
const SOFT_VENUES = ["circo price", "teatro circo price", "caixaforum"];

const SEASON_KEYS = [
  "carnaval",
  "navidad",
  "navideñ",
  "reyes",
  "belén",
  "belen",
  "cabalgata",
  "semana santa",
  "procesión",
  "procesion",
  "pasión",
  "pasion",
  "saeta",
  "verano",
  "cine de verano"
];

const EXCLUDE_KEYS = ["campamento", "campus"];

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
    "peques",
    "bebe",
    "bebes",
    "cuentacuentos",
    "titer",
    "títer",
    "marionet",
    "guiñol"
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

  // diversión en familia
  if (
    t.includes("en familia") ||
    t.includes("familiar") ||
    t.includes("familia") ||
    ["visita", "titeres", "teatro"].includes(type)
  ) {
    tags.add("diversion-en-familia");
  }

  // todos los públicos
  if (
    t.includes("todos los publicos") ||
    t.includes("apto para todos los publicos") ||
    (["visita", "titeres", "teatro"].includes(type) && !ageRange)
  ) {
    tags.add("todos-los-publicos");
  }

  // if age range is narrow, remove todos-los-publicos
  if (ageRange && ageRange.includes("–")) tags.delete("todos-los-publicos");

  return [...tags];
}

function dateText(dtstart) {
  const s = safeStr(dtstart);
  return s ? s.split(" ")[0] : "";
}

function ensureAddress(ev) {
  return safeStr(ev?.address?.["street-address"] || "");
}

function ensureUrl(ev) {
  return safeStr(ev.link || "");
}

function buildMapsQuery(venue, address) {
  const v = safeStr(venue);
  if (v) return `${v} Madrid`;
  const a = safeStr(address);
  if (a) return `${a} Madrid`;
  return "Madrid";
}

async function main() {
  // 1) Read current file (so we preserve manualItems unless you override)
  let current = { updatedAt: new Date().toISOString(), autoItems: [], manualItems: [] };
  if (fs.existsSync(OUT_PATH)) {
    try {
      current = JSON.parse(fs.readFileSync(OUT_PATH, "utf8"));
    } catch {
      // If it breaks, we still output safely
      current = { updatedAt: new Date().toISOString(), autoItems: [], manualItems: [] };
    }
  }

  // 2) Fetch feed
  const res = await fetch(FEED_URL, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  const data = await res.json();
  const graph = Array.isArray(data?.["@graph"]) ? data["@graph"] : [];

  // 3) Build autoItems (match your overlay schema)
  const autoItems = [];
  const seen = new Set();

  for (const ev of graph) {
    const title = safeStr(ev.title);
    const description = safeStr(ev.description);
    const text = `${title} ${description}`.trim();
    if (!text) continue;

    // Hard excludes
    if (includesAny(text, EXCLUDE_KEYS)) continue;

    const venue = safeStr(ev["event-location"]);
    const inBase = venueMatch(venue, BASE_VENUES);
    const inSoft = venueMatch(venue, SOFT_VENUES);
    const inSeason = includesAny(text, SEASON_KEYS);

    // Must be base OR seasonal override OR soft
    if (!(inBase || inSeason || inSoft)) continue;

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
    const infantil = looksInfantil(text) || norm(audienceRaw).includes("niñ") || norm(audienceRaw).includes("famil") || !!ageRange;

    // For seasonal items we still need some family hint
    if (!infantil && !inSeason) continue;

    const uid = safeStr(ev.uid);
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);

    const url = ensureUrl(ev);
    if (!url) continue;

    const address = ensureAddress(ev);
    const mapsQuery = buildMapsQuery(venue, address);

    autoItems.push({
      uid,
      title,
      venue,
      dtstart: safeStr(ev.dtstart),
      dtend: safeStr(ev.dtend),
      dateText: dateText(ev.dtstart),
      time: safeStr(ev.time),
      type: mapType(sourceType, text),
      sourceType,
      audience: audienceFinal(audienceRaw, text, ageRange),
      ageRange: ageRange || "",
      free: Number(ev.free) === 1,
      price: safeStr(ev.price),
      link: url,
      address,
      mapsQuery,
      mapsUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapsQuery)}`,
      tags: tagsFor(text, mapType(sourceType, text), ageRange)
    });
  }

  // Sort stable
  autoItems.sort((a, b) => (a.dateText || "").localeCompare(b.dateText || "") || a.title.localeCompare(b.title));

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
