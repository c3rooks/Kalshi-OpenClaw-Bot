import type { ParsedMarketFields } from "./marketTypeClassifier";

type CacheValue<T> = { expiresAt: number; value: T };

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function mean(nums: number[]): number {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function stdev(nums: number[]): number {
  if (nums.length < 2) return 0;
  const m = mean(nums);
  const v = nums.reduce((a, b) => a + (b - m) * (b - m), 0) / (nums.length - 1);
  return Math.sqrt(v);
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * Math.abs(x));
  const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x));
  return sign * y;
}

async function fetchJson(url: string): Promise<any> {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "openclaw-kalshi-bot/2.0 (local)",
      Accept: "application/geo+json,application/json"
    }
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

export class WeatherProbabilityEngine {
  private readonly cache = new Map<string, CacheValue<any>>();

  constructor(private readonly enabled: boolean) {}

  private getCache<T>(key: string): T | null {
    const row = this.cache.get(key);
    if (!row) return null;
    if (Date.now() > row.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return row.value as T;
  }

  private setCache<T>(key: string, value: T, ttlMs: number): void {
    this.cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  private async geocodeLocation(location: string): Promise<{ lat: number; lon: number } | null> {
    const cached = this.getCache<{ lat: number; lon: number }>(`geo:${location}`);
    if (cached) return cached;

    const latlon = location.match(/^\s*(-?[0-9]+(?:\.[0-9]+)?)\s*,\s*(-?[0-9]+(?:\.[0-9]+)?)\s*$/);
    if (latlon) {
      const val = { lat: Number(latlon[1]), lon: Number(latlon[2]) };
      this.setCache(`geo:${location}`, val, 24 * 3600 * 1000);
      return val;
    }

    const cityState = location.match(/^(.+),\s*([A-Za-z]{2})$/);
    if (!cityState) return null;

    const city = encodeURIComponent(cityState[1].trim());
    const state = encodeURIComponent(cityState[2].trim());
    const url = `https://geocoding.geo.census.gov/geocoder/locations/address?city=${city}&state=${state}&benchmark=4&format=json`;

    try {
      const json = await fetchJson(url);
      const addr = json?.result?.addressMatches?.[0]?.coordinates;
      if (!addr) return null;
      const val = { lat: Number(addr.y), lon: Number(addr.x) };
      if (!Number.isFinite(val.lat) || !Number.isFinite(val.lon)) return null;
      this.setCache(`geo:${location}`, val, 24 * 3600 * 1000);
      return val;
    } catch {
      return null;
    }
  }

  private async nwsPoints(lat: number, lon: number): Promise<any | null> {
    const key = `points:${lat.toFixed(3)},${lon.toFixed(3)}`;
    const cached = this.getCache<any>(key);
    if (cached) return cached;
    try {
      const json = await fetchJson(`https://api.weather.gov/points/${lat},${lon}`);
      this.setCache(key, json, 30 * 60 * 1000);
      return json;
    } catch {
      return null;
    }
  }

  private async nwsHourlyForecast(url: string): Promise<any | null> {
    const key = `hourly:${url}`;
    const cached = this.getCache<any>(key);
    if (cached) return cached;
    try {
      const json = await fetchJson(url);
      this.setCache(key, json, 10 * 60 * 1000);
      return json;
    } catch {
      return null;
    }
  }

  async evaluate(parsed: ParsedMarketFields, nowTs: number): Promise<{ pModel: number | null; confidence: number; reason: string; snapshot?: unknown }> {
    if (!this.enabled) {
      return { pModel: null, confidence: 0, reason: "weather disabled" };
    }
    if (!parsed.location) {
      return { pModel: null, confidence: 0, reason: "missing location" };
    }
    if (!Number.isFinite(parsed.threshold)) {
      return { pModel: null, confidence: 0, reason: "missing threshold" };
    }

    const geo = await this.geocodeLocation(parsed.location);
    if (!geo) return { pModel: null, confidence: 0, reason: "location geocode failed" };

    const points = await this.nwsPoints(geo.lat, geo.lon);
    const hourlyUrl = points?.properties?.forecastHourly;
    if (!hourlyUrl) return { pModel: null, confidence: 0, reason: "NWS hourly url missing" };

    const hourly = await this.nwsHourlyForecast(hourlyUrl);
    const periods: any[] = Array.isArray(hourly?.properties?.periods) ? hourly.properties.periods : [];
    if (!periods.length) return { pModel: null, confidence: 0, reason: "NWS hourly periods missing" };

    const endTs = parsed.windowEndTs ?? parsed.closeTs ?? nowTs + 6 * 3600 * 1000;
    const startTs = parsed.windowStartTs ?? nowTs;
    const windowPeriods = periods.filter((p) => {
      const t = Date.parse(p.startTime);
      return Number.isFinite(t) && t >= startTs && t <= endTs;
    });

    const usePeriods = windowPeriods.length ? windowPeriods : periods.slice(0, 12);

    if (parsed.marketType === "WEATHER_TEMP") {
      const temps = usePeriods
        .map((p) => Number(p.temperature ?? NaN))
        .filter((x) => Number.isFinite(x));
      if (!temps.length) return { pModel: null, confidence: 0, reason: "temperature data missing" };

      const m = mean(temps);
      const s = Math.max(stdev(temps), 2);
      const z = ((parsed.threshold as number) - m) / s;
      const above = clamp(1 - 0.5 * (1 + erf(z / Math.sqrt(2))), 0, 1);
      const p = parsed.relation === "BELOW" ? 1 - above : above;
      const conf = clamp(0.35 + Math.min(temps.length, 12) / 30, 0.2, 0.85);
      return {
        pModel: p,
        confidence: conf,
        reason: "NWS hourly temperature heuristic",
        snapshot: { location: parsed.location, periods: temps.length, meanTemp: m, stdTemp: s }
      };
    }

    if (parsed.marketType === "WEATHER_RAIN" || parsed.marketType === "WEATHER_SNOW") {
      const precipChance = usePeriods
        .map((p) => Number(p.probabilityOfPrecipitation?.value ?? 0) / 100)
        .map((x) => clamp(x, 0, 1));

      const hourlyAmt = usePeriods
        .map((p) => {
          const txt = String(p.detailedForecast ?? p.shortForecast ?? "");
          const mm = txt.match(/([0-9]+(?:\.[0-9]+)?)\s*(mm|inch|inches|in\b)/i);
          if (!mm) return 0;
          const n = Number(mm[1]);
          const unit = mm[2].toLowerCase();
          if (!Number.isFinite(n)) return 0;
          return unit.startsWith("mm") ? n / 25.4 : n;
        });

      let expectedInches = 0;
      for (let i = 0; i < usePeriods.length; i += 1) {
        const chance = precipChance[i] ?? 0;
        const amt = hourlyAmt[i] ?? 0.05;
        const snowFactor = parsed.marketType === "WEATHER_SNOW" ? 0.7 : 1;
        expectedInches += chance * amt * snowFactor;
      }

      const uncertainty = Math.max(0.15, expectedInches * 0.6);
      const z = ((parsed.threshold as number) - expectedInches) / uncertainty;
      const ge = clamp(1 - 0.5 * (1 + erf(z / Math.sqrt(2))), 0, 1);
      const p = parsed.relation === "BELOW" ? 1 - ge : ge;
      const conf = clamp(0.25 + Math.min(usePeriods.length, 12) / 40, 0.15, 0.75);
      return {
        pModel: p,
        confidence: conf,
        reason: "NWS precip accumulation heuristic",
        snapshot: { location: parsed.location, periods: usePeriods.length, expectedInches, uncertainty }
      };
    }

    return { pModel: null, confidence: 0, reason: "unsupported weather subtype" };
  }
}
