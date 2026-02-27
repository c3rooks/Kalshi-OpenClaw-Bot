import { decideNearExpiryScoop } from "../../strategy/decision";
import type { StrategyAction, StrategyInput, StrategyPlugin } from "../types";

function isHourlyMarket(input: StrategyInput): boolean {
  const text = `${input.market.question ?? ""} ${input.market.marketTitle ?? ""} ${input.market.eventTitle ?? ""} ${input.market.ticker ?? ""}`.toLowerCase();
  const textHourly = /\bhourly\b|\bhour\b|next hour|this hour|in 1 hour|\b1h\b|\b60 min\b|:00\b/.test(text);

  const exp = Number(input.market.expiryTs ?? NaN);
  if (!Number.isFinite(exp)) return textHourly;
  const close = new Date(exp);
  const tteSec = (exp - input.nowTs) / 1000;
  const clockHourly = close.getUTCMinutes() === 0 && close.getUTCSeconds() === 0 && tteSec > 0 && tteSec <= 2 * 60 * 60;
  return textHourly || clockHourly;
}

export class HourlyPriceOnlyStrategy implements StrategyPlugin {
  readonly id = "HourlyPriceOnly";

  decide(input: StrategyInput): StrategyAction {
    if (!isHourlyMarket(input)) {
      return { action: "NOOP", side: null, price: null, sizeUsd: null, reason: "not hourly market" };
    }

    const tte = (input.market.expiryTs - input.nowTs) / 1000;
    const d = decideNearExpiryScoop({
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

    if (!d.shouldTrade || !d.side || !d.limitPrice || !d.usdSize) {
      return { action: "NOOP", side: null, price: null, sizeUsd: null, reason: d.reason };
    }

    return { action: "BUY", side: d.side, price: d.limitPrice, sizeUsd: d.usdSize, reason: "hourly price+window" };
  }
}
