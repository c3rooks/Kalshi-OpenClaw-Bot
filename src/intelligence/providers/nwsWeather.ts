import type { WeatherProbabilityProvider } from "./weather";
import { getWeatherCalibrationSettings } from "../../intel/weatherCalibration";

type CacheRow<T> = { value: T; expiresAt: number };
type HourBucket = { startMs: number; endMs: number };

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function normalCdf(z: number): number {
  return 0.5 * (1 + Math.tanh(Math.sqrt(Math.PI / 8) * z));
}

function floorHour(ms: number): number {
  return Math.floor(ms / 3_600_000) * 3_600_000;
}

function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function makeRng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function randn(rng: () => number): number {
  const u1 = Math.max(1e-9, rng());
  const u2 = Math.max(1e-9, rng());
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function parseDurationMs(duration: string): number {
  const m = duration.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/i);
  if (!m) return 0;
  const d = Number(m[1] ?? 0);
  const h = Number(m[2] ?? 0);
  const min = Number(m[3] ?? 0);
  return ((d * 24 + h) * 60 + min) * 60 * 1000;
}

function parseValidTime(raw: unknown): { startMs: number; endMs: number } | null {
  const s = String(raw ?? "");
  const parts = s.split("/");
  if (parts.length < 2) return null;
  const startMs = Date.parse(parts[0]);
  if (!Number.isFinite(startMs)) return null;
  const durMs = parseDurationMs(parts[1]);
  if (!(durMs > 0)) return null;
  return { startMs, endMs: startMs + durMs };
}

function overlapMs(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

function normalizeUnitToInches(value: number, unit: string | undefined): number {
  if (!Number.isFinite(value)) return NaN;
  const u = String(unit ?? "").toLowerCase();
  if (u.includes("mm")) return value / 25.4;
  if (u.includes("cm")) return value / 2.54;
  if (u.includes("m")) return (value * 100) / 2.54;
  if (u.includes("in")) return value;
  return value;
}

async function fetchJson(url: string): Promise<any> {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "openclaw-kalshi-bot/2.0",
      Accept: "application/geo+json,application/json"
    }
  });
  if (!resp.ok) return null;
  return resp.json();
}

