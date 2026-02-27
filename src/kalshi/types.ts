export type KalshiEnv = "demo" | "prod";

export type KalshiCreds = {
  keyId: string;
  privateKeyPem: string;
};

export type KalshiOrderbookLevel = {
  priceCents: number;
  count: number;
};

export type NormalizedOrderbook = {
  yesBids: KalshiOrderbookLevel[];
  noBids: KalshiOrderbookLevel[];
  bestBidYes: number;
  bestBidNo: number;
  bestAskYes: number;
  bestAskNo: number;
  liquidityYesShares: number;
  liquidityNoShares: number;
  spreadHint?: number;
};

export type KalshiMarketStatus = "open" | "closed" | "resolved";

export type NormalizedMarket = {
  marketId: string;
  ticker: string;
  eventTitle: string;
  marketTitle: string;
  question: string;
  category?: string;
  closeTs: number;
  status: KalshiMarketStatus;
  volume: number;
  bestAskYes?: number;
  bestAskNo?: number;
  extra?: Record<string, unknown>;
};

export type MarketListFilters = {
  status?: "open" | "closed" | "resolved";
  category?: string;
  search?: string;
  closeWithinSec?: number;
  minVolume?: number;
};

export type OrderSide = "YES" | "NO";

export type PlaceOrderInput = {
  ticker: string;
  side: OrderSide;
  action: "buy";
  priceCents: number;
  count: number;
};

export type PlacedOrder = {
  orderId: string;
  status: string;
  raw: unknown;
};
