import { describe, expect, it } from "vitest";
import { qualityScore } from "../src/intel/qualityScore";
import { edgeGate } from "../src/intel/edgeGate";

describe("qualityScore", () => {
  it("gives high score for strong market", () => {
    const q = qualityScore({
      parsed: { marketType: "CRYPTO_THRESHOLD", tradeable: true, reasons: ["parsed ok"] },
      spread: 0.01,
      depthNearTarget: 200,
      requiredDepth: 100,
      volume: 10000,
      timeToCloseSec: 25,
      question: "Will BTC be above $100k?"
    });
    expect(q.score).toBeGreaterThan(70);
  });
});

describe("edgeGate", () => {
  it("allows trade only when all thresholds pass", () => {
    const pass = edgeGate({
      pModel: 0.75,
      impliedPrice: 0.65,
      expectedCost: 0.01,
      minEdge: 0.03,
      fillProb: 0.8,
      minFillProb: 0.6,
      qualityScore: 80,
      minQualityScore: 70
    });
    expect(pass.allowed).toBe(true);

    const fail = edgeGate({
      pModel: 0.67,
      impliedPrice: 0.65,
      expectedCost: 0.01,
      minEdge: 0.03,
      fillProb: 0.5,
      minFillProb: 0.6,
      qualityScore: 60,
      minQualityScore: 70
    });
    expect(fail.allowed).toBe(false);
  });
});
