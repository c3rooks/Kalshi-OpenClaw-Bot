import { getKalshiHttpClient } from "./client";
import type {
  KalshiOrderbookLevel,
  MarketListFilters,
  NormalizedMarket,
  NormalizedOrderbook
} from "./types";

function pickNumber(...vals: unknown[]): number {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}

function toMs(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "number") return value > 1e12 ? value : value * 1000;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? t : 0;
}

function normalizeLevel(raw: any): KalshiOrderbookLevel | null {
  if (Array.isArray(raw) && raw.length >= 2) {
    const price = Number(raw[0]);
    const count = Number(raw[1]);
    if (Number.isFinite(price) && Number.isFinite(count) && count > 0) {
      return { priceCents: price, count };
    }
    return null;
  }

  const price = pickNumber(raw?.price, raw?.price_cents, raw?.p, raw?.x);
  const count = pickNumber(raw?.count, raw?.size, raw?.quantity, raw?.q, raw?.y);
  if (Number.isFinite(price) && Number.isFinite(count) && count > 0) {
    return { priceCents: price, count };
  }
  return null;
}

function normalizeBidSide(raw: unknown): KalshiOrderbookLevel[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x) => normalizeLevel(x))
    .filter((x): x is KalshiOrderbookLevel => x != null)
    .sort((a, b) => b.priceCents - a.priceCents);
}

export function deriveBestAsksFromBids(bestBidYesCents: number, bestBidNoCents: number): {
  bestAskYes: number;
  bestAskNo: number;
} {
  const askYesCents = Number.isFinite(bestBidNoCents) ? 100 - bestBidNoCents : NaN;
  const askNoCents = Number.isFinite(bestBidYesCents) ? 100 - bestBidYesCents : NaN;
  return {
    bestAskYes: Number.isFinite(askYesCents) ? askYesCents / 100 : Number.POSITIVE_INFINITY,
    bestAskNo: Number.isFinite(askNoCents) ? askNoCents / 100 : Number.POSITIVE_INFINITY
  };
}

function marketStatus(raw: any): "open" | "closed" | "resolved" {
  const status = String(raw?.status ?? raw?.market_status ?? "").toLowerCase();
  if (status.includes("resolved") || status.includes("settled")) return "resolved";
  if (status.includes("open") || status.includes("active") || status.includes("trading")) return "open";
  return "closed";
}

function mapMarket(raw: any): NormalizedMarket {
  const ticker = String(raw?.ticker ?? raw?.market_ticker ?? "");
  const eventTitle = String(raw?.event_title ?? raw?.event?.title ?? raw?.event_name ?? "");
  const marketTitle = String(raw?.title ?? raw?.market_title ?? raw?.subtitle ?? ticker);
  const question = String(raw?.subtitle ?? raw?.yes_sub_title ?? raw?.title ?? raw?.question ?? marketTitle);
  const closeTs = toMs(raw?.close_time ?? raw?.close_date ?? raw?.expiration_time ?? raw?.settlement_time);
  const volume = pickNumber(raw?.volume, raw?.volume_24h, raw?.open_interest, 0);

  return {
    marketId: ticker,
    ticker,
    eventTitle,
    marketTitle,
    question,
    category: String(raw?.category ?? raw?.event?.category ?? ""),
    closeTs,
    status: marketStatus(raw),
    volume: Number.isFinite(volume) ? volume : 0,
    extra: {
      rawStatus: raw?.status ?? raw?.market_status ?? null,
      eventTicker: raw?.event_ticker ?? raw?.event?.ticker ?? null
    }
  };
}

export class KalshiGenericBinaryAdapter {
  readonly id: string = "KalshiGenericBinary";
  private static readonly LIST_CACHE_TTL_MS = 15_000;
  private static readonly listCache = new Map<string, { ts: number; rows: NormalizedMarket[] }>();
  private static readonly ORDERBOOK_CACHE_TTL_MS = 2_500;
  private static readonly orderbookCache = new Map<string, { ts: number; row: NormalizedOrderbook }>();

  private async getMarketRawWithHistoricalFallback(ticker: string): Promise<any | null> {
    const client = getKalshiHttpClient();
    const encoded = encodeURIComponent(ticker);
    try {
      const resp = await client.get(`/trade-api/v2/markets/${encoded}`, undefined, false);
      return resp?.market ?? resp?.data?.market ?? resp;
    } catch (err) {
      const msg = (err as Error).message || "";
      if (!/HTTP 404|failed: 404|market not found/i.test(msg)) throw err;
    }

    try {
      const resp = await client.get(`/trade-api/v2/historical/markets/${encoded}`, undefined, false);
      return resp?.market ?? resp?.data?.market ?? resp;
    } catch (err) {
      const msg = (err as Error).message || "";
      if (!/HTTP 404|failed: 404|market not found/i.test(msg)) throw err;
      return null;
    }
  }

  async listMarkets(filters?: MarketListFilters): Promise<NormalizedMarket[]> {
    const cacheKey = JSON.stringify({
      status: filters?.status ?? "any",
      category: filters?.category ?? "",
      search: filters?.search ?? "",
      closeWithinSec: filters?.closeWithinSec ?? 0,
      minVolume: filters?.minVolume ?? 0
    });
    const cached = KalshiGenericBinaryAdapter.listCache.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.ts <= KalshiGenericBinaryAdapter.LIST_CACHE_TTL_MS) {
      return cached.rows;
    }

    const client = getKalshiHttpClient();
    const out: NormalizedMarket[] = [];
    let cursor: string | undefined;
    const pageLimit = filters?.search || filters?.category ? 4 : 2;

