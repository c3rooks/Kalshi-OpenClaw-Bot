export type ExecutionEstimate = {
  fillProb: number;
  expectedCost: number;
  reasons: string[];
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function executionModel(input: {
  depthAtTarget: number;
  requiredContracts: number;
  spread: number;
  recentFillRate: number;
  feeRate: number;
}): ExecutionEstimate {
  const reasons: string[] = [];
  const depthRatio = input.requiredContracts > 0 ? input.depthAtTarget / input.requiredContracts : 1;

  const fillProb = clamp(
    0.5 * clamp(depthRatio / 1.1, 0, 1) +
      0.35 * clamp(input.recentFillRate, 0, 1) +
      0.2 -
      0.15 * clamp(input.spread / 0.08, 0, 1),
    0.01,
    0.99
  );

  if (depthRatio < 1) reasons.push("low depth at target");
  if (input.spread > 0.04) reasons.push("spread risk");

  const slippageRisk = (1 - fillProb) * 0.01 + clamp(input.spread, 0, 0.2) * 0.12;
  const expectedCost = clamp(slippageRisk + Math.max(0, input.feeRate), 0, 0.15);
  if (!reasons.length) reasons.push("execution favorable");

  return { fillProb, expectedCost, reasons };
}
