import { KalshiGenericBinaryAdapter as RawAdapter } from "../../kalshi/adapter";
import { parseStrikeFromQuestion } from "../../strategy/strike";
import type { MarketAdapter, NormalizedMarket, OrderbookState, ParsedRules } from "../types";
import { fromKalshiMarket } from "../types";

export class KalshiGenericBinaryAdapter implements MarketAdapter {
  readonly id: string = "KalshiGenericBinary";
  private readonly inner = new RawAdapter();

  async listCandidateMarkets(): Promise<NormalizedMarket[]> {
    return this.listMarkets({ status: "open", closeWithinSec: 3600 });
  }

  async listMarkets(filters?: Record<string, unknown>): Promise<NormalizedMarket[]> {
    const rows = await this.inner.listMarkets({
      status: (filters?.status as "open" | "closed" | "resolved" | undefined) ?? "open",
      category: typeof filters?.category === "string" ? filters.category : undefined,
      search: typeof filters?.search === "string" ? filters.search : undefined,
      closeWithinSec: Number.isFinite(Number(filters?.closeWithinSec)) ? Number(filters?.closeWithinSec) : undefined,
      minVolume: Number.isFinite(Number(filters?.minVolume)) ? Number(filters?.minVolume) : undefined
    });
    return rows.map(fromKalshiMarket);
  }

  async getMarketByTicker(ticker: string): Promise<NormalizedMarket | null> {
    const m = await this.inner.getMarket(ticker);
    return m ? fromKalshiMarket(m) : null;
  }

  async getMarketState(market: NormalizedMarket): Promise<{ resolved: boolean; winningSide?: "YES" | "NO" }> {
    return this.inner.getMarketState(market.marketId);
  }

  async getOrderbook(market: NormalizedMarket): Promise<OrderbookState> {
    const ob = await this.inner.getOrderbook(market.marketId);
    return {
      bestAskYes: ob.bestAskYes,
      bestAskNo: ob.bestAskNo,
      liquidityYesShares: ob.liquidityYesShares,
      liquidityNoShares: ob.liquidityNoShares,
      spreadHint: ob.spreadHint,
      levels: ob
    };
  }

  async parseRules(market: NormalizedMarket): Promise<ParsedRules> {
    const parsed = parseStrikeFromQuestion(market.question);
    return {
      marketType: "binary",
      resolutionTime: market.expiryTs,
      threshold: parsed.strike ?? undefined,
      relation: parsed.relation ?? undefined,
      reliableThreshold: parsed.reliable
    };
  }
}
