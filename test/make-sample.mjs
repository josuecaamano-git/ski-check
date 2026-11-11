// Builds data/latest.json from made-up sample data, to test the page offline.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { build } from "../scripts/fetch.mjs";

const spots = JSON.parse(await readFile(new URL("../spots.json", import.meta.url), "utf8"));
const now = Date.now();

const bulletinGeo = {
  type: "FeatureCollection",
  features: [
    {
      id: "a",
      properties: {
        publicationTime: new Date(now - 3 * 3600e3).toISOString(),
        validTime: { startTime: new Date(now - 3 * 3600e3).toISOString(), endTime: new Date(now + 21 * 3600e3).toISOString() },
        nextUpdate: new Date(now + 5 * 3600e3).toISOString(),
        regions: [{ regionID: "CH-1113", name: "Aigle - Leysin" }, { regionID: "CH-1114", name: "Bex - Villars" }, { regionID: "CH-1111", name: "Vaud Prealps" }],
        highlights: "Fresh wind slabs above 2000 m. Caution on steep shady slopes.",
        dangerRatings: [
          { mainValue: "considerable", elevation: { lowerBound: "2000" }, validTimePeriod: "all_day", customData: { CH: { subdivision: "minus" } } },
          { mainValue: "moderate", elevation: { upperBound: "2000" }, validTimePeriod: "all_day", customData: { CH: { subdivision: "plus" } } },
        ],
        avalancheProblems: [
          { problemType: "wind_slab", dangerRatingValue: "considerable", aspects: ["NW", "N", "NE", "E"], elevation: { lowerBound: "2000" }, validTimePeriod: "all_day", comment: "<p>Fresh wind slabs can be triggered by a single skier.</p>" },
          { problemType: "wet_snow", dangerRatingValue: "moderate", aspects: ["E", "SE", "S", "SW", "W"], elevation: { upperBound: "2400" }, validTimePeriod: "later", comment: "Moist snow avalanches possible in the afternoon." },
        ],
        snowpackStructure: { comment: "Old snow surface is faceted on shady slopes." },
        tendency: [{ highlights: "Slight decrease in danger." }],
      },
      geometry: { type: "Polygon", coordinates: [[[6.9, 46.25], [7.25, 46.25], [7.25, 46.45], [6.9, 46.45], [6.9, 46.25]]] },
    },
    {
      id: "b",
      properties: {
        validTime: { startTime: new Date(now - 3 * 3600e3).toISOString(), endTime: new Date(now + 21 * 3600e3).toISOString() },
        regions: [{ regionID: "CH-1312", name: "Monthey - Val d'Illiez" }],
        highlights: "Generally favourable conditions.",
        dangerRatings: [{ mainValue: "low", elevation: {}, validTimePeriod: "all_day" }],
        avalancheProblems: [],
      },
      geometry: { type: "Polygon", coordinates: [[[6.7, 46.1], [6.9, 46.1], [6.9, 46.25], [6.7, 46.25], [6.7, 46.1]]] },
    },
  ],
};

const stations = [
  { code: "LES2", label: "Leysin / Berneuse", lat: 46.355, lon: 7.01, elevation: 2050 },
  { code: "DIA2", label: "Les Diablerets", lat: 46.33, lon: 7.19, elevation: 2560 },
  { code: "CHA2", label: "Champéry", lat: 46.16, lon: 6.84, elevation: 2010 },
];
const dailySnow = stations.map((s, i) => ({ station_code: s.code, HS: 60 + i * 20, HN_1D: [12, 25, 0][i] }));
const measurements = {};
for (const [i, s] of stations.entries()) {
  const rows = [];
  for (let h = 80; h >= 0; h -= 0.5) {
    rows.push({
      station_code: s.code,
      measure_date: new Date(now - 3600e3 - h * 3600e3).toISOString(),
      HS: 60 + i * 20 - Math.round(h / 4),
      TA_30MIN_MEAN: -4 - i,
      VW_30MIN_MEAN: 4 + i * 3,
      VW_30MIN_MAX: 9 + i * 4 + (h < 10 ? 3 : 0),
      DW_30MIN_MEAN: 300,
    });
  }
  measurements[s.code] = rows;
}

const result = build({ spots, bulletinGeo, stations, dailySnow, measurements });
await mkdir(new URL("../data/", import.meta.url), { recursive: true });
await writeFile(new URL("../data/latest.json", import.meta.url), JSON.stringify(result, null, 1));
for (const s of result.spots) console.log(s.name, "|", s.region?.name, s.region?.matchedBy, "|", s.station?.code, s.station?.distanceKm, "km", s.station?.depthChange72);
