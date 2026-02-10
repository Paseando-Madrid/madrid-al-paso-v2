/**
 * scripts/update-expo.js
 * Genera: data/agenda-monthly.json
 *
 * Fuente (JSON oficial Ayuntamiento, próximos 100 días):
 * https://datos.madrid.es/.../agenda-eventos-culturales-100&preview=full
 *
 * Objetivo EXPO (Cooltura):
 * - 8 expos máx. (curación por sedes permitidas)
 * - Acepta @type:
 *    - /actividades/Exposiciones
 *    - /actividades/ProgramacionDestacadaAgendaCultura
 *    - /actividades/ActividadesCulturales (solo si “huele” a expo)
 * - SOLO sedes permitidas (Matadero, Conde Duque, CentroCentro, Telefónica)
 * - Extrae sub-sede (Nave/Sala/Patio/Bóvedas…) si aparece
 * - Extrae horario (time o parseo desde description si aparece)
 * - NO links al Ayuntamiento (no exportamos url como obligatorio)
 * - Pin: Google Maps SEARCH API (permite “Guardar / Quiero ir”)
 */

import fs from "fs";

/** ✅ URL del feed */
const FEED_URL =
  "https://datos.madrid.es/portal/site/egob/menuitem.ac61933d6ee3c31cae77ae7784f1a5a0/?vgnextoid=00149033f2201410VgnVCM100000171f5a0aRCRD&format=json&file=0&filename=206974-0-agenda-eventos-culturales-100&mgmtid=6c0b6d01df986410VgnVCM2000000c205a0aRCRD&preview=full";

/* ================== Helpers ================== */
function safeText(v){ return (v ?? "").toString().trim(); }
function toArray(v){ return Array.isArray(v) ? v : v ? [v] : []; }

