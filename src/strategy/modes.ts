import { decideNearExpiryScoop } from "./decision";
import { isSafeDirectionSatisfied, parseStrikeFromQuestion } from "./strike";

export type StrategyMode = "LAST_15S_98C" | "LAST_30S_98C_WITH_BTC_BUFFER";

export type ModeInput = {
  mode: StrategyMode;
  question: string;
  timeToExpirySec: number;
  bestAskYes: number;
  bestAskNo: number;
  liquidityYesShares: number;
  liquidityNoShares: number;
  targetPrice: number;
  exactPriceOnly: boolean;
  maxUsdPerTrade: number;
  stopNewTrades: boolean;
  openPositionsCount: number;
  maxOpenPositions: number;
  dailyLossLimitUsd: number;
  dailyPnlUsd: number;
  btcSpotPrice?: number;
  btcBufferUsd?: number;
};

export function decideStrategyTrade(input: ModeInput): {
  shouldTrade: boolean;
  side: "YES" | "NO" | null;
  limitPrice: number | null;
  usdSize: number | null;
  reason: string;
} {
  if (input.mode === "LAST_15S_98C") {
    return decideNearExpiryScoop({
      timeToExpirySec: input.timeToExpirySec,
      bestAskYes: input.bestAskYes,
      bestAskNo: input.bestAskNo,
      liquidityYesShares: input.liquidityYesShares,
      liquidityNoShares: input.liquidityNoShares,
      targetPrice: input.targetPrice,
      exactPriceOnly: true,
      maxUsdPerTrade: input.maxUsdPerTrade,
      stopNewTrades: input.stopNewTrades,
      openPositionsCount: input.openPositionsCount,
      riskState: {
        maxOpenPositions: input.maxOpenPositions,
        dailyLossLimitUsd: input.dailyLossLimitUsd,
        dailyPnlUsd: input.dailyPnlUsd
      },
      minTimeToExpirySec: 0,
      maxTimeToExpirySec: 15
    });
  }

  const strikeInfo = parseStrikeFromQuestion(input.question);
  if (!strikeInfo.reliable || !strikeInfo.strike || !strikeInfo.relation) {
    return {
      shouldTrade: false,
      side: null,
      limitPrice: null,
      usdSize: null,
      reason: `strike extraction failed: ${strikeInfo.reason}`
    };
  }

  if (!Number.isFinite(input.btcSpotPrice)) {
    return {
      shouldTrade: false,
      side: null,
      limitPrice: null,
      usdSize: null,
      reason: "missing BTC spot price"
    };
  }

  const baseline = decideNearExpiryScoop({
    timeToExpirySec: input.timeToExpirySec,
    bestAskYes: input.bestAskYes,
    bestAskNo: input.bestAskNo,
    liquidityYesShares: input.liquidityYesShares,
    liquidityNoShares: input.liquidityNoShares,
    targetPrice: input.targetPrice,
    exactPriceOnly: true,
    maxUsdPerTrade: input.maxUsdPerTrade,
    stopNewTrades: input.stopNewTrades,
    openPositionsCount: input.openPositionsCount,
    riskState: {
      maxOpenPositions: input.maxOpenPositions,
      dailyLossLimitUsd: input.dailyLossLimitUsd,
      dailyPnlUsd: input.dailyPnlUsd
    },
    minTimeToExpirySec: 0,
    maxTimeToExpirySec: 30
  });

  if (!baseline.shouldTrade || !baseline.side || !baseline.limitPrice || !baseline.usdSize) {
    return baseline;
  }

  const safe = isSafeDirectionSatisfied({
    relation: strikeInfo.relation,
    side: baseline.side,
    spot: input.btcSpotPrice as number,
    strike: strikeInfo.strike,
    bufferUsd: input.btcBufferUsd ?? 25
  });

  if (!safe) {
    return {
      shouldTrade: false,
      side: null,
      limitPrice: null,
      usdSize: null,
      reason: "BTC buffer condition not satisfied"
    };
  }

  return {
    shouldTrade: true,
    side: baseline.side,
    limitPrice: baseline.limitPrice,
    usdSize: baseline.usdSize,
    reason: "candidate matched with BTC buffer"
  };
}
