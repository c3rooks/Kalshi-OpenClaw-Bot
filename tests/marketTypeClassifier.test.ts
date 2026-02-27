import { describe, expect, it } from "vitest";
import { classifyMarket } from "../src/intel/marketTypeClassifier";

describe("MarketTypeClassifier", () => {
  it("classifies crypto threshold and extracts fields", () => {
    const p = classifyMarket("Will BTC be above $95,000 at 4pm ET?", Date.now() + 60000);
    expect(p.marketType).toBe("CRYPTO_THRESHOLD");
    expect(p.underlying).toBe("BTC");
    expect(p.threshold).toBe(95000);
    expect(p.unit).toBe("USD");
    expect(p.tradeable).toBe(true);
  });

  it("classifies crypto touch", () => {
    const p = classifyMarket("Will ETH touch $5,000 before Friday?", Date.now() + 60000);
    expect(p.marketType).toBe("CRYPTO_TOUCH");
    expect(p.underlying).toBe("ETH");
    expect(p.threshold).toBe(5000);
  });

  it("classifies weather rain + location", () => {
    const p = classifyMarket("Will rain in Seattle, WA be above 0.5 inches by tomorrow?", Date.now() + 60000);
    expect(p.marketType).toBe("WEATHER_RAIN");
    expect(p.location).toContain("Seattle");
    expect(p.threshold).toBeCloseTo(0.5);
  });

  it("falls back to generic binary for non-specialized markets", () => {
    const p = classifyMarket("Who wins?", Date.now() + 60000);
    expect(p.marketType).toBe("GENERIC_BINARY");
    expect(p.tradeable).toBe(true);
    expect(p.reasons.join(" ")).toContain("generic market model");
  });
});
