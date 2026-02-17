#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import https from "node:https";
import { URL } from "node:url";
import zlib from "node:zlib";
import * as cheerio from "cheerio";

const OUT_PATH = path.join(process.cwd(), "data", "cartelera-weekly.json");

const LIMITS = { theatreMax: 10, danceMax: 2 };

const CAPS_THEATRE = {
  nave10: 2,
  "cdn-maria-guerrero": 1,
  "cdn-valle-inclan": 2,
  teatrodelbarrio: 1,
  pradillo: 1,
  teatroespanol: 1,
  canal: 2,
  matadero: 0
};

const CAPS_DANCE = { canal: 2 };

const MONTHS = {
  enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5,
  julio: 6, agosto: 7, septiembre: 8, setiembre: 8,
  octubre: 9, noviembre: 10, diciembre: 11,
  ene: 0, feb: 1, mar: 2, abr: 3, may: 4, jun: 5, jul: 6, ago: 7, sep: 8, oct: 9, nov: 10, dic: 11
};

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";

function normSpace(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function normMonthKey(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function toMapsUrl(query) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query || "")}`;
}

function toJinaUrl(raw) {
  const u = raw.startsWith("http") ? raw : `https://${raw}`;
  return `https://r.jina.ai/${u}`;
}

function isoToMs(iso) {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? t : Infinity;
}

function parseSpanishStartDate(dateText) {
  const s = normSpace(dateText).toLowerCase();
  if (!s) return "";

  let m = s.match(/\b(\d{1,2})\s+([a-záéíóúñ]+)\s+(\d{4})\s*[-–]\s*(\d{1,2})\s+([a-záéíóúñ]+)\s+(\d{4})\b/i);
  if (m) {
    const d1 = Number(m[1]);
    const mon1 = MONTHS[normMonthKey(m[2])];
    const y1 = Number(m[3]);
    if (Number.isFinite(mon1)) return new Date(y1, mon1, d1, 0, 0, 0).toISOString();
  }

  m = s.match(/\b(\d{1,2})\s*([a-záéíóúñ]{3,})\s*[-–]\s*(\d{1,2})\s*([a-záéíóúñ]{3,})(?:\s*(\d{4}))?/i);
  if (m) {
    const d1 = Number(m[1]);
    const mon1 = MONTHS[normMonthKey(m[2])];
    const mon2 = MONTHS[normMonthKey(m[4])];
    const y2 = m[5] ? Number(m[5]) : new Date().getFullYear();
    let y1 = y2;
    if (Number.isFinite(mon1) && Number.isFinite(mon2) && mon1 > mon2) y1 = y2 - 1;
    if (Number.isFinite(mon1)) return new Date(y1, mon1, d1, 0, 0, 0).toISOString();
  }

  m = s.match(/\b(\d{1,2})\s*([a-záéíóúñ]+)\s*(\d{1,2})\s*([a-záéíóúñ]+)\s*(\d{4})\b/i);
  if (m) {
    const d1 = Number(m[1]);
    const mon1 = MONTHS[normMonthKey(m[2])];
    const y = Number(m[5]);
    if (Number.isFinite(mon1)) return new Date(y, mon1, d1, 0, 0, 0).toISOString();
  }

  m = s.match(/\bdel\s+(\d{1,2})\s+al\s+(\d{1,2})\s+de\s+([a-záéíóúñ]+)\s+de\s+(\d{4})\b/i);
  if (m) {
    const d1 = Number(m[1]);
    const mon = MONTHS[normMonthKey(m[3])];
    const y = Number(m[4]);
    if (Number.isFinite(mon)) return new Date(y, mon, d1, 0, 0, 0).toISOString();
  }

  return "";
}