    for (let page = 0; page < pageLimit; page += 1) {
      const q: Record<string, string | number> = { limit: 100 };
      if (cursor) q.cursor = cursor;
      if (filters?.status === "open") q.status = "open";
      if (filters?.status === "resolved") q.status = "settled";

      let resp: any;
      try {
        resp = await client.get("/trade-api/v2/markets", q, false);
      } catch (err) {
        const msg = (err as Error).message.toLowerCase();
        const rateLimited = msg.includes("too many requests") || msg.includes("http 429");
        if (rateLimited) {
          if (out.length > 0) break;
          if (cached) return cached.rows;
        }
        throw err;
      }
      const items: any[] = Array.isArray(resp?.markets)
        ? resp.markets
        : Array.isArray(resp?.data?.markets)
          ? resp.data.markets
          : [];

      for (const raw of items) {
        const m = mapMarket(raw);
        if (!m.ticker) continue;
        if (filters?.status && m.status !== filters.status) continue;
        if (filters?.category && m.category?.toLowerCase() !== filters.category.toLowerCase()) continue;
        if (filters?.search) {
          const s = filters.search.toLowerCase();
          const hay = `${m.ticker} ${m.eventTitle} ${m.marketTitle} ${m.question}`.toLowerCase();
          if (!hay.includes(s)) continue;
        }
        if (filters?.closeWithinSec && m.closeTs > 0) {
          const tteSec = (m.closeTs - Date.now()) / 1000;
          if (tteSec < 0 || tteSec > filters.closeWithinSec) continue;
        }
        if (filters?.minVolume && m.volume < filters.minVolume) continue;
        out.push(m);
      }

      cursor = String(resp?.cursor ?? resp?.next_cursor ?? resp?.data?.cursor ?? "").trim() || undefined;
      if (!cursor) break;
    }

    KalshiGenericBinaryAdapter.listCache.set(cacheKey, { ts: now, rows: out });
    return out;
  }

  async getMarket(ticker: string): Promise<NormalizedMarket | null> {
    const raw = await this.getMarketRawWithHistoricalFallback(ticker);
    if (!raw || typeof raw !== "object") return null;
    return mapMarket(raw);
  }

  async getOrderbook(ticker: string): Promise<NormalizedOrderbook> {
    const now = Date.now();
    const cached = KalshiGenericBinaryAdapter.orderbookCache.get(ticker);
    if (cached && now - cached.ts <= KalshiGenericBinaryAdapter.ORDERBOOK_CACHE_TTL_MS) {
      return cached.row;
    }

    const client = getKalshiHttpClient();
    let resp: any;
    try {
      resp = await client.get(`/trade-api/v2/markets/${encodeURIComponent(ticker)}/orderbook`, undefined, false);
    } catch (err) {
      const msg = String((err as Error).message || "").toLowerCase();
      const rateLimited = msg.includes("too many requests") || msg.includes("http 429");
      if (rateLimited && cached) return cached.row;
      throw err;
    }
    const raw = resp?.orderbook ?? resp?.data?.orderbook ?? resp;

    const yesBids = normalizeBidSide(raw?.yes ?? raw?.yes_bids ?? raw?.bids_yes ?? raw?.bids?.yes);
    const noBids = normalizeBidSide(raw?.no ?? raw?.no_bids ?? raw?.bids_no ?? raw?.bids?.no);

    const bestBidYes = yesBids.length ? yesBids[0].priceCents / 100 : 0;
    const bestBidNo = noBids.length ? noBids[0].priceCents / 100 : 0;
    const asks = deriveBestAsksFromBids(yesBids[0]?.priceCents ?? NaN, noBids[0]?.priceCents ?? NaN);

    const row = {
      yesBids,
      noBids,
      bestBidYes,
      bestBidNo,
      bestAskYes: asks.bestAskYes,
      bestAskNo: asks.bestAskNo,
      liquidityYesShares: noBids.reduce((a, b) => a + b.count, 0),
      liquidityNoShares: yesBids.reduce((a, b) => a + b.count, 0),
      spreadHint: Math.abs(1 - (bestBidYes + bestBidNo))
    };
    KalshiGenericBinaryAdapter.orderbookCache.set(ticker, { ts: now, row });
    return row;
  }

  async getMarketState(ticker: string): Promise<{ resolved: boolean; winningSide?: "YES" | "NO" }> {
    const m = await this.getMarket(ticker);
    if (!m) return { resolved: false };
    const raw = await this.getMarketRawWithHistoricalFallback(ticker);
    if (!raw) return { resolved: m.status === "resolved" };
    const result = String(raw?.result ?? raw?.settlement_value ?? raw?.final_outcome ?? "").toUpperCase();
    if (m.status !== "resolved") return { resolved: false };
    if (result.includes("YES")) return { resolved: true, winningSide: "YES" };
    if (result.includes("NO")) return { resolved: true, winningSide: "NO" };
    return { resolved: true };
  }
}

export class KalshiBtcFastAdapter extends KalshiGenericBinaryAdapter {
  readonly id: string = "KalshiBtcFast";

  async listMarkets(filters?: MarketListFilters): Promise<NormalizedMarket[]> {
    const base = await super.listMarkets({ ...filters, status: "open" });
    return base.filter((m) => {
      const hay = `${m.ticker} ${m.eventTitle} ${m.marketTitle} ${m.question}`.toLowerCase();
      return hay.includes("btc") || hay.includes("bitcoin");
    });
  }
}
