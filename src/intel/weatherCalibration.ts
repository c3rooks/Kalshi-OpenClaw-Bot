import { getResolvedWeatherCalibrationRows, type WeatherCalibrationRow } from "../db/queries";
import { getSetting, setSetting } from "../settings/settingsStore";
import { logger } from "../utils/logger";

export type WeatherCalibrationSettings = {
  updatedTs: number;
  lookbackDays: number;
  samples: {
    total: number;
    rain: number;
    snow: number;
    temp: number;
  };
  multipliers: {
    rainCvMultiplier: number;
    snowCvMultiplier: number;
    tempSigmaMultiplier: number;
  };
  fit: {
    beforeBrier: number;
    afterBrier: number;
  };
};

const SETTINGS_KEY = "weather.calibration.v1";

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function sigmoid(x: number): number {
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  }
  const z = Math.exp(x);
  return z / (1 + z);
}

function logit(p: number): number {
  const x = clamp(p, 1e-6, 1 - 1e-6);
  return Math.log(x / (1 - x));
}

function transformProbability(p: number, scale: number, bias: number): number {
  const lp = logit(p);
  return clamp(sigmoid(lp / scale + bias), 0.001, 0.999);
}

function brier(rows: Array<{ p: number; y: number }>, scale: number, bias: number): number {
  if (!rows.length) return 0.25;
  let sum = 0;
  for (const r of rows) {
    const ph = transformProbability(r.p, scale, bias);
    const d = ph - r.y;
    sum += d * d;
  }
  return sum / rows.length;
}

function fitScaleBias(rows: Array<{ p: number; y: number }>): { scale: number; bias: number; before: number; after: number } {
  if (!rows.length) return { scale: 1, bias: 0, before: 0.25, after: 0.25 };
  let best = { scale: 1, bias: 0, score: brier(rows, 1, 0) };
  for (let s = 0.6; s <= 2.4; s += 0.05) {
    for (let b = -0.8; b <= 0.8; b += 0.04) {
      const score = brier(rows, s, b);
      if (score < best.score) best = { scale: Number(s.toFixed(4)), bias: Number(b.toFixed(4)), score };
    }
  }
  return { scale: best.scale, bias: best.bias, before: brier(rows, 1, 0), after: best.score };
}

function toRows(raw: WeatherCalibrationRow[], marketTypeFilter: RegExp): Array<{ p: number; y: number }> {
  return raw
    .filter((r) => marketTypeFilter.test(String(r.market_type ?? "")))
    .map((r) => ({ p: Number(r.p_model), y: r.outcome === "WIN" ? 1 : 0 }))
    .filter((r) => Number.isFinite(r.p) && r.p > 0 && r.p < 1);
}

export function getWeatherCalibrationSettings(): WeatherCalibrationSettings {
  return (
    getSetting<WeatherCalibrationSettings>(SETTINGS_KEY, {
      updatedTs: 0,
      lookbackDays: 120,
      samples: { total: 0, rain: 0, snow: 0, temp: 0 },
      multipliers: {
        rainCvMultiplier: 1,
        snowCvMultiplier: 1,
        tempSigmaMultiplier: 1
      },
      fit: {
        beforeBrier: 0.25,
        afterBrier: 0.25
      }
    }) ?? {
      updatedTs: 0,
      lookbackDays: 120,
      samples: { total: 0, rain: 0, snow: 0, temp: 0 },
      multipliers: {
        rainCvMultiplier: 1,
        snowCvMultiplier: 1,
        tempSigmaMultiplier: 1
      },
      fit: {
        beforeBrier: 0.25,
        afterBrier: 0.25
      }
    }
  );
}

export function recalibrateWeatherModelFromDb(opts?: { lookbackDays?: number; minSamplesPerType?: number }): WeatherCalibrationSettings {
  const lookbackDays = Math.max(7, Number(opts?.lookbackDays ?? 120));
  const minSamples = Math.max(10, Number(opts?.minSamplesPerType ?? 35));
  const rows = getResolvedWeatherCalibrationRows({ lookbackDays, limit: 5000 });
  const result = calibrateWeatherRows(rows, { lookbackDays, minSamplesPerType: minSamples });
  setSetting(SETTINGS_KEY, result);
  logger.info("Weather calibration updated", {
    samples: result.samples,
    multipliers: result.multipliers,
    fit: result.fit
  });
  return result;
}

export function calibrateWeatherRows(
  rows: WeatherCalibrationRow[],
  opts?: { lookbackDays?: number; minSamplesPerType?: number }
): WeatherCalibrationSettings {
  const lookbackDays = Math.max(7, Number(opts?.lookbackDays ?? 120));
  const minSamples = Math.max(10, Number(opts?.minSamplesPerType ?? 35));
  const rainRows = toRows(rows, /^WEATHER_RAIN/i);
  const snowRows = toRows(rows, /^WEATHER_SNOW/i);
  const tempRows = toRows(rows, /^WEATHER_TEMP/i);
  const allRows = [...rainRows, ...snowRows, ...tempRows];

  const rainFit = rainRows.length >= minSamples ? fitScaleBias(rainRows) : { scale: 1, bias: 0, before: 0.25, after: 0.25 };
  const snowFit = snowRows.length >= minSamples ? fitScaleBias(snowRows) : { scale: 1, bias: 0, before: 0.25, after: 0.25 };
  const tempFit = tempRows.length >= minSamples ? fitScaleBias(tempRows) : { scale: 1, bias: 0, before: 0.25, after: 0.25 };
  const allFit = allRows.length >= minSamples ? fitScaleBias(allRows) : { scale: 1, bias: 0, before: 0.25, after: 0.25 };

  const result: WeatherCalibrationSettings = {
    updatedTs: Date.now(),
    lookbackDays,
    samples: {
      total: allRows.length,
      rain: rainRows.length,
      snow: snowRows.length,
      temp: tempRows.length
    },
    multipliers: {
      rainCvMultiplier: clamp(rainFit.scale, 0.7, 2.5),
      snowCvMultiplier: clamp(snowFit.scale, 0.7, 2.8),
      tempSigmaMultiplier: clamp(tempFit.scale, 0.7, 2.5)
    },
    fit: {
      beforeBrier: Number(allFit.before.toFixed(6)),
      afterBrier: Number(allFit.after.toFixed(6))
    }
  };
  return result;
}