function parseSpanishEndDate(dateText) {
  const s = normSpace(dateText).toLowerCase();
  if (!s) return "";

  let m = s.match(/\b(\d{1,2})\s+([a-záéíóúñ]+)\s+(\d{4})\s*[-–]\s*(\d{1,2})\s+([a-záéíóúñ]+)\s+(\d{4})\b/i);
  if (m) {
    const d2 = Number(m[4]);
    const mon2 = MONTHS[normMonthKey(m[5])];
    const y2 = Number(m[6]);
    if (Number.isFinite(mon2)) return new Date(y2, mon2, d2, 23, 59, 59).toISOString();
  }

  m = s.match(/\b(\d{1,2})\s*([a-záéíóúñ]{3,})\s*[-–]\s*(\d{1,2})\s*([a-záéíóúñ]{3,})(?:\s*(\d{4}))?/i);
  if (m) {
    const d2 = Number(m[3]);
    const mon1 = MONTHS[normMonthKey(m[2])];
    const mon2 = MONTHS[normMonthKey(m[4])];
    const yHint = m[5] ? Number(m[5]) : new Date().getFullYear();
    let y2 = yHint;
    if (Number.isFinite(mon1) && Number.isFinite(mon2) && mon1 > mon2) y2 = yHint + 1;
    if (Number.isFinite(mon2)) return new Date(y2, mon2, d2, 23, 59, 59).toISOString();
  }

  m = s.match(/\b(\d{1,2})\s*([a-záéíóúñ]+)\s*(\d{1,2})\s*([a-záéíóúñ]+)\s*(\d{4})\b/i);
  if (m) {
    const d2 = Number(m[3]);
    const mon2 = MONTHS[normMonthKey(m[4])];
    const y = Number(m[5]);
    if (Number.isFinite(mon2)) return new Date(y, mon2, d2, 23, 59, 59).toISOString();
  }

  m = s.match(/\bdel\s+(\d{1,2})\s+al\s+(\d{1,2})\s+de\s+([a-záéíóúñ]+)\s+de\s+(\d{4})\b/i);
  if (m) {
    const d2 = Number(m[2]);
    const mon = MONTHS[normMonthKey(m[3])];
    const y = Number(m[4]);
    if (Number.isFinite(mon)) return new Date(y, mon, d2, 23, 59, 59).toISOString();
  }

  return "";
}

function dedupeBy(items, keyFn) {
  const map = new Map();
  for (const it of items) {
    const k = keyFn(it);
    if (!k) continue;
    if (!map.has(k)) map.set(k, it);
  }
  return [...map.values()];
}

function truncateForUI(txt, max = 160) {
  const t = normSpace(txt);
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function sanitizeForOutput(it) {
  return {
    source: it.source,
    kind: it.kind,
    title: it.title,
    credits: truncateForUI(it.credits || "", 160),
    deck: it.deck || "",
    author: it.author || "",
    director: it.director || "",
    company: it.company || "",
    choreographer: it.choreographer || "",
    cast: Array.isArray(it.cast) ? it.cast.slice(0, 6) : [],
    startDate: it.startDate || "",
    endDate: it.endDate || "",
    dateText: it.dateText || "",
    venue: it.venue || "",
    address: it.address || "",
    mapsQuery: it.mapsQuery || "",
    mapsUrl: it.mapsUrl || "",
    link: it.link || "",
    image: it.image || ""
  };
}

function pickWithCaps(items, totalMax, capsBySource) {
  const sorted = [...items].sort((a, b) => {
    const ae = isoToMs(a.endDate);
    const be = isoToMs(b.endDate);
    if (ae !== be) return ae - be;
    return isoToMs(a.startDate) - isoToMs(b.startDate);
  });

  const picked = [];
  const counts = new Map();

  for (const it of sorted) {
    if (picked.length >= totalMax) break;
    const src = it.source || "other";
    if (!(src in capsBySource)) continue;
    const cap = capsBySource[src];
    if (cap === 0) continue;

    const n = counts.get(src) || 0;
    if (n >= cap) continue;
    if (picked.some((p) => p.link && p.link === it.link)) continue;

    picked.push(it);
    counts.set(src, n + 1);
  }

  if (picked.length < totalMax) {
    for (const it of sorted) {
      if (picked.length >= totalMax) break;
      if (picked.some((p) => p.link && p.link === it.link)) continue;
      picked.push(it);
    }
  }

  return picked;
}

function requestRaw(urlStr, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const req = https.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: opts.method || "GET",
        headers: {
          "user-agent": UA,
          accept: "*/*",
          "accept-encoding": "gzip, deflate, br",
          ...opts.headers
        },
        timeout: opts.timeoutMs || 25000
      },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          resolve({ status: res.statusCode || 0, headers: res.headers, body: buf });
        });
      }
    );

    req.on("timeout", () => req.destroy(new Error(`timeout ${urlStr}`)));
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function decodeBody(buf, headers = {}) {
  const enc = String(headers["content-encoding"] || "").toLowerCase();
  try {
    if (enc.includes("br")) return zlib.brotliDecompressSync(buf);
    if (enc.includes("gzip")) return zlib.gunzipSync(buf);
    if (enc.includes("deflate")) return zlib.inflateSync(buf);
  } catch {}
  return buf;
}

