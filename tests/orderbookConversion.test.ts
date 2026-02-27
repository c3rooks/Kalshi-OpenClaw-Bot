import { describe, expect, it } from "vitest";
import { deriveBestAsksFromBids } from "../src/kalshi/adapter";

describe("deriveBestAsksFromBids", () => {
  it("derives ask yes from best bid no", () => {
    const r = deriveBestAsksFromBids(60, 97);
    expect(r.bestAskYes).toBeCloseTo(0.03, 6);
    expect(r.bestAskNo).toBeCloseTo(0.4, 6);
  });

  it("returns infinity when opposing bid missing", () => {
    const r = deriveBestAsksFromBids(Number.NaN, Number.NaN);
    expect(r.bestAskYes).toBe(Number.POSITIVE_INFINITY);
    expect(r.bestAskNo).toBe(Number.POSITIVE_INFINITY);
  });
});
