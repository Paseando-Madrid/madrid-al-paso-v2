/**
 * scripts/update-expo.js
 * Genera: data/agenda-monthly.json
 * Fuente: Open Data esMadrid (XML)
 * Objetivo: EXPO curada por sedes (prioridad) + fotografía + anti-ruido.
 *
 * NOTA:
 * - Node 18+ (GitHub Actions) trae fetch global.
 * - Requiere: fast-xml-parser
 */

import fs from "fs";
import { XMLParser } from "fast-xml-parser";

const FEED_URL = "https://www.esmadrid.com/opendata/agenda_v1_es.xml";

/* ================== Editorial: sedes objetivo ================== */
const VENUE_PRIORITY = [
  "fundación telefónica",
  "espacio fundación telefónica",
  "fundacion telefonica",
  "fundación mapfre",
  "fundacion mapfre",
  "coam",
  "colegio oficial de arquitectos",
  "colegio oficial de arquitectos de madrid",
  "casa encendida",
  "la casa encendida",
  "círculo de bellas artes",
  "circulo de bellas artes",
  "matadero",
  "caixaforum",
  "caixa forum",
  "tabacalera",
  "conde duque",
  "condeduque",
  "centrocentro",
  "centro centro"
].map(norm);

/* ================== Keywords EXPO (señales) ================== */
const EXPO_KEYS = [
  "exposición", "exposicion", "exposiciones",
  "fotografía", "fotografia", "foto", "photography",
  "muestra", "retrospectiva", "instalación", "instalacion",
  "comisari", "colección", "coleccion",
  "arte", "galería", "galeria",
  "contemporáneo", "contemporaneo"
].map(norm);

/* ================== Anti-ruido (no queremos en EXPO) ================== */
const EXCLUDE_KEYS = [
  "fútbol", "futbol", "baloncesto", "tenis", "atletico", "atlético",
  "real madrid", "copa", "liga", "partido", "semifinal", "ida", "vuelta",
  "concierto", "gira", "tour", "entradas", "vip",
  "teatro", "musical", "ópera", "opera", "danza", "performance"
].map(norm);

/* ================== Helpers ================== */
function safeText(v){ return (v ?? "").toString().trim(); }

