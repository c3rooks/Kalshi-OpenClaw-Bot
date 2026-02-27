import type { MarketQualityInput, MarketQualityScore } from "./types";

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

export function computeMarketQualityScore(input: MarketQualityInput): MarketQualityScore {
  const reasons: string[] = [];

  const spreadScore = clamp(1 - input.spread / 0.08, 0, 1) * 22;
  if (input.spread > 0.04) reasons.push("wide spread");

  const depthRatio = input.requiredDepth <= 0 ? 1 : input.depthAtTarget / input.requiredDepth;
  const depthScore = clamp(depthRatio, 0, 1.4) / 1.4 * 24;
  if (depthRatio < 1) reasons.push("insufficient depth at target");

  const volScore = clamp(1 - input.volatility / 0.03, 0, 1) * 14;
  if (input.volatility > 0.02) reasons.push("high short-term volatility");

  const volumeScore = clamp(Math.log10(Math.max(1, input.volume + 1)) / 4, 0, 1) * 14;
  if (input.volume < 100) reasons.push("low volume");

  const tteIdeal = clamp(1 - Math.abs(input.timeToCloseSec - 15) / 45, 0, 1) * 10;
  if (input.timeToCloseSec > 90) reasons.push("not near close");

  const resolutionPenalty = clamp(input.resolutionDelayRisk, 0, 1) * 8;
  if (resolutionPenalty > 4) reasons.push("resolution delay risk");

  const typePenalty = clamp(input.marketTypeRisk, 0, 1) * 8;
  if (typePenalty > 4) reasons.push("market type risk");

  const raw = spreadScore + depthScore + volScore + volumeScore + tteIdeal - resolutionPenalty - typePenalty + 16;
  const score = clamp(raw, 0, 100);

  if (score >= 75) reasons.unshift("high quality");
  else if (score >= 55) reasons.unshift("acceptable quality");
  else reasons.unshift("low quality");

  return { score, reasons };
}
