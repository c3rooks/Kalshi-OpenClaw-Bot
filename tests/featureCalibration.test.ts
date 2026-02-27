import { describe, expect, it } from "vitest";
import { predictCalibratedWinProb } from "../src/learning/featureCalibration";

describe("feature calibration prediction", () => {
  it("returns bounded probability", () => {
    const p = predictCalibratedWinProb({
      edge: 0.04,
      quality: 78,
      fillProb: 0.72,
      confidence: 0.7,
      pModel: 0.67,
      impliedPrice: 0.58,
      expectedCost: 0.01
    });
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1);
  });

  it("increases when edge and quality improve", () => {
    const low = predictCalibratedWinProb({
      edge: 0.0,
      quality: 45,
      fillProb: 0.4,
      confidence: 0.4,
      pModel: 0.53,
      impliedPrice: 0.52,
      expectedCost: 0.02
    });
    const high = predictCalibratedWinProb({
      edge: 0.06,
      quality: 85,
      fillProb: 0.82,
      confidence: 0.8,
      pModel: 0.73,
      impliedPrice: 0.57,
      expectedCost: 0.008
    });
    expect(high).toBeGreaterThan(low);
  });
});

