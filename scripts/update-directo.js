import fetch from "node-fetch";
import fs from "fs";

const API_KEY = process.env.TICKETMASTER_API_KEY;
if (!API_KEY) throw new Error("Missing TICKETMASTER_API_KEY");

const apiUrl = new URL("https://app.ticketmaster.com/discovery/v2/events.json");
apiUrl.search = new URLSearchParams({
  apikey: API_KEY,
  city: "Madrid",
  countryCode: "ES",
  classificationName: "music",
  size: "12",
  sort: "date,asc",
});

const res = await fetch(apiUrl.toString());
if (!res.ok) throw new Error(`Ticketmaster fetch failed: ${res.status}`);

const data = await res.json();

const items = (data._embedded?.events || []).map((ev) => ({
  title: ev.name,
  venue: ev._embedded?.venues?.[0]?.name || "",
  start: ev.dates?.start?.dateTime || null,
  url: ev.url || null,
}));

const out = {
  updatedAt: new Date().toISOString(),
  items,
};

fs.mkdirSync("data", { recursive: true });
fs.writeFileSync("data/directo-weekly.json", JSON.stringify(out, null, 2), "utf8");

console.log("En Directo updated:", items.length, "items");