async function requestWithRetry(url, opts = {}, retry = {}) {
  const tries = retry.tries || 3;
  const allowStatuses = retry.allowStatuses || [];
  let lastErr;
  let current = url;

  for (let i = 0; i < tries; i++) {
    try {
      const res = await requestRaw(current, opts);

      if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.location) {
        current = new URL(res.headers.location, current).toString();
        continue;
      }

      if (res.status >= 200 && res.status < 300) return res;
      if (allowStatuses.includes(res.status)) return res;
      lastErr = new Error(`HTTP ${res.status} for ${current}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 350 * (i + 1)));
  }

  throw lastErr || new Error(`request failed ${url}`);
}

async function fetchText(url, opts = {}, retry = {}) {
  const res = await requestWithRetry(url, opts, retry);
  const buf = decodeBody(res.body, res.headers);
  return Buffer.from(buf).toString("utf8");
}

function makeBaseItem(partial = {}) {
  return {
    source: "",
    kind: "theatre",
    title: "",
    credits: "",
    deck: "",
    author: "",
    director: "",
    company: "",
    choreographer: "",
    cast: [],
    startDate: "",
    endDate: "",
    dateText: "",
    venue: "",
    address: "",
    mapsQuery: "",
    mapsUrl: "",
    link: "",
    image: "",
    ...partial
  };
}

function cdnVenueMetaByText(text) {
  const t = normSpace(text).toLowerCase();
  if (t.includes("maría guerrero") || t.includes("maria guerrero")) {
    return {
      source: "cdn-maria-guerrero",
      venue: "Teatro María Guerrero",
      address: "C. de Tamayo y Baus, 4, Madrid",
      mapsQuery: "Teatro María Guerrero, Madrid"
    };
  }
  if (t.includes("valle-inclán") || t.includes("valle inclan") || t.includes("valle-inclan")) {
    return {
      source: "cdn-valle-inclan",
      venue: "Teatro Valle-Inclán",
      address: "C. de Plazuela de Ana Diosdado, 1, Madrid",
      mapsQuery: "Teatro Valle-Inclán, Madrid"
    };
  }
  return {
    source: "cdn-valle-inclan",
    venue: "Teatro Valle-Inclán",
    address: "C. de Plazuela de Ana Diosdado, 1, Madrid",
    mapsQuery: "Teatro Valle-Inclán, Madrid"
  };
}

function extractCdnRange(text) {
  const t = normSpace(text);
  const patterns = [
    /\b\d{1,2}\s+[A-ZÁÉÍÓÚÑ]{3}\s*[-–]\s*\d{1,2}\s+[A-ZÁÉÍÓÚÑ]{3}(?:\s+\d{4})?\b/i,
    /\b\d{1,2}\s+[a-záéíóúñ]{3,}\s+\d{4}\s*[-–]\s*\d{1,2}\s+[a-záéíóúñ]{3,}\s+\d{4}\b/i,
    /\bdel\s+\d{1,2}\s+al\s+\d{1,2}\s+de\s+[a-záéíóúñ]+\s+de\s+\d{4}\b/i,
    /\b\d{1,2}\s*[A-Za-zÁÉÍÓÚáéíóúÑñ]+\s*\d{1,2}\s*[A-Za-zÁÉÍÓÚáéíóúÑñ]+\s*\d{4}\b/i
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) return normSpace(m[0]);
  }
  return "";
}

function extractCdnSchedule(text) {
  const lines = String(text || "").replace(/\r/g, "\n").split("\n").map(normSpace).filter(Boolean);
  for (const l of lines) {
    if (/(lunes|martes|mi[eé]rcoles|jueves|viernes|s[áa]bado|domingo|lun|mar|mi[eé]|jue|vie|s[áa]b|dom)/i.test(l) && /(a\s+las\s+\d{1,2}[:\.]\d{2}|\d{1,2}[:\.]\d{2}\s*h?\.?)/i.test(l)) {
      return normSpace(l.split("| Duración")[0].split("|")[0]);
    }
  }
  return "";
}

function parseAuthorDirectorFromText(text) {
  const t = normSpace(text);
  const out = { author: "", director: "" };

  let m = t.match(/\btexto\s+y\s+direcci[oó]n\s*:?\s*([^|·\n]+)/i);
  if (m) {
    out.author = normSpace(m[1]);
    out.director = normSpace(m[1]);
    return out;
  }

  m = t.match(/\b(?:dramaturgia|texto|autor(?:[ií]a)?)\s*:?\s*([^|·\n]+?)(?=\b(?:direcci[oó]n|reparto|elenco|producci[oó]n)\b|$)/i);
  if (m) out.author = normSpace(m[1]);

  m = t.match(/\b(?:direcci[oó]n|versi[oó]n\s+y\s+direcci[oó]n)\s*:?\s*([^|·\n]+?)(?=\b(?:dramaturgia|texto|autor(?:[ií]a)?|reparto|elenco|producci[oó]n)\b|$)/i);
  if (m) out.director = normSpace(m[1]);

  return out;
}

function mergeCdnDateText(rangeText, scheduleText, fallback = "") {
  const range = normSpace(rangeText);
  const sched = normSpace(scheduleText);
  if (range && sched) return `${range} · ${sched}`;
  if (range) return `${range} · Consultar taquilla`;
  return normSpace(fallback);
}

async function fetchCdnSeedLinks(errors) {
  const seeds = [
    "https://dramatico.inaem.gob.es/temporada/temporada-25-26/",
    "https://dramatico.inaem.gob.es/prensa/"
  ];

  const links = new Set();

  for (const seed of seeds) {
    const tries = [seed, toJinaUrl(seed)];
    let ok = false;

    for (const u of tries) {
      try {
        const txt = await fetchText(u, { headers: { accept: u.includes("r.jina.ai") ? "text/plain,*/*;q=0.9" : "text/html,*/*;q=0.9" } }, { tries: 2 });
        const rawMatches = txt.match(/https?:\/\/dramatico\.inaem\.gob\.es\/evento\/[a-z0-9\-]+\/?/gi) || [];
        for (const m of rawMatches) links.add(m.replace(/\/?$/, "/"));

        const $ = cheerio.load(txt);
        $("a[href*='/evento/']").each((_, a) => {
          const href = $(a).attr("href") || "";
          if (!href) return;
          const abs = href.startsWith("http") ? href : `https://dramatico.inaem.gob.es${href}`;
          if (/\/evento\/[a-z0-9\-]+\/?$/i.test(abs)) links.add(abs.replace(/\/?$/, "/"));
        });
        ok = true;
        break;
      } catch (e) {
        errors.push({ source: "cdn", venue: "seed", message: `seed fail ${u}: ${String(e?.message || e)}` });
      }
    }

    if (!ok) errors.push({ source: "cdn", venue: "seed", message: `seed unavailable ${seed}` });
  }

  return [...links];
}

