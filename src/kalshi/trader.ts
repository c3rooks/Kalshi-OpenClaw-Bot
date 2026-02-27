import { config } from "../config";
import { insertOrder, insertPosition, updateOrderStatus } from "../db/db";
import { getLastOrderTsForMarket, getTodayOrderCount } from "../db/queries";
import { getRuntimeBotConfig } from "../settings/runtimeConfig";
import { logger } from "../utils/logger";
import { sleep } from "../utils/time";
import { getKalshiHttpClient } from "./client";

export type TradeSide = "YES" | "NO";

export type EntryRequest = {
  marketId: string;
  question: string;
  side: TradeSide;
  price: number;
  sizeUsd: number;
  askSize: number;
  timeToExpirySec?: number;
};

export type EntryResult = {
  orderRowId: number;
  filled: boolean;
  positionRowId?: number;
  exchangeOrderId?: string;
  shares: number;
  avgPrice: number;
  feeUsd?: number;
  submitMs?: number;
  cancelMs?: number;
};

export type OpenPosition = {
  positionRowId: number;
  marketId: string;
  side: TradeSide;
  shares: number;
  avgPrice: number;
  costUsd: number;
  feesUsd?: number;
};

export class KalshiTrader {
  private dryRun = config.dryRun;

  setDryRun(value: boolean): void {
    this.dryRun = value;
  }

  getDryRun(): boolean {
    return this.dryRun;
  }

  async attemptEntry(req: EntryRequest): Promise<EntryResult> {
    const runtime = getRuntimeBotConfig();
    const guardFailures: string[] = [];
    if (!Number.isFinite(req.price) || req.price <= 0 || req.price >= 1) {
      guardFailures.push("invalid price");
    }
    if (!Number.isFinite(req.sizeUsd) || req.sizeUsd <= 0) {
      guardFailures.push("invalid sizeUsd");
    }
    if (req.sizeUsd > runtime.maxOrderNotionalUsd) {
      guardFailures.push(`maxOrderNotional exceeded (${req.sizeUsd.toFixed(2)} > ${runtime.maxOrderNotionalUsd.toFixed(2)})`);
    }
    const lastTs = getLastOrderTsForMarket(req.marketId);
    if (lastTs != null && Date.now() - lastTs < runtime.duplicateCooldownSec * 1000) {
      guardFailures.push(`duplicate cooldown (${runtime.duplicateCooldownSec}s) active`);
    }
    const ordersToday = getTodayOrderCount();
    if (ordersToday >= runtime.maxOrdersPerDay) {
      guardFailures.push(`max orders/day reached (${ordersToday}/${runtime.maxOrdersPerDay})`);
    }

    if (guardFailures.length) {
      const sharesRejected = req.sizeUsd / Math.max(req.price, 0.000001);
      const rejectedOrderRowId = insertOrder({
        marketId: req.marketId,
        side: req.side,
        price: req.price,
        sizeUsd: req.sizeUsd,
        sizeShares: sharesRejected,
        status: "REJECTED",
        raw: {
          question: req.question,
          timeToExpirySec: req.timeToExpirySec ?? null,
          source: this.dryRun ? "dry_run" : "live",
          guardFailures
        }
      });
      logger.warn("Trade rejected by hard execution guards", { marketId: req.marketId, guardFailures });
      return {
        orderRowId: rejectedOrderRowId,
        filled: false,
        shares: sharesRejected,
        avgPrice: req.price
      };
    }

    const shares = req.sizeUsd / Math.max(req.price, 0.000001);
    const orderRowId = insertOrder({
      marketId: req.marketId,
      side: req.side,
      price: req.price,
      sizeUsd: req.sizeUsd,
      sizeShares: shares,
      status: "PENDING",
      exchangeOrderId: undefined,
      raw: {
        question: req.question,
        timeToExpirySec: req.timeToExpirySec ?? null,
        partialFillSeen: false,
        movedAwayCount: 0,
        source: this.dryRun ? "dry_run" : "live"
      }
    });

    if (this.dryRun) {
      const fillable = req.askSize >= shares;
      if (fillable) {
        updateOrderStatus(orderRowId, "FILLED", {
          fillTs: Date.now(),
          raw: { dryRun: true, reason: "liquidity available", timeToExpirySec: req.timeToExpirySec ?? null }
        });
        const positionRowId = insertPosition({
          originOrderId: orderRowId,
          marketId: req.marketId,
          side: req.side,
          avgPrice: req.price,
          shares,
          costUsd: req.sizeUsd,
          feesUsd: 0
        });
        return { orderRowId, filled: true, positionRowId, shares, avgPrice: req.price, submitMs: 0 };
      }

      updateOrderStatus(orderRowId, "CANCELLED", {
        cancelTs: Date.now(),
        raw: { dryRun: true, reason: "insufficient immediate liquidity", timeToExpirySec: req.timeToExpirySec ?? null }
      });
      return { orderRowId, filled: false, shares, avgPrice: req.price, submitMs: 0, cancelMs: 0 };
    }

    const live = await this.placeAndTrackLiveOrder(req, shares);
    if (!live.filled) {
      updateOrderStatus(orderRowId, "CANCELLED", {
        exchangeOrderId: live.exchangeOrderId,
        cancelTs: Date.now(),
        raw: live.raw
      });
      return {
        orderRowId,
        filled: false,
        shares,
        avgPrice: req.price,
        exchangeOrderId: live.exchangeOrderId,
        submitMs: live.submitMs,
        cancelMs: live.cancelMs
      };
    }

    const positionRowId = insertPosition({
      originOrderId: orderRowId,
      marketId: req.marketId,
      side: req.side,
      avgPrice: req.price,
      shares,
      costUsd: req.sizeUsd,
      feesUsd: Number(live.feeUsd ?? 0)
    });

    updateOrderStatus(orderRowId, "FILLED", {
      exchangeOrderId: live.exchangeOrderId,
      feeUsd: live.feeUsd,
      fillSizeShares: live.filledShares,
      fillTs: Date.now(),
      raw: live.raw
    });

    return {
      orderRowId,
      filled: true,
      positionRowId,
      exchangeOrderId: live.exchangeOrderId,
      shares,
      avgPrice: req.price,
      feeUsd: Number(live.feeUsd ?? 0),
      submitMs: live.submitMs,
      cancelMs: live.cancelMs
    };
  }

