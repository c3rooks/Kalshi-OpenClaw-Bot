import type { EdgeGateInput, EdgeGateResult } from "./types";

export function runEdgeGate(input: EdgeGateInput): EdgeGateResult {
  const reasons: string[] = [];
  const edge = input.pModel - input.impliedPrice - input.expectedCost;
  const expectedValuePerTrade = edge;

  if (edge < input.minEdge) {
    reasons.push(`edge below MIN_EDGE (${edge.toFixed(4)} < ${input.minEdge.toFixed(4)})`);
  }
  if (input.fillProb < input.minFillProb) {
    reasons.push(`fillProb below MIN_FILL_PROB (${input.fillProb.toFixed(3)} < ${input.minFillProb.toFixed(3)})`);
  }

  if (!reasons.length) reasons.push("edge and fill probability passed");

  return {
    trade: reasons.length === 1 && reasons[0] === "edge and fill probability passed",
    edge,
    expectedValuePerTrade,
    reasons
  };
}
