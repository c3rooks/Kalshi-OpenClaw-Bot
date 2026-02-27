import { decideNearExpiryScoop } from "../../strategy/decision";
import type { StrategyAction, StrategyInput, StrategyPlugin } from "../types";

export class NearExpiryPriceOnlyStrategy implements StrategyPlugin {
  readonly id = "NearExpiryPriceOnly";

  decide(input: StrategyInput): StrategyAction {
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
    return { action: "BUY", side: d.side, price: d.limitPrice, sizeUsd: d.usdSize, reason: "price+window" };
  }
}
