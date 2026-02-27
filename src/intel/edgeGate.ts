export type EdgeGateResult = {
  allowed: boolean;
  edge: number;
  reasons: string[];
};

export function edgeGate(input: {
  pModel: number;
  impliedPrice: number;
  expectedCost: number;
  minEdge: number;
  fillProb: number;
  minFillProb: number;
  qualityScore: number;
  minQualityScore: number;
}): EdgeGateResult {
  const reasons: string[] = [];
  const edge = input.pModel - input.impliedPrice - input.expectedCost;

  if (input.qualityScore < input.minQualityScore) {
    reasons.push(`quality too low (${input.qualityScore.toFixed(1)} < ${input.minQualityScore.toFixed(1)})`);
  }
  if (edge < input.minEdge) {
    reasons.push(`edge too low (${edge.toFixed(4)} < ${input.minEdge.toFixed(4)})`);
  }
  if (input.fillProb < input.minFillProb) {
    reasons.push(`fillProb too low (${input.fillProb.toFixed(3)} < ${input.minFillProb.toFixed(3)})`);
  }

  const allowed = reasons.length === 0;
  if (allowed) reasons.push("positive EV + fill + quality passed");

  return { allowed, edge, reasons };
}
