/**
 * scripts/update-expo.js
 * Genera: data/agenda-monthly.json
 *
 * Fuente (JSON oficial Ayuntamiento, próximos 100 días):
 * https://datos.madrid.es/.../agenda-eventos-culturales-100&preview=full
 *
 * Objetivo EXPO (Cooltura):
 * - 10 expos máx. (curación por sedes permitidas + reparto editorial)
 * - Acepta @type:
 *    - /actividades/Exposiciones
 *    - /actividades/ProgramacionDestacadaAgendaCultura
 *    - /actividades/ActividadesCulturales (solo si “huele” a expo)
 * - SOLO sedes permitidas (Matadero, Conde Duque, CentroCentro, Telefónica)
 * - Sub-sede = "space" (Nave/Sala/Patio/Bóvedas…) SOLO visual (no afecta filtro)
 * - Horario: solo si es “real” (evita 00:00 / horas sueltas raras)
 * - NO obliga link al Ayuntamiento
 * - Pin: Google Maps SEARCH API (permite “Guardar / Quiero ir”)
 */

import fs from "fs";

/** ✅ URL del feed */
const FEED_URL =
  "https://datos.madrid.es/portal/site/egob/menuitem.ac61933d6ee3c31cae77ae7784f1a5a0/?vgnextoid=00149033f2201410VgnVCM100000171f5a0aRCRD&format=json&file=0&filename=206974-0-agenda-eventos-culturales-100&mgmtid=6c0b6d01df986410VgnVCM2000000c205a0aRCRD&preview=full";

/* ================== CONFIG EDITORIAL ================== */
const OUT_DECK = "Programación en Madrid · Sedes culturales";

// total items y caps
const MAX_ITEMS = 10;          // antes 8
const MAX_PER_VENUE = 3;       // para evitar “todo Matadero”

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

/* ================== SEDES: match fuerte (sin aliases genéricos) ================== */

const ALLOWED_VENUES = new Set([
  "Matadero Madrid",
  "Centro de Cultura Contemporánea Conde Duque",
  "CentroCentro",
  "Espacio Fundación Telefónica",
]);

/**
 * Necesitamos detectar sede aunque el campo "event-location" venga raro.
 * Estrategia:
 * - Intentar canónico por event-location exacto
 * - Si no, buscar needles fuertes en el haystack (title/desc/rel/address/org)
 * - SIN needles genéricos tipo "nave" o "patio"
 */
const VENUE_RULES = [
  {
    label: "Matadero Madrid",
    needles: [
      "matadero madrid",
      "plaza legazpi",           // direcciones típicas
      "paseo de la chopera",
      "madrid artes digitales",
      "intermediae",
      "intermediæ",
      "plaza matadero",
    ].map(norm),
  },
  {
    label: "Centro de Cultura Contemporánea Conde Duque",
    needles: [
      "conde duque",
      "centro de cultura contemporanea conde duque",
      "salas de exposiciones conde duque",
      "sala de exposiciones conde duque",
      "calle conde duque",
      "calle fuencarral 78",
    ].map(norm),
  },
  {
    label: "CentroCentro",
    needles: [
      "centrocentro",
      "centro centro",
      "palacio de cibeles",
      "cibeles",
      "plaza de cibeles",
    ].map(norm),
  },
  {
    label: "Espacio Fundación Telefónica",
    needles: [
      "espacio fundacion telefonica",
      "fundacion telefonica",
      "fundación telefónica",
      "espacio-fundacion-telefonica",
      "fundacion-telefonica",
      "calle fuencarral 3", // muy típico Telefónica
    ].map(norm),
  },
];

function canonicalizeVenue(rawVenue, hay){
  const raw = norm(rawVenue);
  const h   = norm(hay);
  const pool = `${raw} | ${h}`;

  // match por reglas fuertes
  for(const rule of VENUE_RULES){
    if(rule.needles.some(n => pool.includes(n))) return rule.label;
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
    const lineMatch = blob.match(new RegExp(`Nave\\s*${num}[^\\n\\.]*([\\.|\\n][^\\n]{0,60})?`, "i"));
    const line = lineMatch ? safeText(lineMatch[0]).replace(/\s+/g," ").trim() : `Nave ${num}`;
    return line;
  }

  // Plaza Matadero
  if(nblob.includes("plaza matadero")) return "Plaza Matadero";

  // Conde Duque: bóvedas / patio / salas (solo visual)
  if(nblob.includes("bovedas") || nblob.includes("bóvedas")) return "Sala de Bóvedas";
  if(nblob.includes("patio")) return "Patio";
  if(nblob.includes("salas de exposiciones")) return "Salas de exposiciones";

  // CentroCentro: plantas
  const planta = nblob.match(/\bplanta\s*(\d)\b/);
  if(planta) return `Planta ${planta[1]}`;

  return "";
}

/**
 * Horario “válido”:
 * - Rechaza 00:00
 * - Rechaza horas sueltas tipo "12:00" si no hay rango/contexto
 * - Acepta rangos (9 a 22 / 10:00–19:00 / de 10:00 a 19:00)
 * - Acepta bloques con días (Lunes: ... Martes: ...)
 */
