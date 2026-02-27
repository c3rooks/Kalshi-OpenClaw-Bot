import { describe, expect, it } from "vitest";
import { computeMarketQualityScore } from "../src/intelligence/marketQuality";
import { computeProbabilityEstimate, estimateVolatilityFromMids } from "../src/intelligence/probabilityEngine";
import { runEdgeGate } from "../src/intelligence/edgeGate";
import { NoExternalSportsProvider } from "../src/intelligence/providers/sports";
import { NoExternalWeatherProvider } from "../src/intelligence/providers/weather";

describe("MarketQualityScore", () => {
  it("scores high for tight spread, good depth, low vol", () => {
    const q = computeMarketQualityScore({
      spread: 0.01,
      depthAtTarget: 200,
      requiredDepth: 80,
      volatility: 0.008,
      volume: 5000,
      timeToCloseSec: 20,
      resolutionDelayRisk: 0.05,
      marketTypeRisk: 0.1
    });
    expect(q.score).toBeGreaterThanOrEqual(70);
  });

  it("scores low for poor liquidity and wide spread", () => {
    const q = computeMarketQualityScore({
      spread: 0.08,
      depthAtTarget: 5,
      requiredDepth: 100,
      volatility: 0.04,
      volume: 10,
      timeToCloseSec: 500,
      resolutionDelayRisk: 0.8,
      marketTypeRisk: 0.7
    });
    expect(q.score).toBeLessThan(45);
  });
});

describe("ProbabilityEngine", () => {
  it("threshold model gives higher YES probability when spot above strike", async () => {
    const p = await computeProbabilityEstimate({
      kind: "threshold",
      side: "YES",
      impliedPrice: 0.5,
      rules: {
        marketType: "binary",
        resolutionTime: Date.now() + 60_000,
        threshold: 100,
        relation: "ABOVE",
        reliableThreshold: true
      },
      referenceValue: 105,
      timeToCloseSec: 60,
      mids: [0.49, 0.5, 0.51, 0.52, 0.5, 0.51],
      weatherProvider: new NoExternalWeatherProvider(),
      sportsProvider: new NoExternalSportsProvider(),
      marketQuestion: "Will value be above 100?",
      marketCategory: ""
    });

    expect(p.pModel).toBeGreaterThan(0.5);
    expect(p.confidence).toBeGreaterThan(0.3);
  });

  it("fallback returns implied when no external provider", async () => {
    const p = await computeProbabilityEstimate({
      kind: "weather",
      side: "YES",
      impliedPrice: 0.37,
      rules: { marketType: "binary", resolutionTime: Date.now() + 60_000 },
      referenceValue: null,
      timeToCloseSec: 60,
      mids: [0.37, 0.37, 0.37, 0.37],
      weatherProvider: new NoExternalWeatherProvider(),
      sportsProvider: new NoExternalSportsProvider(),
      marketQuestion: "Will it rain?",
      marketCategory: "weather"
    });

    expect(p.pModel).toBeCloseTo(0.37, 6);
    expect(p.confidence).toBeLessThanOrEqual(0.3);
  });

  it("volatility estimator increases with noisier mids", () => {
    const low = estimateVolatilityFromMids([0.5, 0.501, 0.502, 0.503, 0.504]);
    const high = estimateVolatilityFromMids([0.5, 0.6, 0.45, 0.65, 0.4]);
    expect(high).toBeGreaterThan(low);
  });
});

describe("EdgeGate", () => {
  it("allows trade when edge and fill pass", () => {
    const g = runEdgeGate({
      pModel: 0.7,
      impliedPrice: 0.6,
      expectedCost: 0.01,
      minEdge: 0.02,
      fillProb: 0.7,
      minFillProb: 0.4
    });
    expect(g.trade).toBe(true);
  });

  it("skips when edge or fill fails", () => {
    const g = runEdgeGate({
      pModel: 0.61,
      impliedPrice: 0.6,
      expectedCost: 0.01,
      minEdge: 0.03,
      fillProb: 0.2,
      minFillProb: 0.4
    });
    expect(g.trade).toBe(false);
    expect(g.reasons.length).toBeGreaterThan(0);
  });
});
