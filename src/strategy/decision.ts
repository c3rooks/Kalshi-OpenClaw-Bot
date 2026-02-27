export type RiskState = {
  maxOpenPositions: number;
  dailyLossLimitUsd: number;
  dailyPnlUsd: number;
};

export type StrategyInput = {
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
  riskState: RiskState;
  minTimeToExpirySec?: number;
  maxTimeToExpirySec?: number;
};

export type StrategyDecision = {
  shouldTrade: boolean;
  side: "YES" | "NO" | null;
  limitPrice: number | null;
  usdSize: number | null;
  reason: string;
};

function requiredShares(usd: number, price: number): number {
  return usd / Math.max(price, 0.000001);
}

export function decideNearExpiryScoop(input: StrategyInput): StrategyDecision {
  const minTte = input.minTimeToExpirySec ?? 0;
  const maxTte = input.maxTimeToExpirySec ?? 15;

  if (input.stopNewTrades) {
    return { shouldTrade: false, side: null, limitPrice: null, usdSize: null, reason: "STOP_NEW_TRADES enabled" };
  }

  if (input.openPositionsCount >= input.riskState.maxOpenPositions) {
    return {
      shouldTrade: false,
      side: null,
      limitPrice: null,
      usdSize: null,
      reason: "MAX_OPEN_POSITIONS reached"
    };
  }

  if (input.riskState.dailyPnlUsd <= -Math.abs(input.riskState.dailyLossLimitUsd)) {
    return {
      shouldTrade: false,
      side: null,
      limitPrice: null,
      usdSize: null,
      reason: "DAILY_LOSS_LIMIT breached"
    };
  }

  if (input.timeToExpirySec < minTte || input.timeToExpirySec > maxTte) {
    return {
      shouldTrade: false,
      side: null,
      limitPrice: null,
      usdSize: null,
      reason: `timeToExpiry outside range (${minTte}-${maxTte}s)`
    };
  }

  const yesEligible = Number.isFinite(input.bestAskYes) && input.bestAskYes <= input.targetPrice;
  const noEligible = Number.isFinite(input.bestAskNo) && input.bestAskNo <= input.targetPrice;

  if (!yesEligible && !noEligible) {
    return {
      shouldTrade: false,
      side: null,
      limitPrice: null,
      usdSize: null,
      reason: "both sides above target price"
    };
  }

  const candidates: Array<{ side: "YES" | "NO"; bestAsk: number; liquidityShares: number }> = [];
  if (yesEligible) candidates.push({ side: "YES", bestAsk: input.bestAskYes, liquidityShares: input.liquidityYesShares });
  if (noEligible) candidates.push({ side: "NO", bestAsk: input.bestAskNo, liquidityShares: input.liquidityNoShares });

  // Prefer the higher ask that is still <= target (often stronger probability near expiry).
  candidates.sort((a, b) => b.bestAsk - a.bestAsk);

  for (const c of candidates) {
    const limitPrice = input.exactPriceOnly ? input.targetPrice : c.bestAsk;
    const shares = requiredShares(input.maxUsdPerTrade, limitPrice);
    if (c.liquidityShares < shares) continue;
    return {
      shouldTrade: true,
      side: c.side,
      limitPrice,
      usdSize: input.maxUsdPerTrade,
      reason: "candidate matched"
    };
  }

  return {
    shouldTrade: false,
    side: null,
    limitPrice: null,
    usdSize: null,
    reason: "insufficient liquidity at required shares"
  };
}
