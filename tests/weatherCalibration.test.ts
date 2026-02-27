import { describe, expect, it } from "vitest";
import { calibrateWeatherRows, type WeatherCalibrationSettings } from "../src/intel/weatherCalibration";
import type { WeatherCalibrationRow } from "../src/db/queries";

function makeRows(kind: "WEATHER_RAIN" | "WEATHER_SNOW" | "WEATHER_TEMP", probs: number[], outcomes: Array<"WIN" | "LOSS">): WeatherCalibrationRow[] {
  return probs.map((p, i) => ({
    market_id: `${kind}-${i}`,
    side: "YES",
    outcome: outcomes[i],
    ts_open: Date.now() - (i + 1) * 1000,
    resolved_ts: Date.now() - i * 1000,
    market_type: kind,
    p_model: p
  }));
}

describe("weather calibration", () => {
  it("increases variance multiplier when probabilities are overconfident", () => {
    const probs = Array.from({ length: 80 }, (_, i) => (i % 2 === 0 ? 0.95 : 0.05));
    const outcomes = Array.from({ length: 80 }, (_, i) => (i % 2 === 0 ? "LOSS" : "WIN")) as Array<"WIN" | "LOSS">;
    const rows = makeRows("WEATHER_RAIN", probs, outcomes);
    const cal = calibrateWeatherRows(rows, { minSamplesPerType: 20 });
    expect(cal.multipliers.rainCvMultiplier).toBeGreaterThan(1);
    expect(cal.fit.afterBrier).toBeLessThanOrEqual(cal.fit.beforeBrier);
  });

  it("keeps defaults with insufficient samples", () => {
    const rows = makeRows("WEATHER_TEMP", [0.7, 0.6, 0.4], ["WIN", "LOSS", "WIN"]);
    const cal: WeatherCalibrationSettings = calibrateWeatherRows(rows, { minSamplesPerType: 10 });
    expect(cal.multipliers.tempSigmaMultiplier).toBe(1);
  });
});

