import type { NormalizedMarket, OrderbookState, ParsedRules } from "../plugins/types";
import type { SportsProbabilityProvider } from "./providers/sports";
import type { WeatherProbabilityProvider } from "./providers/weather";

export type MarketKind = "threshold" | "weather" | "sports" | "generic";

export type MarketQualityInput = {
  spread: number;
  depthAtTarget: number;
  requiredDepth: number;
  volatility: number;
  volume: number;
  timeToCloseSec: number;
  resolutionDelayRisk: number;
  marketTypeRisk: number;
};

export type MarketQualityScore = {
  score: number;
  reasons: string[];
};

export type ProbabilityEstimate = {
  pModel: number;
  confidence: number;
  reasons: string[];
  kind: MarketKind;
};

export type ExecutionEstimate = {
  fillProb: number;
  expectedCost: number;
  reasons: string[];
};

export type EdgeGateInput = {
  pModel: number;
  impliedPrice: number;
  expectedCost: number;
  minEdge: number;
  fillProb: number;
  minFillProb: number;
};

export type EdgeGateResult = {
  trade: boolean;
  edge: number;
  expectedValuePerTrade: number;
  reasons: string[];
};

export type IntelligenceInput = {
  market: NormalizedMarket;
  rules: ParsedRules;
  orderbook: OrderbookState;
  side: "YES" | "NO";
  targetPrice: number;
  usdSize: number;
  timeToCloseSec: number;
  referenceValue: number | null;
  recentMids: number[];
  historicalFillRate: number;
  minQualityScore: number;
  minEdge: number;
  minFillProb: number;
  weatherProvider?: WeatherProbabilityProvider;
  sportsProvider?: SportsProbabilityProvider;
};

export type IntelligenceOutput = {
  quality: MarketQualityScore;
  probability: ProbabilityEstimate;
  execution: ExecutionEstimate;
  gate: EdgeGateResult;
  impliedPrice: number;
  reasons: string[];
};
