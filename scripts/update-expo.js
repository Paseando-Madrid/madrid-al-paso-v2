/**
 * scripts/update-expo.js
 * Genera: data/agenda-monthly.json
 *
 * Fuente (JSON oficial Ayuntamiento, próximos 100 días):
 * https://datos.madrid.es/.../agenda-eventos-culturales-100&preview=full
 *
 * Objetivo EXPO (Cooltura):
 * - 8 expos máx. (curadas por sedes “automatizables” dentro del JSON municipal)
 * - Filtrar por @type = /actividades/Exposiciones
 * - Venue principal = event-location (normalizado)
 * - Fallback “Espacio Fundación Telefónica” aunque NO venga en event-location:
 *   - si aparece en title / @id / relation.@id / organization-name
 * - Anti-ruido: NO metemos cosas que no sean Exposiciones
 * - Maps URL con venue + street-address
 */

import fs from "fs";

/** ✅ Pega aquí TU URL completa (la que ya tienes) */
const FEED_URL =
  "https://datos.madrid.es/portal/site/egob/menuitem.ac61933d6ee3c31cae77ae7784f1a5a0/?vgnextoid=00149033f2201410VgnVCM100000171f5a0aRCRD&format=json&file=0&filename=206974-0-agenda-eventos-culturales-100&mgmtid=6c0b6d01df986410VgnVCM2000000c205a0aRCRD&preview=full";

