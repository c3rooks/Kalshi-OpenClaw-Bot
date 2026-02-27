import type { ParsedMarketFields } from "./marketTypeClassifier";

export type QualityScoreResult = {
  score: number;
  reasons: string[];
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function qualityScore(input: {
  parsed: ParsedMarketFields;
  spread: number;
  depthNearTarget: number;
  requiredDepth: number;
  volume: number;
  timeToCloseSec: number;
  question: string;
}): QualityScoreResult {
  const reasons: string[] = [];
  const q = input.question.toLowerCase();

  const spreadScore = clamp(1 - input.spread / 0.06, 0, 1) * 28;
  if (input.spread > 0.04) reasons.push("wide spread");

  const depthRatio = input.requiredDepth > 0 ? input.depthNearTarget / input.requiredDepth : 1;
  const depthScore = clamp(depthRatio / 1.25, 0, 1) * 24;
  if (depthRatio < 1) reasons.push("insufficient depth near target");

  const volumeScore = clamp(Math.log10(Math.max(1, input.volume + 1)) / 4, 0, 1) * 16;
  if (input.volume < 150) reasons.push("low volume");

  const tScore = clamp(1 - Math.abs(input.timeToCloseSec - 30) / 120, 0, 1) * 14;
  if (input.timeToCloseSec > 240) reasons.push("far from close");

  let resolutionPenalty = 0;
  if (/\bsay\b|announce|official|reportedly|according to/i.test(q)) {
    resolutionPenalty += 10;
    reasons.push("resolution source ambiguity");
  }
  if (!input.parsed.tradeable) {
    resolutionPenalty += 20;
    reasons.push("unparseable market");
  }

  const raw = spreadScore + depthScore + volumeScore + tScore + 20 - resolutionPenalty;
  const score = clamp(raw, 0, 100);

  if (score >= 80) reasons.unshift("excellent quality");
  else if (score >= 70) reasons.unshift("good quality");
  else if (score >= 50) reasons.unshift("borderline quality");
  else reasons.unshift("poor quality");

  return { score, reasons };
}