function extractLocation(question: string): string | null {
  const q = String(question || "");
  const m1 = q.match(/(?:in|at|for)\s+([A-Za-z][A-Za-z\s.\-']+,\s*[A-Za-z]{2})/i);
  if (m1) return m1[1].trim();
  const m2 = q.match(/\b([A-Za-z][A-Za-z\s.\-']+,\s*[A-Za-z]{2})\b/);
  if (m2) return m2[1].trim();
  return null;
}

function inferWeatherKind(question: string): "TEMP" | "RAIN" | "SNOW" {
  const q = String(question || "").toLowerCase();
  if (/snow|sleet|blizzard/.test(q)) return "SNOW";
  if (/temp|temperature|high|low|fahrenheit|celsius|°f|°c/.test(q)) return "TEMP";
  return "RAIN";
}

function extractThresholdUnit(question: string): "IN" | "MM" | "CM" | "TEMP_F" | "TEMP_C" | "UNKNOWN" {
  const q = String(question || "").toLowerCase();
  if (/millimeters?\b|\bmm\b/.test(q)) return "MM";
  if (/centimeters?\b|\bcm\b/.test(q)) return "CM";
  if (/inches?\b|\bin\b/.test(q)) return "IN";
  if (/celsius|°c\b/.test(q)) return "TEMP_C";
  if (/fahrenheit|°f\b/.test(q)) return "TEMP_F";
  return "UNKNOWN";
}

function thresholdToInches(threshold: number, unit: ReturnType<typeof extractThresholdUnit>): number {
  if (!Number.isFinite(threshold)) return NaN;
  if (unit === "MM") return threshold / 25.4;
  if (unit === "CM") return threshold / 2.54;
  return threshold;
}

function parseAmountFromForecastText(text: string): number | null {
  const s = String(text || "");
  const range = s.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:to|-)\s*([0-9]+(?:\.[0-9]+)?)\s*(mm|inch|inches|in\b|cm)/i);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return normalizeUnitToInches((a + b) / 2, range[3]);
  }
  const one = s.match(/([0-9]+(?:\.[0-9]+)?)\s*(mm|inch|inches|in\b|cm)/i);
  if (one) {
    const v = Number(one[1]);
    if (!Number.isFinite(v)) return null;
    return normalizeUnitToInches(v, one[2]);
  }
  return null;
}

function buildHourlyBuckets(startMs: number, endMs: number): HourBucket[] {
  const start = floorHour(startMs);
  const out: HourBucket[] = [];
  for (let t = start; t < endMs; t += 3_600_000) out.push({ startMs: t, endMs: t + 3_600_000 });
  return out;
}

function gridSeriesToHourly(
  rows: any[] | undefined,
  buckets: HourBucket[],
  valueTransform: (v: number) => number
): { values: number[]; coverage: number } {
  const sums = new Array<number>(buckets.length).fill(0);
  const weights = new Array<number>(buckets.length).fill(0);
  const items = Array.isArray(rows) ? rows : [];
  for (const row of items) {
    const value = Number(row?.value);
    if (!Number.isFinite(value)) continue;
    const vt = parseValidTime(row?.validTime);
    if (!vt) continue;
    const v = valueTransform(value);
    if (!Number.isFinite(v)) continue;
    for (let i = 0; i < buckets.length; i += 1) {
      const b = buckets[i];
      const ov = overlapMs(vt.startMs, vt.endMs, b.startMs, b.endMs);
      if (ov <= 0) continue;
      sums[i] += v * ov;
      weights[i] += ov;
    }
  }
  const values = sums.map((sum, i) => (weights[i] > 0 ? sum / weights[i] : NaN));
  const coverage = values.filter(Number.isFinite).length / Math.max(1, values.length);
  return { values, coverage };
}

export class NwsWeatherProvider implements WeatherProbabilityProvider {
  id = "nws";
  private readonly cache = new Map<string, CacheRow<any>>();
  private calibrationCache: { ts: number; value: ReturnType<typeof getWeatherCalibrationSettings> } | null = null;

  private getCached<T>(key: string): T | null {
    const row = this.cache.get(key);
    if (!row) return null;
    if (Date.now() > row.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return row.value as T;
  }

  private setCached(key: string, value: unknown, ttlMs: number): void {
    this.cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  private getCalibration(): ReturnType<typeof getWeatherCalibrationSettings> {
    const now = Date.now();
    if (this.calibrationCache && now - this.calibrationCache.ts <= 5 * 60 * 1000) return this.calibrationCache.value;
    const value = getWeatherCalibrationSettings();
    this.calibrationCache = { ts: now, value };
    return value;
  }

  private async geocode(location: string): Promise<{ lat: number; lon: number } | null> {
    const cached = this.getCached<{ lat: number; lon: number }>(`geo:${location}`);
    if (cached) return cached;
    const c = location.match(/^(.+),\s*([A-Za-z]{2})$/);
    if (!c) return null;
    const city = encodeURIComponent(c[1].trim());
    const state = encodeURIComponent(c[2].trim());
    const censusUrl = `https://geocoding.geo.census.gov/geocoder/locations/address?city=${city}&state=${state}&benchmark=4&format=json`;
    const cj = await fetchJson(censusUrl);
    const cc = cj?.result?.addressMatches?.[0]?.coordinates;
    if (cc && Number.isFinite(Number(cc.y)) && Number.isFinite(Number(cc.x))) {
      const out = { lat: Number(cc.y), lon: Number(cc.x) };
      this.setCached(`geo:${location}`, out, 24 * 3600 * 1000);
      return out;
    }
    const om = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?name=${city}&count=1&language=en&format=json`);
    const r = om?.results?.[0];
    if (r && Number.isFinite(Number(r.latitude)) && Number.isFinite(Number(r.longitude))) {
      const out = { lat: Number(r.latitude), lon: Number(r.longitude) };
      this.setCached(`geo:${location}`, out, 24 * 3600 * 1000);
      return out;
    }
    return null;
  }

  async getProbability(input: {
    market: { question: string };
    threshold?: number;
    relation?: "ABOVE" | "BELOW";
    horizonSec: number;
  }): Promise<{ p: number; confidence: number; reason: string } | null> {
    const thresholdRaw = Number(input.threshold);
    if (!Number.isFinite(thresholdRaw)) return null;
    const location = extractLocation(input.market.question);
    if (!location) return null;
    const kind = inferWeatherKind(input.market.question);
    const relation = input.relation ?? (/below|under|less than|at most/i.test(input.market.question) ? "BELOW" : "ABOVE");
    const unit = extractThresholdUnit(input.market.question);
    const geo = await this.geocode(location);
    if (!geo) return null;

    const pointsKey = `points:${geo.lat.toFixed(3)},${geo.lon.toFixed(3)}`;
    const points =
      this.getCached<any>(pointsKey) ??
      (await fetchJson(`https://api.weather.gov/points/${geo.lat},${geo.lon}`));
    if (!points) return null;
    this.setCached(pointsKey, points, 30 * 60 * 1000);

    const hourlyUrl = points?.properties?.forecastHourly;
    const gridUrl = points?.properties?.forecastGridData;
    if (!hourlyUrl) return null;
    const hourlyKey = `hourly:${hourlyUrl}`;
    const hourly = this.getCached<any>(hourlyKey) ?? (await fetchJson(hourlyUrl));
    if (!hourly) return null;
    this.setCached(hourlyKey, hourly, 10 * 60 * 1000);

    const gridKey = `grid:${gridUrl}`;
    const grid = gridUrl ? this.getCached<any>(gridKey) ?? (await fetchJson(gridUrl)) : null;
    if (grid && gridUrl) this.setCached(gridKey, grid, 10 * 60 * 1000);

    const now = Date.now();
    const endTs = now + Math.max(3600, input.horizonSec) * 1000;
    const buckets = buildHourlyBuckets(now, endTs).slice(0, 48);
    if (!buckets.length) return null;

    if (kind === "TEMP") {
      const calib = this.getCalibration();
      const sigmaMult = clamp(Number(calib.multipliers.tempSigmaMultiplier ?? 1), 0.6, 3.2);
      const periods: any[] = Array.isArray(hourly?.properties?.periods) ? hourly.properties.periods : [];
      const temps = buckets.map((b) => {
        const p = periods.find((x) => {
          const ts = Date.parse(String(x?.startTime ?? ""));
          return Number.isFinite(ts) && ts >= b.startMs && ts < b.endMs;
        });
        return Number(p?.temperature ?? NaN);
      });
      const use = temps.filter(Number.isFinite);
      if (!use.length) return null;
      const mean = use.reduce((a, b) => a + b, 0) / use.length;
      const variance = use.reduce((a, b) => a + (b - mean) * (b - mean), 0) / Math.max(1, use.length - 1);
      const sd = Math.max(2.2, Math.sqrt(Math.max(variance, 0))) * sigmaMult;
      const thr = unit === "TEMP_C" ? thresholdRaw * (9 / 5) + 32 : thresholdRaw;
      const z = (thr - mean) / sd;
      const pAbove = 1 - normalCdf(z);
      const p = relation === "BELOW" ? 1 - pAbove : pAbove;
      return {
        p: clamp(p, 0, 1),
        confidence: clamp(0.42 + Math.min(use.length, 18) / 40, 0.2, 0.88),
        reason: `NWS temperature distribution model hours=${use.length} sigmaMult=${sigmaMult.toFixed(2)}`
      };
    }

    const calib = this.getCalibration();
    const cvMultiplier = clamp(
      Number(kind === "SNOW" ? calib.multipliers.snowCvMultiplier : calib.multipliers.rainCvMultiplier),
      0.6,
      3.4
    );

    const popRows: any[] | undefined = grid?.properties?.probabilityOfPrecipitation?.values;
    const qpfRows: any[] | undefined = grid?.properties?.quantitativePrecipitation?.values;
    const snowRows: any[] | undefined = grid?.properties?.snowfallAmount?.values;
    const qpfUnit: string | undefined = grid?.properties?.quantitativePrecipitation?.uom;
    const snowUnit: string | undefined = grid?.properties?.snowfallAmount?.uom;

    const popHourly = gridSeriesToHourly(popRows, buckets, (v) => clamp(v / 100, 0, 1));
    const qpfHourly = gridSeriesToHourly(qpfRows, buckets, (v) => normalizeUnitToInches(v, qpfUnit));
    const snowHourly = gridSeriesToHourly(snowRows, buckets, (v) => normalizeUnitToInches(v, snowUnit));

    const periods: any[] = Array.isArray(hourly?.properties?.periods) ? hourly.properties.periods : [];
    const popFallback = buckets.map((b) => {
      const p = periods.find((x) => {
        const ts = Date.parse(String(x?.startTime ?? ""));
        return Number.isFinite(ts) && ts >= b.startMs && ts < b.endMs;
      });
      return clamp(Number(p?.probabilityOfPrecipitation?.value ?? NaN) / 100, 0, 1);
    });
    const amountFallback = buckets.map((b) => {
      const p = periods.find((x) => {
        const ts = Date.parse(String(x?.startTime ?? ""));
        return Number.isFinite(ts) && ts >= b.startMs && ts < b.endMs;
      });
      return parseAmountFromForecastText(String(p?.detailedForecast ?? p?.shortForecast ?? ""));
    });

    const pOcc: number[] = [];
    const muInches: number[] = [];
    for (let i = 0; i < buckets.length; i += 1) {
      const pop = Number.isFinite(popHourly.values[i]) ? popHourly.values[i] : Number.isFinite(popFallback[i]) ? popFallback[i] : 0;
      const baseAmt = kind === "SNOW" ? snowHourly.values[i] : qpfHourly.values[i];
      const fallbackAmt = amountFallback[i];
      const amt =
        Number.isFinite(baseAmt) ? baseAmt : Number.isFinite(fallbackAmt) ? (fallbackAmt as number) : Math.max(0.02, pop * (kind === "SNOW" ? 0.06 : 0.08));
      pOcc.push(clamp(pop, 0.01, 0.99));
      muInches.push(Math.max(0, amt));
    }

    const thresholdIn = thresholdToInches(thresholdRaw, unit);
    if (!Number.isFinite(thresholdIn)) return null;

    const seed = hashString(`${location}|${kind}|${thresholdIn.toFixed(4)}|${Math.round(endTs / 60000)}`);
    const rng = makeRng(seed);
    const samples = 5000;
    let geCount = 0;
    const totals: number[] = [];
    for (let s = 0; s < samples; s += 1) {
      let total = 0;
      for (let i = 0; i < pOcc.length; i += 1) {
        if (rng() > pOcc[i]) continue;
        const meanCond = muInches[i] / Math.max(0.05, pOcc[i]);
        const cv = (kind === "SNOW" ? 1.45 : 1.15) * cvMultiplier;
        const sigma2 = Math.log(1 + cv * cv);
        const sigma = Math.sqrt(sigma2);
        const muLog = Math.log(Math.max(meanCond, 1e-5)) - 0.5 * sigma2;
        const draw = Math.exp(muLog + sigma * randn(rng));
        total += draw;
      }
      totals.push(total);
      if (total >= thresholdIn) geCount += 1;
    }

    const pGe = geCount / samples;
    const p = relation === "BELOW" ? 1 - pGe : pGe;
    const popCoverage = popHourly.coverage;
    const amountCoverage = (kind === "SNOW" ? snowHourly.coverage : qpfHourly.coverage);
    const gridBonus = grid ? 0.07 : 0;
    const confidence = clamp(0.25 + 0.3 * popCoverage + 0.28 * amountCoverage + gridBonus, 0.18, 0.93);
    const meanTotal = totals.reduce((a, b) => a + b, 0) / totals.length;
    const varTotal = totals.reduce((a, b) => a + (b - meanTotal) * (b - meanTotal), 0) / Math.max(1, totals.length - 1);
    return {
      p: clamp(p, 0, 1),
      confidence,
      reason: `NWS ${kind.toLowerCase()} accumulation MC model hrs=${buckets.length} cvMult=${cvMultiplier.toFixed(2)} popCov=${(popCoverage * 100).toFixed(0)}% amtCov=${(amountCoverage * 100).toFixed(0)}% mean=${meanTotal.toFixed(2)}in sd=${Math.sqrt(varTotal).toFixed(2)}in`
    };
  }
}