/* ================== Helpers ================== */
function safeText(v){ return (v ?? "").toString().trim(); }
function norm(s){
  return safeText(s)
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function toArray(v){ return Array.isArray(v) ? v : v ? [v] : []; }

function mapsUrlFromQuery(q){
  const s = safeText(q);
  return s ? `https://www.google.com/maps?q=${encodeURIComponent(s)}` : "";
}

function pick(obj, path){
  try{
    return path.split(".").reduce((acc,k)=> (acc && acc[k] != null ? acc[k] : undefined), obj);
  }catch{
    return undefined;
  }
}

function parseMadridDate(s){
  // formatos típicos: "2026-02-24 13:00:00.0" o "2026-05-03 23:59:00.0"
  const t = safeText(s);
  if(!t) return null;
  const iso = t.replace(" ", "T").replace(/\.0$/, "");
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDateRange(dtstart, dtend){
  // editorial compacto: "hasta 3 may" / o "24 feb" si es un día suelto
  const a = parseMadridDate(dtstart);
  const b = parseMadridDate(dtend);
  if(!a && !b) return "";
  const months = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
  const fmt = (d) => `${d.getDate()} ${months[d.getMonth()]}`;
  if(a && b){
    // si dura “mucho”, preferimos "hasta X"
    // (exposiciones suelen tener rango largo)
    return `hasta ${fmt(b)}`;
  }
  if(b) return `hasta ${fmt(b)}`;
  return a ? fmt(a) : "";
}

/* ================== Editorial ================== */
/**
 * En este JSON municipal, lo más fiable para sede es:
 * - event-location
 * Y como fallback: title / @id / relation.@id / organization.organization-name
 *
 * ✅ Lista AUTOMATIZABLE (según lo que ya has visto que aparece en el JSON)
 * - CentroCentro
 * - Matadero Madrid
 * - Centro de Cultura Contemporánea Conde Duque
 * - Sala de exposiciones La Lonja. Centro Cultural Casa del Reloj (Arganzuela)
 * - Museo de San Isidro. Los Orígenes de Madrid
 * + BONUS opcional: Cineteca Madrid (no expo necesariamente; lo marcamos si cae)
 *
 * ⚠️ Fuera del JSON municipal (por eso “recomendadas” manuales):
 * CaixaForum, Fundación MAPFRE, La Casa Encendida, Sala Alcalá 31, etc. (cuando no aparezcan aquí)
 */

const VENUE_CANON = {
  // automatizables
  "centrocentro": "CentroCentro",
  "matadero madrid": "Matadero Madrid",
  "centro de cultura contemporanea conde duque": "Centro de Cultura Contemporánea Conde Duque",
  "sala de exposiciones la lonja. centro cultural casa del reloj (arganzuela)": "Sala de exposiciones La Lonja · Casa del Reloj",
  "museo de san isidro. los origenes de madrid": "Museo de San Isidro",

  // bonus
  "cineteca madrid": "Cineteca Madrid",
};

/** Aliases (variantes habituales) -> canon */
const VENUE_ALIASES = [
  ["centro centro", "CentroCentro"],
  ["centrocentro", "CentroCentro"],
  ["matadero", "Matadero Madrid"],
  ["conde duque", "Centro de Cultura Contemporánea Conde Duque"],
  ["centro de cultura contemporanea conde duque", "Centro de Cultura Contemporánea Conde Duque"],
  ["casa del reloj", "Sala de exposiciones La Lonja · Casa del Reloj"],
  ["la lonja", "Sala de exposiciones La Lonja · Casa del Reloj"],
  ["museo de san isidro", "Museo de San Isidro"],
  ["cineteca", "Cineteca Madrid"],
].map(([a,b]) => [norm(a), b]);

/** ✅ Fallback fuerte para “Espacio Fundación Telefónica” */
const TELEFONICA_FALLBACK = {
  label: "Espacio Fundación Telefónica",
  needles: [
    "espacio fundacion telefonica",
    "fundacion telefonica",
    "espacio-fundacion-telefonica", // por si aparece en @id / URLs internas
    "fundacion-telefonica",
  ].map(norm),
};

function canonicalizeVenue(raw){
  const x = norm(raw);
  if(!x) return "";
  // match directo canon
  if (VENUE_CANON[x]) return VENUE_CANON[x];
  // match por alias contains
  for(const [needle, label] of VENUE_ALIASES){
    if (x.includes(needle)) return label;
  }
  return "";
}

function textHaystack(evt){
  const parts = [
    safeText(evt?.title),
    safeText(evt?.["@id"]),
    safeText(evt?.["event-location"]),
    safeText(evt?.organization?.["organization-name"]),
    safeText(pick(evt, "relation.@id")),
    safeText(pick(evt, "address.area.street-address")),
    safeText(pick(evt, "address.area.locality")),
  ];
  return norm(parts.filter(Boolean).join(" | "));
}

function isExhibition(evt){
  const t = safeText(evt?.["@type"]);
  return t.includes("/actividades/Exposiciones");
}

function isActiveOrUpcoming(evt){
  // Expos “largas”: usamos dtend si existe. Si no, dtstart.
  const now = new Date();
  const dtEnd = parseMadridDate(evt?.dtend);
  const dtStart = parseMadridDate(evt?.dtstart);

  // tolerancia: si terminó ayer, fuera
  const cutoff = new Date(now.getTime() - 24*60*60*1000);

  if (dtEnd) return dtEnd >= cutoff;
  if (dtStart) return dtStart >= cutoff;
  return true; // si no hay fechas (raro), lo dejamos pasar y que el ranking decida
}

function scoreExpo({ venue, title, hay }){
  let s = 0;
  const v = norm(venue);
  const t = norm(title);
  const h = norm(hay);

  // prioriza sedes “premium / objetivo”
  if (v === "centrocentro") s += 40;
  if (v === "matadero madrid") s += 36;
  if (v.includes("conde duque")) s += 34;
  if (v.includes("fundacion telefonica")) s += 38;
  if (v.includes("san isidro")) s += 18;
  if (v.includes("casa del reloj")) s += 14;

  // señales “expo”
  if (t.includes("expos")) s += 6;
  if (t.includes("fotograf")) s += 6;

  // un poco de “ruido” por cosas muy genéricas
  if (h.includes("visita a la exposicion")) s -= 4;

  return s;
}

/* ================== Main ================== */
async function main(){
  const res = await fetch(FEED_URL, { headers: { "user-agent": "paseandomadrid-bot/1.0" } });
  if (!res.ok) throw new Error(`Feed fetch failed: ${res.status}`);

  const data = await res.json();
  const graph = toArray(data?.["@graph"]);
  console.log("Total @graph items:", graph.length);

  let seenExpos = 0;
  let keptAfterFilters = 0;

  const candidates = graph.map(evt => {
    if (!evt) return null;

    // 1) solo Exposiciones
    if (!isExhibition(evt)) return null;
    seenExpos++;

    // 2) solo activas / próximas
    if (!isActiveOrUpcoming(evt)) return null;

    const hay = textHaystack(evt);

    // 3) venue principal por event-location
    const rawVenue = safeText(evt?.["event-location"]);
    let venue = canonicalizeVenue(rawVenue);

    // 4) fallback Telefónica (aunque no venga en event-location)
    if (!venue) {
      const isTelefonica = TELEFONICA_FALLBACK.needles.some(n => hay.includes(n));
      if (isTelefonica) venue = TELEFONICA_FALLBACK.label;
    }

    // 5) si sigue sin venue, fuera (no queremos “sin sede”)
    if (!venue) return null;

    // 6) construir address (el JSON trae street-address dentro de address.area)
    const street = safeText(pick(evt, "address.area.street-address"));
    const address = street || safeText(pick(evt, "address.area.postal-code")) || "";

    const title = safeText(evt?.title);
    const link = safeText(evt?.link);
    const url = link || safeText(evt?.["@id"]) || "";

    const dateText = formatDateRange(evt?.dtstart, evt?.dtend);

    const mapsQuery = [venue, street, "Madrid"].filter(Boolean).join(", ");
    const mapsUrl = mapsUrlFromQuery(mapsQuery);

    // BONUS: si cae Cineteca (raro en Exposiciones), marcamos tag
    const tag = norm(venue) === "cineteca madrid" ? "BONUS" : "";

    keptAfterFilters++;

    return { title, venue, address: street, dateText, url, mapsUrl, ...(tag ? { tag } : {}), _hay: hay };
  }).filter(Boolean);

  console.log("Seen Exposiciones:", seenExpos);
  console.log("Kept after filters:", keptAfterFilters);
  console.log("Expo candidates:", candidates.length);

  // ranking + dedup
  const seen = new Set();
  const ranked = candidates
    .map(it => ({ ...it, _score: scoreExpo({ venue: it.venue, title: it.title, hay: it._hay }) }))
    .sort((a,b) => b._score - a._score)
    .filter(it => {
      const key = norm(`${it.title}__${it.venue}__${it.address}`);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 8)
    .map(({ _score, _hay, ...rest }) => rest);

  const out = {
    updatedAt: new Date().toISOString(),
    groups: [
      {
        category: "exhibitions",
        deck: "Selección automática desde el JSON oficial del Ayuntamiento (próximos 100 días). Curación por sedes.",
        items: ranked
      },
      {
        category: "theatre",
        deck: "Pendiente de automatización (siguiente paso).",
        items: []
      }
    ]
  };

  fs.mkdirSync("data", { recursive:true });
  fs.writeFileSync("data/agenda-monthly.json", JSON.stringify(out, null, 2), "utf8");

  console.log("Expo updated:", ranked.length, "items");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

