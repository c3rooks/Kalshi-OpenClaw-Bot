import type { ExecutionEstimate } from "./types";

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

export function estimateExecution(input: {
  depthAtTarget: number;
  requiredDepth: number;
  spread: number;
  volatility: number;
  historicalFillRate: number;
}): ExecutionEstimate {
  const reasons: string[] = [];

  const depthRatio = input.requiredDepth <= 0 ? 1 : input.depthAtTarget / input.requiredDepth;
  const depthComponent = clamp(depthRatio / 1.2, 0, 1) * 0.55;
  const histComponent = clamp(input.historicalFillRate, 0, 1) * 0.35;
  const penalty = clamp(input.spread / 0.08, 0, 1) * 0.1 + clamp(input.volatility / 0.04, 0, 1) * 0.1;

  const fillProb = clamp(depthComponent + histComponent + 0.1 - penalty, 0.01, 0.99);
  if (depthRatio < 1) reasons.push("depth below required size");
  if (input.spread > 0.04) reasons.push("wide spread increases miss risk");
  if (input.volatility > 0.02) reasons.push("high volatility increases adverse selection");

  const expectedCost = clamp((1 - fillProb) * 0.01 + input.spread * 0.08 + input.volatility * 0.2, 0, 0.08);

  return {
    fillProb,
    expectedCost,
    reasons: reasons.length ? reasons : ["execution conditions stable"]
  };
}