function norm(s){
  return safeText(s)
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function pick(obj, path){
  try{
    return path.split(".").reduce((acc,k)=> (acc && acc[k] != null ? acc[k] : undefined), obj);
  }catch{
    return undefined;
  }
}

function parseMadridDate(s){
  const t = safeText(s);
  if(!t) return null;
  const iso = t.replace(" ", "T").replace(/\.0$/, "");
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDateRange(dtstart, dtend){
  const a = parseMadridDate(dtstart);
  const b = parseMadridDate(dtend);
  if(!a && !b) return "";
  const months = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
  const fmt = (d) => `${d.getDate()} ${months[d.getMonth()]}`;
  if(b) return `hasta ${fmt(b)}`;
  return a ? fmt(a) : "";
}

// ✅ Maps SEARCH API → permite “Guardar / Quiero ir”
function mapsUrlFromQuery(q){
  const s = safeText(q);
  return s ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s)}` : "";
}

/* ================== SEDES: canon + aliases ================== */
/**
 * Sede canónica = la familia editorial.
 * Sub-sede (space) se extrae aparte.
 */

const VENUE_CANON = {
  // Canon “tal cual”
  "matadero madrid": "Matadero Madrid",
  "centrocentro": "CentroCentro",
  "centro de cultura contemporanea conde duque": "Centro de Cultura Contemporánea Conde Duque",
  "espacio fundacion telefonica": "Espacio Fundación Telefónica",
};

// Aliases típicos (incluyendo variantes y “salas de…”)
const VENUE_ALIASES = [
  // Matadero
  ["matadero", "Matadero Madrid"],
  ["plaza matadero", "Matadero Madrid"],
  ["madrid artes digitales", "Matadero Madrid"],
  ["nave", "Matadero Madrid"],           // sub-sede se extrae; esto solo asegura familia
  ["intermedia", "Matadero Madrid"],     // Intermediæ suele aparecer como programa/espacio
  ["intermediae", "Matadero Madrid"],

  // Conde Duque
  ["conde duque", "Centro de Cultura Contemporánea Conde Duque"],
  ["salas de exposiciones conde duque", "Centro de Cultura Contemporánea Conde Duque"],
  ["sala de exposiciones conde duque", "Centro de Cultura Contemporánea Conde Duque"],
  ["bovedas", "Centro de Cultura Contemporánea Conde Duque"],
  ["bóvedas", "Centro de Cultura Contemporánea Conde Duque"],
  ["patio", "Centro de Cultura Contemporánea Conde Duque"],

  // CentroCentro / Cibeles
  ["centro centro", "CentroCentro"],
  ["palacio de cibeles", "CentroCentro"],
  ["cibeles", "CentroCentro"],

  // Telefónica
  ["fundacion telefonica", "Espacio Fundación Telefónica"],
  ["fundación telefónica", "Espacio Fundación Telefónica"],
  ["espacio-fundacion-telefonica", "Espacio Fundación Telefónica"],
  ["fundacion-telefonica", "Espacio Fundación Telefónica"],
].map(([a,b]) => [norm(a), b]);

const ALLOWED_VENUES = new Set([
  "Matadero Madrid",
  "Centro de Cultura Contemporánea Conde Duque",
  "CentroCentro",
  "Espacio Fundación Telefónica",
]);

// Fallback fuerte Telefónica (por si no viene en event-location)
const TELEFONICA_FALLBACK = {
  label: "Espacio Fundación Telefónica",
  needles: [
    "espacio fundacion telefonica",
    "fundacion telefonica",
    "fundación telefónica",
    "espacio-fundacion-telefonica",
    "fundacion-telefonica",
  ].map(norm),
};

function canonicalizeVenue(rawVenue, hay){
  const x = norm(rawVenue);
  if(x && VENUE_CANON[x]) return VENUE_CANON[x];

  // alias “contains”
  const h = norm(hay);
  const pool = `${x} | ${h}`;

  for(const [needle, label] of VENUE_ALIASES){
    if(pool.includes(needle)) return label;
  }
  return "";
}

/* ================== TEXT HAYSTACK ================== */
function textHaystack(evt){
  const parts = [
    safeText(evt?.title),
    safeText(evt?.["@id"]),
    safeText(evt?.link),
    safeText(evt?.["event-location"]),
    safeText(evt?.organization?.["organization-name"]),
    safeText(pick(evt, "relation.@id")),
    safeText(evt?.description),
    safeText(pick(evt, "address.area.street-address")),
    safeText(pick(evt, "address.area.locality")),
  ];
  return norm(parts.filter(Boolean).join(" | "));
}

/* ================== TIPOS + FILTROS EXPO ================== */
function typeStr(evt){ return safeText(evt?.["@type"]); }

function isTypeExposiciones(evt){
  return typeStr(evt).includes("/actividades/Exposiciones");
}
function isTypeDestacada(evt){
  return typeStr(evt).includes("/actividades/ProgramacionDestacadaAgendaCultura");
}
function isTypeActividadesCulturales(evt){
  return typeStr(evt).includes("/actividades/ActividadesCulturales");
}

// Señales expo (para destacada/actividades culturales)
const EXPO_KEYS = [
  "exposicion","exposición","exposiciones",
  "muestra",
  "instalacion","instalación",
  "inmersiva","inmersivo",
  "retrospectiva",
  "fotografica","fotográfica",
  "arte digital",
  "proyecto"
].map(norm);

const NOISE_KEYS = [
  "taller","talleres",
  "conferencia","mesa redonda","charla",
  "concierto","teatro","danza",
  "dj","sesion","sesión",
  "curso","seminario"
].map(norm);

function looksExpoByText(evt, hay){
  const t = norm(evt?.title);
  const d = norm(evt?.description);
  const h = norm(hay);
  const blob = `${t} ${d} ${h}`.trim();

  const hasExpo = EXPO_KEYS.some(k => blob.includes(k));
  const hasNoise = NOISE_KEYS.some(k => blob.includes(k));

  // Si hay ruido y NO hay señal expo, fuera.
  if(hasNoise && !hasExpo) return false;

  // Señal expo explícita
  return hasExpo;
}

function isActiveOrUpcoming(evt){
  const now = new Date();
  const dtEnd = parseMadridDate(evt?.dtend);
  const dtStart = parseMadridDate(evt?.dtstart);
  const cutoff = new Date(now.getTime() - 24*60*60*1000);
  if (dtEnd) return dtEnd >= cutoff;
  if (dtStart) return dtStart >= cutoff;
  return true;
}

/* ================== SUBSEDE (SPACE) + HORARIO (HOURS) ================== */
function extractSpace(evt){
  // prioridad: description → relation.@id → title → event-location
  const desc = safeText(evt?.description);
  const rel  = safeText(pick(evt, "relation.@id"));
  const title = safeText(evt?.title);
  const loc = safeText(evt?.["event-location"]);
  const blob = `${desc}\n${rel}\n${title}\n${loc}`;

  const nblob = norm(blob);

  // Naves Matadero
  const naveMatch = nblob.match(/\bnave\s*(\d{1,2})\b/);
  if(naveMatch){
    const num = naveMatch[1];
    // intenta capturar “nave 16. madrid artes digitales”
    const lineMatch = blob.match(new RegExp(`Nave\\s*${num}[^\\n\\.]*([\\.|\\n][^\\n]{0,60})?`, "i"));
    const line = lineMatch ? safeText(lineMatch[0]).replace(/\s+/g," ").trim() : `Nave ${num}`;
    return line;
  }

  // Plaza Matadero
  if(nblob.includes("plaza matadero")) return "Plaza Matadero";

  // Conde Duque: bóvedas / patio / salas
  if(nblob.includes("bovedas") || nblob.includes("bóvedas")) return "Sala de Bóvedas";
  if(nblob.includes("patio")) return "Patio";
  if(nblob.includes("salas de exposiciones")) return "Salas de exposiciones";

  // CentroCentro: plantas
  const planta = nblob.match(/\bplanta\s*(\d)\b/);
  if(planta) return `Planta ${planta[1]}`;

  return "";
}

function extractHours(evt){
  // 1) campo time (si existe)
  const t = safeText(evt?.time);
  if(t) return t.replace(/\s+/g," ").trim();

  // 2) parseo desde description (si contiene “Horario”)
  const desc = safeText(evt?.description);
  if(!desc) return "";

  // Captura bloque tras “Horario” hasta “Espacio/Lugar/Precio/Categoría/Formato/Institución/Programa/Accesibilidad”
  const m = desc.match(/Horario\s*[:\n]\s*([\s\S]{0,400}?)(?:\n\s*(?:Espacio|Lugar|Precio|Categor[ií]a|Formato|Instituci[oó]n|Programa|Accesibilidad)\b|$)/i);
  if(m && m[1]){
    const clean = safeText(m[1]).replace(/\s+\n/g,"\n").trim();
    // compacta espacios, mantiene saltos si hay varios días
    return clean.replace(/[ \t]+/g," ");
  }

  return "";
}

/* ================== RANKING ================== */
function scoreExpo({ venue, title, space, hay }){
  let s = 0;
  const v = norm(venue);
  const t = norm(title);
  const sp = norm(space);
  const h = norm(hay);

  // Sedes prioritarias (ajustable)
  if (v.includes("matadero")) s += 42;
  if (v.includes("fundacion telefonica")) s += 40;
  if (v.includes("conde duque")) s += 36;
  if (v.includes("centrocentro")) s += 34;

  // Bonus por sub-sede informativa
  if (sp.includes("nave")) s += 8;
  if (sp.includes("bovedas") || sp.includes("bóvedas")) s += 6;

  // Señales expo en título
  if (t.includes("expos")) s += 8;
  if (t.includes("inmers")) s += 8;
  if (t.includes("fotograf")) s += 6;

  // penalización por “visita a la exposición” (ruido)
  if (h.includes("visita a la exposicion") || h.includes("visita a la exposición")) s -= 4;

  return s;
}

/* ================== MAIN ================== */
async function main(){
  const res = await fetch(FEED_URL, { headers: { "user-agent": "paseandomadrid-bot/1.0" } });
  if (!res.ok) throw new Error(`Feed fetch failed: ${res.status}`);

  const data = await res.json();
  const graph = toArray(data?.["@graph"]);
  console.log("Total @graph items:", graph.length);

  let kept = 0;

  const candidates = graph.map(evt => {
    if (!evt) return null;

    // fechas
    if (!isActiveOrUpcoming(evt)) return null;

    const hay = textHaystack(evt);

    // sede
    const rawVenue = safeText(evt?.["event-location"]);
    let venue = canonicalizeVenue(rawVenue, hay);

    // fallback Telefónica
    if (!venue) {
      const isTelefonica = TELEFONICA_FALLBACK.needles.some(n => hay.includes(n));
      if (isTelefonica) venue = TELEFONICA_FALLBACK.label;
    }
    if (!venue) return null;

    // SOLO sedes permitidas
    if (!ALLOWED_VENUES.has(venue)) return null;

    // tipos permitidos + condición expo
    const t = typeStr(evt);
    const isExpoType = isTypeExposiciones(evt);
    const isDest = isTypeDestacada(evt);
    const isAct  = isTypeActividadesCulturales(evt);

    // permitimos Exposiciones directo
    // Destacada / Actividades: solo si “huele” a expo por texto
    const ok =
      isExpoType ||
      (isDest && looksExpoByText(evt, hay)) ||
      (isAct  && looksExpoByText(evt, hay));

    if (!ok) return null;

    const title = safeText(evt?.title);
    if (!title) return null;

    // address
    const street = safeText(pick(evt, "address.area.street-address"));

    // dateText
    const dateText = formatDateRange(evt?.dtstart, evt?.dtend);

    // sub-sede + hours
    const space = extractSpace(evt);
    const hours = extractHours(evt);

    // mapsQuery: sede + (street si hay)
    const mapsQuery = [venue, street, "Madrid"].filter(Boolean).join(", ");
    const mapsUrl = mapsUrlFromQuery(mapsQuery);

    kept++;
    return { title, venue, space, hours, dateText, address: street, mapsQuery, mapsUrl, _hay: hay };
  }).filter(Boolean);

  console.log("Kept candidates:", kept, " / ", candidates.length);

  // ranking + dedup
  const seen = new Set();
  const ranked = candidates
    .map(it => ({ ...it, _score: scoreExpo({ venue: it.venue, title: it.title, space: it.space, hay: it._hay }) }))
    .sort((a,b) => b._score - a._score)
    .filter(it => {
      const key = norm(`${it.title}__${it.venue}__${it.space}__${it.address}`);
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