function norm(s){
  return safeText(s)
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function decodeHtmlEntities(str){
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

function toArray(v){
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
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

function toISODateGuess(v){
  const s = safeText(v);
  if(!s) return null;

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

  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function fmtRange(startISO, endISO){
  // Texto editorial simple (sin horas)
  const fmt = (iso) => {
    if(!iso) return "";
    try{
      const d = new Date(iso);
      return d.toLocaleDateString("es-ES", { day:"2-digit", month:"short", year:"numeric" });
    }catch{ return ""; }
  };
  const a = fmt(startISO);
  const b = fmt(endISO);
  if(a && b) return `${a} → ${b}`;
  return a || b || "";
}

function mapsUrlFromQuery(q){
  const query = safeText(q);
  if(!query) return null;
  return `https://www.google.com/maps?q=${encodeURIComponent(query)}`;
}

function haystack(ev){
  // texto completo del evento (para detectar sedes y keywords aunque estén en campos raros)
  return norm(decodeHtmlEntities(deepStrings(ev).join(" | ")));
}

/* ================== Extracción “loose” ================== */
function pickTitle(ev){
  const raw = pickFirst(ev, ["title", "titulo", "name", "nombre"]);
  return decodeHtmlEntities(raw) || "—";
}

function pickUrl(ev){
  const u = pickFirst(ev, ["url", "link", "enlace", "web"]);
  return safeText(u) || null;
}

function pickDates(ev){
  const startRaw = pickFirst(ev, [
    "start","inicio","fechaInicio","fechainicio","dateStart","datestart","fecha","date"
  ]);
  const endRaw = pickFirst(ev, [
    "end","fin","fechaFin","fechafin","dateEnd","dateend"
  ]);
  return { start: toISODateGuess(startRaw), end: toISODateGuess(endRaw) };
}

function pickVenueLoose(ev){
  return safeText(pickFirst(ev, [
    "venue","lugar","place","localizacion","localización","location",
    "organizer","organizador","centro","espacio","entidad"
  ]));
}

function pickAddressLoose(ev){
  return safeText(pickFirst(ev, ["address","direccion","dirección","streetAddress","dir"]));
}

function inferVenueFromUrlOrText(url, h){
  // 1) si el haystack contiene una sede prioritaria → esa
  const hit = VENUE_PRIORITY.find(v => h.includes(v));
  if(hit) return hit;

  // 2) inferir por URL (slug) cuando el XML no rellena “venue”
  const u = norm(url || "");
  const rules = [
    ["fundacion-telefonica", "Fundación Telefónica"],
    ["fundacion-mapfre", "Fundación MAPFRE"],
    ["coam", "COAM"],
    ["casa-encendida", "La Casa Encendida"],
    ["circulo-bellas-artes", "Círculo de Bellas Artes"],
    ["matadero", "Matadero"],
    ["caixaforum", "CaixaForum"],
    ["tabacalera", "Tabacalera"],
    ["conde-duque", "CondeDuque"],
    ["condeduque", "CondeDuque"],
    ["centrocentro", "CentroCentro"],
    ["centro-centro", "CentroCentro"],
    ["fundacion-ortega-maranon", "Fundación Ortega-Marañón"],
    ["museo-del-prado", "Museo del Prado"],
    ["museo-reina-sofia", "Museo Reina Sofía"],
    ["thyssen", "Museo Thyssen-Bornemisza"]
  ];
  for (const [needle, label] of rules){
    if(u.includes(needle)) return label;
  }

  return "";
}

/* ================== Clasificación EXPO ================== */
function hasExpoSignals(h, title, url){
  const t = norm(title);
  const u = norm(url || "");
  const signal =
    EXPO_KEYS.some(k => h.includes(k) || t.includes(k)) ||
    u.includes("exposicion") || u.includes("exposiciones") ||
    // si está en sedes prioridad, le damos pase aunque el texto venga “pobre”
    VENUE_PRIORITY.some(v => h.includes(v));
  return signal;
}

function hasExcludedSignals(h, title, url){
  const t = norm(title);
  const u = norm(url || "");
  const noisy = EXCLUDE_KEYS.some(k => h.includes(k) || t.includes(k) || u.includes(k));
  return noisy;
}

function scoreItem(item){
  // ranking editorial (en vez de “si no cumple, fuera”)
  let s = 0;
  const t = norm(item.title);
  const v = norm(item.venue);
  const u = norm(item.url || "");
  const h = norm(item._hay || "");

  // sedes prioridad muy arriba
  if (v && VENUE_PRIORITY.some(p => v.includes(p))) s += 30;
  if (VENUE_PRIORITY.some(p => h.includes(p))) s += 15;

  // fotografía arriba
  if (t.includes("fotograf")) s += 12;

  // señales expo
  if (EXPO_KEYS.some(k => t.includes(k))) s += 6;
  if (u.includes("agenda")) s += 2;

  // penalizaciones
  if (!item.venue) s -= 4;
  if (hasExcludedSignals(h, item.title, item.url)) s -= 100;

  return s;
}

/* ================== Main ================== */
async function main(){
  const res = await fetch(FEED_URL, {
    headers: { "user-agent": "paseandomadrid-bot/1.0" },
    cache: "no-store"
  });
  if (!res.ok) throw new Error(`esmadrid fetch failed: ${res.status}`);

  const xml = await res.text();
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    parseTagValue: true,
    trimValues: true
  });
  const parsed = parser.parse(xml);

  // localizar eventos (estructura típica esMadrid)
  const root = parsed?.agenda ?? parsed?.response ?? parsed;
  const events =
    root?.eventos?.evento ||
    root?.eventos ||
    root?.events?.event ||
    root?.events ||
    root?.evento ||
    [];

  const list = toArray(events);

  // 1) candidatos: cualquier cosa con url+title (si el feed viene “suelto”, esto salva)
  const candidates = list
    .map(ev => {
      const title = pickTitle(ev);
      const url = pickUrl(ev);
      if(!title || !url) return null;

      const h = haystack(ev);
      const { start, end } = pickDates(ev);

      let venue = pickVenueLoose(ev);
      let address = pickAddressLoose(ev);

      if(!venue) venue = inferVenueFromUrlOrText(url, h);

      const dateText = fmtRange(start, end);
      const mapsUrl = mapsUrlFromQuery([venue || title, "Madrid"].filter(Boolean).join(", "));

      return {
        title,
        venue,
        address: address || "",
        start,
        end,
        dateText,
        url,
        mapsUrl,
        _hay: h
      };
    })
    .filter(Boolean);

  // 2) filtro “suave”: señal expo + no ruido
  const expoCandidates = candidates.filter(it => {
    const h = it._hay || "";
    return hasExpoSignals(h, it.title, it.url) && !hasExcludedSignals(h, it.title, it.url);
  });

  // 3) ranking editorial + dedup
  const seen = new Set();
  const ranked = expoCandidates
    .map(it => ({ ...it, _score: scoreItem(it) }))
    .sort((a,b) => b._score - a._score)
    .filter(it => {
      const key = norm(`${it.title}__${it.venue}`);
      if(seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 8)
    .map(({ _score, _hay, ...rest }) => rest);

  // 4) Fallback (clave): si por lo que sea quedó vacío, llenamos con “lo mejor disponible”
  //    (pero siempre respetando anti-ruido)
  if (ranked.length === 0) {
    const seen2 = new Set();
    const fallback = candidates
      .map(it => ({ ...it, _score: scoreItem(it) }))
      .filter(it => !hasExcludedSignals(it._hay || "", it.title, it.url))
      .sort((a,b) => b._score - a._score)
      .filter(it => {
        const key = norm(`${it.title}__${it.venue}`);
        if(seen2.has(key)) return false;
        seen2.add(key);
        return true;
      })
      .slice(0, 8)
      .map(({ _score, _hay, ...rest }) => rest);

    ranked.push(...fallback);
  }

  const out = {
    updatedAt: new Date().toISOString(),
    groups: [
      {
        category: "exhibitions",
        deck: "Selección automática desde agenda cultural de Madrid (curada por prioridad editorial).",
        items: ranked
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

  console.log("Expo updated:", ranked.length, "items");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