function normalizeHoursText(s){
  const t = safeText(s).replace(/[ \t]+/g," ").trim();
  if(!t) return "";

  const nt = norm(t);

  if(nt === "00:00" || nt === "0:00") return "";

  const hasRange =
    /(\d{1,2}[:\.]\d{2}).*(–|-|a|hasta).*(\d{1,2}[:\.]\d{2})/i.test(t) ||
    /(\d{1,2})\s*(a|hasta)\s*(\d{1,2})/i.test(t) ||
    /\bde\s*\d{1,2}[:\.]\d{2}\s*a\s*\d{1,2}[:\.]\d{2}\b/i.test(t);

  const hasDays =
    /\b(lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo)\b/i.test(t);

  // hora suelta (12:00) sin rango ni días => fuera
  const isSingleTime = /^\d{1,2}[:\.]\d{2}$/.test(t);

  if(isSingleTime && !hasRange && !hasDays) return "";

  // si no hay rango ni días, suele ser poco fiable
  if(!hasRange && !hasDays) return "";

  return t;
}

function extractHours(evt){
  // 1) campo time (si existe)
  const t = normalizeHoursText(evt?.time);
  if(t) return t;

  // 2) parseo desde description (si contiene “Horario”)
  const desc = safeText(evt?.description);
  if(!desc) return "";

  const m = desc.match(/Horario\s*[:\n]\s*([\s\S]{0,500}?)(?:\n\s*(?:Espacio|Lugar|Precio|Categor[ií]a|Formato|Instituci[oó]n|Programa|Accesibilidad)\b|$)/i);
  if(m && m[1]){
    const raw = safeText(m[1]).replace(/\s+\n/g,"\n").trim().replace(/[ \t]+/g," ");
    // intentamos normalizar; si no pasa, lo dejamos vacío
    return normalizeHoursText(raw);
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

/* ================== SELECCIÓN EDITORIAL: 10 items + cap por sede + round-robin ================== */
function selectEditorialTop(items){
  // agrupa por venue
  const byVenue = new Map();
  for(const it of items){
    const k = it.venue || "";
    if(!byVenue.has(k)) byVenue.set(k, []);
    byVenue.get(k).push(it);
  }

  // ordena por score dentro de cada venue
  for(const [k, arr] of byVenue.entries()){
    arr.sort((a,b) => (b._score ?? 0) - (a._score ?? 0));
    byVenue.set(k, arr);
  }

  // round-robin con cap por venue
  const result = [];
  const counts = new Map();

  // orden de sedes (prioridad editorial)
  const venueOrder = [
    "Matadero Madrid",
    "Espacio Fundación Telefónica",
    "Centro de Cultura Contemporánea Conde Duque",
    "CentroCentro",
  ].filter(v => byVenue.has(v));

  // añade cualquier otra (por si un día amplías)
  for(const v of byVenue.keys()){
    if(!venueOrder.includes(v)) venueOrder.push(v);
  }

  let progressed = true;
  while(result.length < MAX_ITEMS && progressed){
    progressed = false;

    for(const v of venueOrder){
      if(result.length >= MAX_ITEMS) break;

      const used = counts.get(v) ?? 0;
      if(used >= MAX_PER_VENUE) continue;

      const arr = byVenue.get(v) || [];
      if(arr.length === 0) continue;

      const next = arr.shift();
      if(next){
        result.push(next);
        counts.set(v, used + 1);
        progressed = true;
      }
    }
  }

  return result.slice(0, MAX_ITEMS);
}

/* ================== MAIN ================== */
async function main(){
  const res = await fetch(FEED_URL, { headers: { "user-agent": "paseandomadrid-bot/1.0" } });
  if (!res.ok) throw new Error(`Feed fetch failed: ${res.status}`);

  const data = await res.json();
  const graph = toArray(data?.["@graph"]);
  console.log("Total @graph items:", graph.length);

  const candidatesRaw = graph.map(evt => {
    if (!evt) return null;

    if (!isActiveOrUpcoming(evt)) return null;

    const hay = textHaystack(evt);

    // sede
    const rawVenue = safeText(evt?.["event-location"]);
    const venue = canonicalizeVenue(rawVenue, hay);
    if (!venue) return null;

    if (!ALLOWED_VENUES.has(venue)) return null;

    // tipos permitidos + condición expo
    const isExpoType = isTypeExposiciones(evt);
    const isDest = isTypeDestacada(evt);
    const isAct  = isTypeActividadesCulturales(evt);

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
    const hours = extractHours(evt); // ya filtrado (si no vale, queda "")

    // mapsQuery: sede + (street si hay)
    const mapsQuery = [venue, street, "Madrid"].filter(Boolean).join(", ");
    const mapsUrl = mapsUrlFromQuery(mapsQuery);

    return { title, venue, space, hours, dateText, address: street, mapsQuery, mapsUrl, _hay: hay };
  }).filter(Boolean);

  console.log("Kept candidates:", candidatesRaw.length);

  // ranking + dedup fuerte
  const seen = new Set();
  const candidates = candidatesRaw
    .map(it => ({ ...it, _score: scoreExpo({ venue: it.venue, title: it.title, space: it.space, hay: it._hay }) }))
    .sort((a,b) => b._score - a._score)
    .filter(it => {
      const key = norm(`${it.title}__${it.venue}__${it.space}__${it.address}`);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  // selección editorial final (10 + cap por sede)
  const ranked = selectEditorialTop(candidates).map(({ _score, _hay, ...rest }) => rest);

  const out = {
    updatedAt: new Date().toISOString(),
    groups: [
      {
        category: "exhibitions",
        deck: OUT_DECK,
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