  private async placeAndTrackLiveOrder(
    req: EntryRequest,
    shares: number
  ): Promise<{ filled: boolean; exchangeOrderId?: string; raw?: unknown; submitMs?: number; cancelMs?: number; feeUsd?: number; filledShares?: number }> {
    const client = getKalshiHttpClient();
    let submitMs = 0;
    let exchangeOrderId: string | undefined;
    const priceCents = Math.round(req.price * 100);

    try {
      const submitStart = Date.now();
      const resp = await client.post(
        "/trade-api/v2/portfolio/orders",
        {
          ticker: req.marketId,
          client_order_id: `oc-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
          side: req.side.toLowerCase(),
          action: "buy",
          type: "limit",
          count: Math.max(1, Math.round(shares)),
          yes_price: req.side === "YES" ? priceCents : undefined,
          no_price: req.side === "NO" ? priceCents : undefined
        },
        true
      );
      submitMs = Date.now() - submitStart;
      exchangeOrderId = String(resp?.order?.order_id ?? resp?.order_id ?? resp?.id ?? "").trim() || undefined;
    } catch (err) {
      logger.error("Kalshi live order placement failed", { error: (err as Error).message });
      return { filled: false, raw: { error: (err as Error).message }, submitMs };
    }

    const deadline = Date.now() + config.orderFillTimeoutMs;
    let partialFillSeen = false;
    let lastFilledShares = 0;
    let lastFeeUsd = 0;
    while (Date.now() < deadline && exchangeOrderId) {
      const st = await this.readOrderStatus(exchangeOrderId);
      if (st.partialFillSeen) partialFillSeen = true;
      if (Number.isFinite(st.filledShares)) lastFilledShares = st.filledShares;
      if (Number.isFinite(st.feeUsd)) lastFeeUsd = st.feeUsd;
      if (st.filled) {
        return {
          filled: true,
          exchangeOrderId,
          raw: { partialFillSeen, timeToExpirySec: req.timeToExpirySec ?? null, filledShares: lastFilledShares, feeUsd: lastFeeUsd },
          submitMs
          ,
          feeUsd: lastFeeUsd,
          filledShares: lastFilledShares
        };
      }
      await sleep(200);
    }

    const cancelMs = exchangeOrderId ? await this.cancelOrder(exchangeOrderId) : 0;
    return {
      filled: false,
      exchangeOrderId,
      raw: { partialFillSeen, timeToExpirySec: req.timeToExpirySec ?? null, filledShares: lastFilledShares, feeUsd: lastFeeUsd },
      submitMs,
      cancelMs,
      feeUsd: lastFeeUsd,
      filledShares: lastFilledShares
    };
  }

  private async readOrderStatus(orderId: string): Promise<{ filled: boolean; partialFillSeen: boolean; filledShares: number; feeUsd: number }> {
    try {
      const client = getKalshiHttpClient();
      const resp = await client.get(`/trade-api/v2/portfolio/orders/${encodeURIComponent(orderId)}`, undefined, true);
      const order = resp?.order ?? resp?.data?.order ?? resp;
      const status = String(order?.status ?? order?.state ?? "").toUpperCase();
      const filled = ["FILLED", "EXECUTED"].includes(status);
      const filledCount = Number(order?.filled_count ?? order?.filled ?? 0);
      const total = Number(order?.count ?? order?.size ?? 0);
      const partialFillSeen = Number.isFinite(filledCount) && Number.isFinite(total) && filledCount > 0 && filledCount < total;
      const feeCandidates = [
        order?.fee,
        order?.fees,
        order?.fee_paid,
        order?.fees_paid,
        order?.total_fee
      ];
      const feeVal = feeCandidates.map((x) => Number(x)).find((x) => Number.isFinite(x)) ?? 0;
      const feeUsd = feeVal > 1 ? feeVal / 100 : feeVal;
      return {
        filled,
        partialFillSeen,
        filledShares: Number.isFinite(filledCount) ? filledCount : 0,
        feeUsd: Number.isFinite(feeUsd) ? feeUsd : 0
      };
    } catch {
      return { filled: false, partialFillSeen: false, filledShares: 0, feeUsd: 0 };
    }
  }

  private async cancelOrder(orderId: string): Promise<number> {
    const start = Date.now();
    try {
      const client = getKalshiHttpClient();
      await client.delete(`/trade-api/v2/portfolio/orders/${encodeURIComponent(orderId)}`, undefined, true);
      return Date.now() - start;
    } catch (err) {
      logger.warn("Kalshi cancel request failed", { error: (err as Error).message });
      return Date.now() - start;
    }
  }
}
