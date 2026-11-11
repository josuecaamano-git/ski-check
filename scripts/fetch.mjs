// Fetches the SLF avalanche bulletin and IMIS station data,
// and writes data/latest.json for the page to read.
// Data: WSL Institute for Snow and Avalanche Research SLF (CC BY 4.0), www.slf.ch
// Runs on GitHub Actions every hour (see .github/workflows/update-data.yml).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BULLETIN_URL = "https://aws.slf.ch/api/bulletin/caaml/en/geojson";
const MEAS_BASE = "https://measurement-api.slf.ch/public/api";
const MAX_STATION_KM = 30;

// ---------- helpers ----------

async function getJSON(url) {
  const res = await fetch(url, { headers: { "User-Agent": "ski-check (personal, non-commercial)" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

const DANGER = { low: 1, moderate: 2, considerable: 3, high: 4, very_high: 5 };

function stripHtml(s) {
  if (!s) return "";
  return String(s)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function toBound(v) {
  if (v === undefined || v === null || v === "") return null;
  if (String(v) === "treeline") return "treeline";
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// WGS84 -> Swiss LV95 (swisstopo approximate formula, ~1 m accuracy)
function toLV95(lat, lon) {
  const p = (lat * 3600 - 169028.66) / 10000;
  const l = (lon * 3600 - 26782.5) / 10000;
  const E = 2600072.37 + 211455.93 * l - 10938.51 * l * p - 0.36 * l * p * p - 44.54 * l ** 3;
  const N = 1200147.07 + 308807.95 * p + 3745.25 * l * l + 76.63 * p * p - 194.56 * l * l * p + 119.79 * p ** 3;
  return [E, N];
}

function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointInPolygon(pt, rings) {
  if (!rings?.length || !pointInRing(pt, rings[0])) return false;
  for (let k = 1; k < rings.length; k++) if (pointInRing(pt, rings[k])) return false; // holes
  return true;
}

function firstCoord(geom) {
  let c = geom?.coordinates;
  while (Array.isArray(c) && Array.isArray(c[0])) c = c[0];
  return c;
}

function featureContains(feature, lat, lon) {
  const g = feature?.geometry;
  if (!g) return false;
  const fc = firstCoord(g);
  if (!fc) return false;
  let pt = [lon, lat];
  if (Math.abs(fc[0]) > 1000) {
    const [E, N] = toLV95(lat, lon);
    pt = fc[0] > 2000000 ? [E, N] : [E - 2000000, N - 1000000]; // LV95 or LV03
  }
  if (g.type === "Polygon") return pointInPolygon(pt, g.coordinates);
  if (g.type === "MultiPolygon") return g.coordinates.some((poly) => pointInPolygon(pt, poly));
  return false;
}

function km(lat1, lon1, lat2, lon2) {
  const R = 6371, rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---------- bulletin ----------

function simplifyBulletin(b) {
  if (!b) return null;
  return {
    publicationTime: b.publicationTime ?? null,
    validFrom: b.validTime?.startTime ?? null,
    validTo: b.validTime?.endTime ?? null,
    nextUpdate: b.nextUpdate ?? null,
    highlights: stripHtml(b.highlights),
    dangerRatings: (b.dangerRatings ?? []).map((r) => ({
      level: DANGER[r.mainValue] ?? 0,
      value: r.mainValue ?? null,
      subdivision: r.customData?.CH?.subdivision ?? null,
      lower: toBound(r.elevation?.lowerBound),
      upper: toBound(r.elevation?.upperBound),
      period: r.validTimePeriod ?? "all_day",
    })),
    problems: (b.avalancheProblems ?? []).map((p) => ({
      type: p.problemType ?? "unknown",
      level: DANGER[p.dangerRatingValue] ?? null,
      aspects: (p.aspects ?? []).filter((a) => a && a !== "n/a"),
      lower: toBound(p.elevation?.lowerBound),
      upper: toBound(p.elevation?.upperBound),
      period: p.validTimePeriod ?? "all_day",
      comment: stripHtml(p.comment),
    })),
    snowpack: stripHtml(b.snowpackStructure?.comment),
    travelAdvisory: stripHtml(b.travelAdvisory?.comment),
    tendency: stripHtml((b.tendency ?? []).map((t) => t.highlights || t.comment).filter(Boolean).join(" ")),
  };
}

function findBulletin(spot, features) {
  const byMap = features.find((f) => featureContains(f, spot.lat, spot.lon));
  if (byMap) return { feature: byMap, matchedBy: "map" };
  const byId = features.find((f) => (f.properties?.regions ?? []).some((r) => r.regionID === spot.fallbackRegion));
  if (byId) return { feature: byId, matchedBy: "region-list" };
  return { feature: null, matchedBy: null };
}

function regionName(feature, spot) {
  const regions = feature?.properties?.regions ?? [];
  const exact = regions.find((r) => r.regionID === spot.fallbackRegion);
  return (exact ?? regions[0])?.name ?? null;
}

// ---------- stations ----------

function nearestStations(spot, stations, withSnow) {
  return stations
    .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon) && withSnow.has(s.code))
    .map((s) => ({ ...s, distanceKm: km(spot.lat, spot.lon, s.lat, s.lon) }))
    .filter((s) => s.distanceKm <= MAX_STATION_KM)
    .sort((a, b) => a.distanceKm - b.distanceKm);
}

function summariseMeasurements(rows, daily) {
  const sorted = [...(rows ?? [])]
    .filter((r) => r.measure_date)
    .sort((a, b) => new Date(a.measure_date) - new Date(b.measure_date));
  if (!sorted.length) return null;
  const last = sorted[sorted.length - 1];
  const t = new Date(last.measure_date).getTime();
  const lastWith = (key) => [...sorted].reverse().find((r) => r[key] !== null && r[key] !== undefined);
  const hsAt = (hoursAgo) => {
    const target = t - hoursAgo * 3600e3;
    let best = null;
    for (const r of sorted) {
      if (r.HS === null || r.HS === undefined) continue;
      const d = Math.abs(new Date(r.measure_date).getTime() - target);
      if (d <= 2 * 3600e3 && (!best || d < best.d)) best = { d, v: r.HS };
    }
    return best?.v ?? null;
  };
  const hs = lastWith("HS")?.HS ?? null;
  const last24 = sorted.filter((r) => new Date(r.measure_date).getTime() >= t - 24 * 3600e3);
  const gusts = last24.map((r) => r.VW_30MIN_MAX).filter((v) => v !== null && v !== undefined);
  const round = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);
  const hs24 = hsAt(24), hs72 = hsAt(72);
  return {
    measuredAt: last.measure_date,
    snowDepth: round(hs),
    newSnow24: round(daily?.HN_1D ?? null),
    depthChange24: hs !== null && hs24 !== null ? round(hs - hs24) : null,
    depthChange72: hs !== null && hs72 !== null ? round(hs - hs72) : null,
    airTemp: round(lastWith("TA_30MIN_MEAN")?.TA_30MIN_MEAN ?? null),
    windMean: round(lastWith("VW_30MIN_MEAN")?.VW_30MIN_MEAN ?? null),
    windGust: round(lastWith("VW_30MIN_MAX")?.VW_30MIN_MAX ?? null),
    windDir: round(lastWith("DW_30MIN_MEAN")?.DW_30MIN_MEAN ?? null),
    windGustMax24: gusts.length ? round(Math.max(...gusts)) : null,
  };
}

// ---------- main build (pure, testable) ----------

export function build({ spots, bulletinGeo, stations, dailySnow, measurements, errors = [] }) {
  const features = bulletinGeo?.features ?? [];
  const dailyByCode = new Map((dailySnow ?? []).map((d) => [d.station_code, d]));
  const withSnow = new Set((dailySnow ?? []).filter((d) => d.HS !== null).map((d) => d.station_code));
  if (!withSnow.size) (stations ?? []).forEach((s) => withSnow.add(s.code));

  const out = spots.map((spot) => {
    const { feature, matchedBy } = findBulletin(spot, features);
    const candidates = nearestStations(spot, stations ?? [], withSnow);
    let station = null;
    for (const c of candidates) {
      const summary = summariseMeasurements(measurements?.[c.code], dailyByCode.get(c.code));
      if (summary) {
        station = { code: c.code, name: c.label, elevation: c.elevation, distanceKm: Math.round(c.distanceKm * 10) / 10, ...summary };
        break;
      }
    }
    return {
      id: spot.id, name: spot.name, top: spot.top,
      region: feature ? { name: regionName(feature, spot), matchedBy } : null,
      bulletin: simplifyBulletin(feature?.properties),
      station,
      stationCandidates: candidates.slice(0, 3).map((c) => c.code),
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    bulletinAvailable: features.length > 0,
    source: "WSL Institute for Snow and Avalanche Research SLF (CC BY 4.0) — www.slf.ch",
    errors,
    spots: out,
  };
}

async function main() {
  const spots = JSON.parse(await readFile(path.join(ROOT, "spots.json"), "utf8"));
  const errors = [];
  const safe = async (label, fn, fallback) => {
    try { return await fn(); } catch (e) { errors.push(`${label}: ${e.message}`); console.error(label, e.message); return fallback; }
  };

  const [bulletinGeo, stations, dailySnow] = await Promise.all([
    safe("bulletin", () => getJSON(BULLETIN_URL), { features: [] }),
    safe("stations", () => getJSON(`${MEAS_BASE}/imis/stations`), []),
    safe("daily-snow", () => getJSON(`${MEAS_BASE}/imis/daily-snow`), []),
  ]);

  // Only download measurements for the few stations near our spots.
  const withSnow = new Set(dailySnow.filter((d) => d.HS !== null).map((d) => d.station_code));
  if (!withSnow.size) stations.forEach((s) => withSnow.add(s.code));
  const codes = new Set();
  for (const spot of spots) nearestStations(spot, stations, withSnow).slice(0, 3).forEach((s) => codes.add(s.code));
  const measurements = {};
  for (const code of codes) {
    measurements[code] = await safe(`measurements ${code}`, () =>
      getJSON(`${MEAS_BASE}/imis/station/${encodeURIComponent(code)}/measurements`), []);
  }

  const result = build({ spots, bulletinGeo, stations, dailySnow, measurements, errors });
  await mkdir(path.join(ROOT, "data"), { recursive: true });
  await writeFile(path.join(ROOT, "data", "latest.json"), JSON.stringify(result, null, 1));
  for (const s of result.spots) {
    console.log(`${s.name}: region=${s.region?.name ?? "-"} (${s.region?.matchedBy ?? "none"}), station=${s.station?.code ?? "-"}`);
  }
  if (errors.length) console.log("Errors:", errors);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
