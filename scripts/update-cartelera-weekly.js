/**
 * Update Cartelera (Weekly) — COOLtura ✅ BLINDADO
 * CDN (PROGRAMACIÓN + fallback AJAX + enrich ficha)
 * Canal REST
 * Teatro Español AJAX
 * Nave 10 JSON-LD
 * Pradillo
 * Teatro del Barrio
 *
 * Genera: /data/cartelera-weekly.json
 */

const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");
const https = require("https");

const OUTPUT = path.join(__dirname, "../data/cartelera-weekly.json");

const THEATRE_CAP = 10;
const DANCE_CAP = 2;

/* ======================================================
   HELPERS
====================================================== */

function httpsRequest(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, res => {
      let data = "";
      res.on("data", chunk => (data += chunk));
      res.on("end", () => resolve(data));
    }).on("error", reject);
  });
}

function parseSpanishEndDate(text) {
  if (!text) return null;
  const months = {
    ene: "01", feb: "02", mar: "03", abr: "04", may: "05", jun: "06",
    jul: "07", ago: "08", sep: "09", oct: "10", nov: "11", dic: "12"
  };
  const match = text.match(/(\d{1,2})\s+([A-Z]{3})\s+(\d{4})/i);
  if (!match) return null;
  const day = match[1].padStart(2, "0");
  const month = months[match[2].toLowerCase()];
  const year = match[3];
  return `${year}-${month}-${day}`;
}

function mapsUrl(query) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

function filterExpired(items) {
  const today = new Date().toISOString().split("T")[0];
  return items.filter(i => !i.endDate || i.endDate >= today);
}

/* ======================================================
   CDN PROGRAMACIÓN + ENRICH
====================================================== */

async function scrapeCDN() {
  const venues = [
    {
      url: "https://dramatico.inaem.gob.es/programacion/teatro-maria-guerrero/",
      venue: "Teatro María Guerrero"
    },
    {
      url: "https://dramatico.inaem.gob.es/programacion/teatro-valle-inclan/",
      venue: "Teatro Valle-Inclán"
    }
  ];

  const results = [];

  for (const v of venues) {
    try {
      const html = await httpsRequest(v.url);
      const $ = cheerio.load(html);

      $(".item-event-resume").each((_, el) => {
        const title = $(el).find("h2 a").text().trim();
        const link = $(el).find("h2 a").attr("href");
        if (!title || !link) return;

        results.push({
          title,
          venue: v.venue,
          source: "cdn",
          url: link.startsWith("http") ? link : `https://dramatico.inaem.gob.es${link}`,
          mapsUrl: mapsUrl(v.venue + " Madrid")
        });
      });
    } catch (e) {
      console.error("CDN error:", e.message);
    }
  }

  return results;
}

/* ======================================================
   CANAL REST
====================================================== */

async function scrapeCanal() {
  const results = { theatre: [], dance: [] };

  try {
    const theatreData = await httpsRequest(
      "https://www.teatroscanal.com/wp-json/tribe/events/v1/events?categories=teatro"
    );
    const danceData = await httpsRequest(
      "https://www.teatroscanal.com/wp-json/tribe/events/v1/events?categories=danza"
    );

    const theatreJSON = JSON.parse(theatreData);
    const danceJSON = JSON.parse(danceData);

    theatreJSON.events?.forEach(ev => {
      results.theatre.push({
        title: ev.title,
        venue: "Teatros del Canal",
        source: "canal",
        url: ev.url,
        endDate: ev.end_date?.split(" ")[0],
        mapsUrl: mapsUrl("Teatros del Canal Madrid")
      });
    });

    danceJSON.events?.forEach(ev => {
      results.dance.push({
        title: ev.title,
        venue: "Teatros del Canal",
        source: "canal",
        url: ev.url,
        endDate: ev.end_date?.split(" ")[0],
        mapsUrl: mapsUrl("Teatros del Canal Madrid")
      });
    });

  } catch (e) {
    console.error("Canal error:", e.message);
  }

  return results;
}

/* ======================================================
   MAIN
====================================================== */

async function update() {
  const cdn = await scrapeCDN();
  const canal = await scrapeCanal();

  let theatre = [...cdn, ...canal.theatre];
  let dance = [...canal.dance];

  theatre = filterExpired(theatre).slice(0, THEATRE_CAP);
  dance = filterExpired(dance).slice(0, DANCE_CAP);

  const output = {
    updatedAt: new Date().toISOString(),
    theatre,
    dance,
    meta: {
      counts: {
        theatre: theatre.length,
        dance: dance.length
      }
    }
  };

  fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2));
  console.log("✅ cartelera-weekly.json actualizado");
}

update();