function buildCdnItemFromDom(item, $, rawHtml) {
  const textAll = $.text();

  const title = normSpace($("h1").first().text()) || item.title;

  const detailP = $("div.col-lg-5.col-left .box-title .detail > p").first();
  const rangeFromStrong = normSpace(detailP.find("strong").first().text());
  const htmlP = detailP.html() || "";
  const lines = cheerio.load(`<x>${htmlP.replace(/<br\s*\/?>/gi, "\n")}</x>`)("x").text().split("\n").map(normSpace).filter(Boolean);
  const scheduleFromDetail = lines.find((l) => /a\s+las\s+\d{1,2}[:\.]\d{2}|\d{1,2}[:\.]\d{2}\s*h|lunes|martes|mi[eé]rcoles|jueves|viernes|s[áa]bado|domingo/i.test(l) && l !== rangeFromStrong) || "";

  const range = rangeFromStrong || extractCdnRange(textAll) || extractCdnRange(rawHtml) || extractCdnRange(item.dateText);
  const schedule = scheduleFromDetail || extractCdnSchedule(textAll) || extractCdnSchedule(rawHtml);

  const teamBlockText = $("div.equipo.box-line .content").text() || textAll;
  const team = parseAuthorDirectorFromText(teamBlockText);

  const venueHint = normSpace(`${textAll} ${rawHtml}`);
  const meta = cdnVenueMetaByText(venueHint);

  const enriched = {
    ...item,
    source: item.source || meta.source,
    title: title || item.title,
    venue: item.venue || meta.venue,
    address: item.address || meta.address,
    mapsQuery: item.mapsQuery || meta.mapsQuery,
    mapsUrl: toMapsUrl(item.mapsQuery || meta.mapsQuery),
    author: item.author || team.author,
    director: item.director || team.director,
    image: item.image || $("meta[property='og:image']").attr("content") || $("meta[name='twitter:image']").attr("content") || ""
  };

  if (range) {
    enriched.dateText = mergeCdnDateText(range, schedule, enriched.dateText);
    if (!enriched.startDate) enriched.startDate = parseSpanishStartDate(range);
    if (!enriched.endDate) enriched.endDate = parseSpanishEndDate(range);
  }

  if (!enriched.credits) {
    const bits = [];
    if (enriched.author) bits.push(enriched.author);
    if (enriched.director && enriched.director !== enriched.author) bits.push(enriched.director);
    enriched.credits = truncateForUI(bits.join(" · "), 160);
  }

  return enriched;
}

