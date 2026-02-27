import { computeMarketQualityScore } from "./marketQuality";
import { computeProbabilityEstimate, estimateVolatilityFromMids, inferMarketKind } from "./probabilityEngine";
import { estimateExecution } from "./executionModel";
import { runEdgeGate } from "./edgeGate";
import type { IntelligenceInput, IntelligenceOutput } from "./types";
import { NoExternalWeatherProvider, type WeatherProbabilityProvider } from "./providers/weather";
import { NoExternalSportsProvider, type SportsProbabilityProvider } from "./providers/sports";

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function marketTypeRisk(kind: string): number {
  if (kind === "sports") return 0.35;
  if (kind === "weather") return 0.25;
  if (kind === "threshold") return 0.15;
  return 0.2;
}

function resolutionDelayRisk(status?: string): number {
  if (!status) return 0.15;
  const s = status.toLowerCase();
  if (s.includes("resolved")) return 0;
  if (s.includes("closed")) return 0.25;
  return 0.1;
}

export async function computeIntelligence(input: IntelligenceInput): Promise<IntelligenceOutput> {
  const impliedPrice = clamp(input.side === "YES" ? input.orderbook.bestAskYes : input.orderbook.bestAskNo, 0.01, 0.99);
  const spread = Math.abs(input.orderbook.spreadHint ?? 0);
  const depthAtTarget = input.side === "YES" ? input.orderbook.liquidityYesShares : input.orderbook.liquidityNoShares;
  const requiredDepth = input.usdSize / Math.max(input.targetPrice, 0.0001);
  const volatility = estimateVolatilityFromMids(input.recentMids);

  const kind = inferMarketKind(input.market.category, input.market.question);
  const quality = computeMarketQualityScore({
    spread,
    depthAtTarget,
    requiredDepth,
    volatility,
    volume: Number(input.market.volume ?? 0),
    timeToCloseSec: input.timeToCloseSec,
    resolutionDelayRisk: resolutionDelayRisk(input.market.status),
    marketTypeRisk: marketTypeRisk(kind)
  });

  const probability = await computeProbabilityEstimate({
    kind,
    side: input.side,
    impliedPrice,
    rules: input.rules,
    referenceValue: input.referenceValue,
    timeToCloseSec: input.timeToCloseSec,
    mids: input.recentMids,
    weatherProvider: input.weatherProvider ?? new NoExternalWeatherProvider(),
    sportsProvider: input.sportsProvider ?? new NoExternalSportsProvider(),
    marketQuestion: input.market.question,
    marketCategory: input.market.category
  });

  const execution = estimateExecution({
    depthAtTarget,
    requiredDepth,
    spread,
    volatility,
    historicalFillRate: input.historicalFillRate
  });

  const gate = runEdgeGate({
    pModel: probability.pModel,
    impliedPrice,
    expectedCost: execution.expectedCost,
    minEdge: input.minEdge,
    fillProb: execution.fillProb,
    minFillProb: input.minFillProb
  });

  const reasons = [
    ...quality.reasons,
    ...probability.reasons,
    ...execution.reasons,
    ...gate.reasons
  ];

  if (quality.score < input.minQualityScore) {
    reasons.push(`quality below MIN_QUALITY_SCORE (${quality.score.toFixed(1)} < ${input.minQualityScore.toFixed(1)})`);
  }

  return {
    quality,
    probability,
    execution,
    gate,
    impliedPrice,
    reasons
  };
}
