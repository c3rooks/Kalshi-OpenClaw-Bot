import { decideNearExpiryScoop } from "../../strategy/decision";
import { isSafeDirectionSatisfied } from "../../strategy/strike";
import type { StrategyAction, StrategyInput, StrategyPlugin } from "../types";

export class NearExpiry98cWithBufferStrategy implements StrategyPlugin {
  readonly id = "NearExpiry98cWithExternalBuffer";

  decide(input: StrategyInput): StrategyAction {
    const tte = (input.market.expiryTs - input.nowTs) / 1000;
    const baseline = decideNearExpiryScoop({
      timeToExpirySec: tte,
      bestAskYes: input.orderbook.bestAskYes,
      bestAskNo: input.orderbook.bestAskNo,
      liquidityYesShares: input.orderbook.liquidityYesShares,
      liquidityNoShares: input.orderbook.liquidityNoShares,
      targetPrice: input.targetPrice,
      exactPriceOnly: input.exactPriceOnly,
      maxUsdPerTrade: input.maxUsdPerTrade,
      stopNewTrades: input.stopNewTrades,
      openPositionsCount: input.openPositionsCount,
      riskState: {
        maxOpenPositions: input.maxOpenPositions,
        dailyLossLimitUsd: input.dailyLossLimitUsd,
        dailyPnlUsd: input.dailyPnlUsd
      },
      minTimeToExpirySec: 0,
      maxTimeToExpirySec: input.timeWindowSec
    });

    if (!baseline.shouldTrade || !baseline.side || !baseline.limitPrice || !baseline.usdSize) {
      return { action: "NOOP", side: null, price: null, sizeUsd: null, reason: baseline.reason };
    }

    if (!input.rules.reliableThreshold || !input.rules.threshold || !input.rules.relation) {
      return { action: "NOOP", side: null, price: null, sizeUsd: null, reason: "threshold unavailable" };
    }

    if (!Number.isFinite(input.referenceValue)) {
      return { action: "NOOP", side: null, price: null, sizeUsd: null, reason: "reference feed unavailable" };
    }

    const safe = isSafeDirectionSatisfied({
      relation: input.rules.relation,
      side: baseline.side,
      spot: input.referenceValue as number,
      strike: input.rules.threshold,
      bufferUsd: input.externalBufferUsd
    });

    if (!safe) {
      return { action: "NOOP", side: null, price: null, sizeUsd: null, reason: "buffer condition failed" };
    }

    return {
      action: "BUY",
      side: baseline.side,
      price: baseline.limitPrice,
      sizeUsd: baseline.usdSize,
      reason: "ok+buffer"
    };
  }
}