async function enrichCdnEvent(link, errors) {
  let base = makeBaseItem({ kind: "theatre", link, company: "Centro Dramático Nacional" });

  const directUrl = link;
  const jinaUrl = toJinaUrl(link);

  const tries = [
    { tag: "evento:direct", url: directUrl, accept: "text/html,*/*;q=0.9" },
    { tag: "evento:jina", url: jinaUrl, accept: "text/plain,*/*;q=0.9" }
  ];

  for (const t of tries) {
    try {
      const html = await fetchText(t.url, { headers: { accept: t.accept } }, { tries: 2 });
      const $ = cheerio.load(html);
      base = buildCdnItemFromDom(base, $, html);
      if (t.tag === "evento:jina") errors.push({ source: "cdn", venue: base.source || "cdn", message: `evento:jina:ok ${link}` });
      if (base.title && base.endDate && base.dateText) break;
    } catch (e) {
      if (t.tag === "evento:jina") errors.push({ source: "cdn", venue: "cdn", message: `evento:jina:fail ${link}` });
    }
  }

  if (!base.endDate || !base.dateText || (!base.author && !base.director)) {
    const m = String(link).match(/\/evento\/([^/?#]+)\/?/i);
    if (m) {
      const prensa = `https://dramatico.inaem.gob.es/prensa/${m[1]}/`;
      try {
        const txt = await fetchText(toJinaUrl(prensa), { headers: { accept: "text/plain,*/*;q=0.9" } }, { tries: 2 });
        const $ = cheerio.load(txt);
        base = buildCdnItemFromDom(base, $, txt);
        errors.push({ source: "cdn", venue: base.source || "cdn", message: `prensa:ok ${prensa}` });
      } catch {
        errors.push({ source: "cdn", venue: base.source || "cdn", message: `prensa:fail ${prensa}` });
      }
    } else {
      errors.push({ source: "cdn", venue: "cdn", message: "prensa:fail missing-slug" });
    }
  }

  return base;
}

async function scrapeCDN(errors) {
  const links = await fetchCdnSeedLinks(errors);
  const dedup = [...new Set(links)];
  const out = [];

  for (const link of dedup) {
    try {
      const it = await enrichCdnEvent(link, errors);
      if (!it.title) continue;
      out.push(it);
    } catch (e) {
      errors.push({ source: "cdn", venue: "cdn", message: `event fail ${link}: ${String(e?.message || e)}` });
    }
  }

  const now = Date.now();
  const filtered = out.filter((x) => {
    if (!x.endDate) return false;
    return isoToMs(x.endDate) >= now - 24 * 60 * 60 * 1000;
  });

  errors.push({ source: "cdn", venue: "pipeline", message: `cdn: collected ${out.length}, kept ${filtered.length}` });
  return dedupeBy(filtered, (x) => x.link);
}

function fmtDateShortES(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const day = d.getDate();
  const mon = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"][d.getMonth()];
  return `${day} ${mon}`;
}

function fmtTime(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (hh === "00" && mm === "00") return "";
  return `${hh}:${mm}`;
}

async function scrapeCanal(errors) {
  const url = "https://www.teatroscanal.com/wp-json/tribe/events/v1/events";
  const outTheatre = [];
  const outDance = [];

  try {
    const txt = await fetchText(url, { headers: { accept: "application/json,*/*;q=0.9" } }, { tries: 2 });
    const json = JSON.parse(txt);
    const events = Array.isArray(json?.events) ? json.events : [];

    for (const ev of events) {
      const title = normSpace(ev?.title);
      const link = ev?.url || ev?.website || "";
      if (!title || !link) continue;

      const start = ev?.start_date || ev?.start_date_utc || "";
      const end = ev?.end_date || ev?.end_date_utc || "";
      const catStr = JSON.stringify(ev?.categories || []).toLowerCase();
      const isDance = /danza/.test(catStr);
      const isTheatre = /teatro|en-cartel|en cartel|cartelera/.test(catStr) || !isDance;
      const kind = isDance ? "dance" : (isTheatre ? "theatre" : "theatre");

      const time = fmtTime(start);
      const dateText = `${fmtDateShortES(start)} – ${fmtDateShortES(end)}${time ? ` · ${time}` : ""}`;

      const item = makeBaseItem({
        source: "canal",
        kind,
        title,
        startDate: start ? new Date(start).toISOString() : "",
        endDate: end ? new Date(end).toISOString() : "",
        dateText,
        venue: "Teatros del Canal",
        address: "C. de Cea Bermúdez, 1, Madrid",
        mapsQuery: "Teatros del Canal, Madrid",
        mapsUrl: toMapsUrl("Teatros del Canal, Madrid"),
        link,
        image: ev?.image?.url || ev?.image?.sizes?.medium?.url || ""
      });

      if (item.kind === "dance") outDance.push(item);
      else outTheatre.push(item);
    }
  } catch (e) {
    errors.push({ source: "canal", venue: "canal", message: String(e?.message || e) });
  }

  return { theatre: dedupeBy(outTheatre, (x) => x.link), dance: dedupeBy(outDance, (x) => x.link) };
}

async function scrapeTeatroEspanol(errors) {
  const out = [];
  const url = "https://www.teatroespanol.es";

  try {
    const home = await fetchText(url, { headers: { accept: "text/html,*/*;q=0.9" } }, { tries: 2 });
    const $ = cheerio.load(home);
    const links = new Set();
    $("a[href]").each((_, a) => {
      const href = $(a).attr("href") || "";
      if (/^\/(?!wp-json)(?!sites\/default)/.test(href) && /\w/.test(href)) links.add(`https://www.teatroespanol.es${href}`);
    });

    for (const link of [...links].slice(0, 20)) {
      try {
        const h = await fetchText(link, { headers: { accept: "text/html,*/*;q=0.9" } }, { tries: 1 });
        const $$ = cheerio.load(h);
        const title = normSpace($$("h1").first().text());
        if (!title) continue;
        const dateText = normSpace($$(".date-range, .field--name-field-fechas").first().text());
        const endDate = parseSpanishEndDate(dateText);
        if (!endDate) continue;
        out.push(makeBaseItem({
          source: "teatroespanol",
          kind: "theatre",
          title,
          endDate,
          dateText: dateText || "",
          venue: "Teatro Español",
          address: "Pl. de Santa Ana, 4, Madrid",
          mapsQuery: "Teatro Español, Pl. de Santa Ana, 4, Madrid",
          mapsUrl: toMapsUrl("Teatro Español, Pl. de Santa Ana, 4, Madrid"),
          link,
          image: $$("meta[property='og:image']").attr("content") || ""
        }));
      } catch {}
    }
  } catch (e) {
    errors.push({ source: "teatroespanol", venue: "teatroespanol", message: String(e?.message || e) });
  }

  return dedupeBy(out, (x) => x.link);
}

async function scrapeNave10(errors) {
  const out = [];
  const base = "https://www.nave10matadero.es/actividades";

  try {
    const html = await fetchText(base, { headers: { accept: "text/html,*/*;q=0.9" } }, { tries: 2 });
    const $ = cheerio.load(html);
    const links = new Set();
    $("a[href*='/actividades/']").each((_, a) => {
      const href = $(a).attr("href") || "";
      const abs = href.startsWith("http") ? href : `https://www.nave10matadero.es${href}`;
      if (/\/actividades\//.test(abs)) links.add(abs);
    });

    for (const link of [...links].slice(0, 24)) {
      try {
        const h = await fetchText(link, { headers: { accept: "text/html,*/*;q=0.9" } }, { tries: 1 });
        const $$ = cheerio.load(h);
        const title = normSpace($$("h1").first().text()) || normSpace($$("meta[property='og:title']").attr("content"));
        if (!title) continue;
        const scripts = $$("script[type='application/ld+json']").toArray().map((el) => $$(el).html() || "");
        let startDate = "";
        let endDate = "";
        for (const raw of scripts) {
          try {
            const obj = JSON.parse(raw);
            const arr = Array.isArray(obj) ? obj : [obj];
            for (const x of arr) {
              if (x?.startDate && !startDate) startDate = new Date(x.startDate).toISOString();
              if (x?.endDate && !endDate) endDate = new Date(x.endDate).toISOString();
            }
          } catch {}
        }
        if (!endDate) continue;

        out.push(makeBaseItem({
          source: "nave10",
          kind: "theatre",
          title,
          startDate,
          endDate,
          dateText: "",
          deck: truncateForUI(normSpace($$("meta[name='description']").attr("content") || ""), 200),
          venue: "Nave 10 Matadero",
          address: "Plaza de Legazpi, 8, Madrid",
          mapsQuery: "Nave 10 Matadero, Plaza de Legazpi 8, Madrid",
          mapsUrl: toMapsUrl("Nave 10 Matadero, Plaza de Legazpi 8, Madrid"),
          link,
          image: $$("meta[property='og:image']").attr("content") || ""
        }));
      } catch {}
    }
  } catch (e) {
    errors.push({ source: "nave10", venue: "nave10", message: String(e?.message || e) });
  }

  return dedupeBy(out, (x) => x.link);
}

async function scrapePradillo(errors) {
  const out = [];
  const url = "https://www.teatropradillo.com";
  try {
    const html = await fetchText(url, { headers: { accept: "text/html,*/*;q=0.9" } }, { tries: 2 });
    const $ = cheerio.load(html);
    $("article.et_pb_post").each((_, el) => {
      const title = normSpace($(el).find("h2 a").first().text());
      const href = $(el).find("h2 a").first().attr("href") || "";
      if (!title || !href) return;
      const dateText = normSpace($(el).find(".post-meta, .entry-content").text());
      const endDate = parseSpanishEndDate(dateText);
      if (!endDate) return;
      out.push(makeBaseItem({
        source: "pradillo",
        kind: "theatre",
        title,
        endDate,
        dateText,
        venue: "Teatro Pradillo",
        address: "C. de Pradillo, 12, Madrid",
        mapsQuery: "Teatro Pradillo, Madrid",
        mapsUrl: toMapsUrl("Teatro Pradillo, Madrid"),
        link: href.startsWith("http") ? href : `${url}${href}`
      }));
    });
  } catch (e) {
    errors.push({ source: "pradillo", venue: "pradillo", message: String(e?.message || e) });
  }
  return dedupeBy(out, (x) => x.link);
}

async function scrapeTeatroDelBarrio(errors) {
  const out = [];
  const url = "https://teatrodelbarrio.com";
  try {
    const html = await fetchText(url, { headers: { accept: "text/html,*/*;q=0.9" } }, { tries: 2 });
    const $ = cheerio.load(html);
    $("div.article[id^='post-']").each((_, el) => {
      const a = $(el).find("h2.title a").first();
      const title = normSpace(a.text());
      const href = a.attr("href") || "";
      if (!title || !href) return;
      const dateText = normSpace($(el).text());
      const endDate = parseSpanishEndDate(dateText);
      if (!endDate) return;

      out.push(makeBaseItem({
        source: "teatrodelbarrio",
        kind: "theatre",
        title,
        endDate,
        dateText,
        venue: "Teatro del Barrio",
        address: "C/ de Zurita, 20, Madrid",
        mapsQuery: "Teatro del Barrio, Madrid",
        mapsUrl: toMapsUrl("Teatro del Barrio, Madrid"),
        link: href.startsWith("http") ? href : `${url}${href}`
      }));
    });
  } catch (e) {
    errors.push({ source: "teatrodelbarrio", venue: "teatrodelbarrio", message: String(e?.message || e) });
  }
  return dedupeBy(out, (x) => x.link);
}

function filterActive(items) {
  const now = Date.now();
  return items.filter((it) => {
    const end = isoToMs(it.endDate);
    if (end !== Infinity) return end >= now - 24 * 60 * 60 * 1000;
    const start = isoToMs(it.startDate);
    if (start !== Infinity) return start >= now - 7 * 24 * 60 * 60 * 1000;
    return false;
  });
}

async function main() {
  const errors = [];

  const [cdn, canal, espanol, nave10, pradillo, barrio] = await Promise.all([
    scrapeCDN(errors),
    scrapeCanal(errors),
    scrapeTeatroEspanol(errors),
    scrapeNave10(errors),
    scrapePradillo(errors),
    scrapeTeatroDelBarrio(errors)
  ]);

  const theatreRaw = dedupeBy([
    ...cdn,
    ...canal.theatre,
    ...espanol,
    ...nave10,
    ...pradillo,
    ...barrio
  ], (x) => x.link);

  const danceRaw = dedupeBy([...canal.dance], (x) => x.link);

  const theatreActive = filterActive(theatreRaw);
  const danceActive = filterActive(danceRaw);

  const theatreFinal = pickWithCaps(theatreActive, LIMITS.theatreMax, CAPS_THEATRE).map(sanitizeForOutput);
  const danceFinal = pickWithCaps(danceActive, LIMITS.danceMax, CAPS_DANCE).map(sanitizeForOutput);

  const mixTheatre = theatreFinal.reduce((acc, it) => ((acc[it.source] = (acc[it.source] || 0) + 1), acc), {});
  const mixDance = danceFinal.reduce((acc, it) => ((acc[it.source] = (acc[it.source] || 0) + 1), acc), {});

  const out = {
    updatedAt: new Date().toISOString(),
    theatre: theatreFinal,
    dance: danceFinal,
    meta: {
      counts: {
        theatreCollected: theatreRaw.length,
        danceCollected: danceRaw.length,
        theatreActive: theatreActive.length,
        danceActive: danceActive.length,
        theatreFinal: theatreFinal.length,
        danceFinal: danceFinal.length
      },
      mix: { theatre: mixTheatre, dance: mixDance },
      errors
    }
  };

  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fs.writeFile(OUT_PATH, JSON.stringify(out, null, 2), "utf8");
}

main().catch(async (err) => {
  const fallback = {
    updatedAt: new Date().toISOString(),
    theatre: [],
    dance: [],
    meta: {
      counts: { theatreCollected: 0, danceCollected: 0, theatreActive: 0, danceActive: 0, theatreFinal: 0, danceFinal: 0 },
      mix: { theatre: {}, dance: {} },
      errors: [{ source: "main", venue: "main", message: String(err?.stack || err?.message || err) }]
    }
  };
  try {
    await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
    await fs.writeFile(OUT_PATH, JSON.stringify(fallback, null, 2), "utf8");
  } catch {}
  process.exitCode = 1;
});
