import type { NormalizedMarket as KalshiMarket, NormalizedOrderbook } from "../kalshi/types";

export type NormalizedMarket = {
  marketId: string;
  ticker: string;
  question: string;
  expiryTs: number;
  eventTitle?: string;
  marketTitle?: string;
  category?: string;
  status?: "open" | "closed" | "resolved";
  volume?: number;
  extra?: Record<string, unknown>;
};

export type OrderbookState = {
  bestAskYes: number;
  bestAskNo: number;
  liquidityYesShares: number;
  liquidityNoShares: number;
  spreadHint?: number;
  levels?: NormalizedOrderbook;
};

export type ParsedRules = {
  marketType: "binary";
  resolutionTime: number;
  threshold?: number;
  relation?: "ABOVE" | "BELOW";
  reliableThreshold?: boolean;
};

export interface MarketAdapter {
  readonly id: string;
  listCandidateMarkets(): Promise<NormalizedMarket[]>;
  listMarkets(filters?: Record<string, unknown>): Promise<NormalizedMarket[]>;
  getMarketState(market: NormalizedMarket): Promise<{ resolved: boolean; winningSide?: "YES" | "NO" }>;
  getOrderbook(market: NormalizedMarket): Promise<OrderbookState>;
  parseRules(market: NormalizedMarket): Promise<ParsedRules>;
  getMarketByTicker?(ticker: string): Promise<NormalizedMarket | null>;
}

export interface DataFeed {
  readonly id: string;
  start(): void;
  stop(): void;
  getReferenceValue(market: NormalizedMarket): number | null;
}

export type StrategyInput = {
  market: NormalizedMarket;
  orderbook: OrderbookState;
  rules: ParsedRules;
  referenceValue: number | null;
  stopNewTrades: boolean;
  openPositionsCount: number;
  maxOpenPositions: number;
  dailyPnlUsd: number;
  dailyLossLimitUsd: number;
  maxUsdPerTrade: number;
  targetPrice: number;
  exactPriceOnly: boolean;
  nowTs: number;
  slippageBuffer: number;
  timeWindowSec: number;
  externalBufferUsd: number;
};

export type StrategyAction = {
  action: "BUY" | "NOOP";
  side: "YES" | "NO" | null;
  price: number | null;
  sizeUsd: number | null;
  reason: string;
};

export interface StrategyPlugin {
  readonly id: string;
  decide(input: StrategyInput): StrategyAction;
}

export function fromKalshiMarket(m: KalshiMarket): NormalizedMarket {
  return {
    marketId: m.ticker,
    ticker: m.ticker,
    question: m.question || m.marketTitle,
    expiryTs: m.closeTs,
    eventTitle: m.eventTitle,
    marketTitle: m.marketTitle,
    category: m.category,
    status: m.status,
    volume: m.volume,
    extra: m.extra
  };
}
