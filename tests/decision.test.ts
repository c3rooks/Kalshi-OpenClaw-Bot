import { describe, expect, it } from "vitest";
import { decideNearExpiryScoop, type StrategyInput } from "../src/strategy/decision";

function base(overrides: Partial<StrategyInput> = {}): StrategyInput {
  return {
    timeToExpirySec: 10,
    bestAskYes: 0.98,
    bestAskNo: 0.99,
    liquidityYesShares: 200,
    liquidityNoShares: 200,
    targetPrice: 0.98,
    exactPriceOnly: true,
    maxUsdPerTrade: 10,
    stopNewTrades: false,
    openPositionsCount: 0,
    riskState: {
      maxOpenPositions: 1,
      dailyLossLimitUsd: 25,
      dailyPnlUsd: 0
    },
    minTimeToExpirySec: 0,
    maxTimeToExpirySec: 15,
    ...overrides
  };
}

describe("decideNearExpiryScoop", () => {
  it("trades only when <15s and ask<=0.98", () => {
    expect(decideNearExpiryScoop(base({ timeToExpirySec: 14.9, bestAskYes: 0.98 })).shouldTrade).toBe(true);
    expect(decideNearExpiryScoop(base({ timeToExpirySec: 16, bestAskYes: 0.97 })).shouldTrade).toBe(false);
    expect(decideNearExpiryScoop(base({ timeToExpirySec: 10, bestAskYes: 0.99 })).shouldTrade).toBe(false);
  });

  it("honors EXACT_PRICE_ONLY", () => {
    const exact = decideNearExpiryScoop(base({ exactPriceOnly: true, bestAskYes: 0.95 }));
    expect(exact.shouldTrade).toBe(true);
    expect(exact.limitPrice).toBe(0.98);

    const flex = decideNearExpiryScoop(base({ exactPriceOnly: false, bestAskYes: 0.95 }));
    expect(flex.shouldTrade).toBe(true);
    expect(flex.limitPrice).toBe(0.95);
  });

  it("rejects when liquidity < required shares", () => {
    const d = decideNearExpiryScoop(base({ liquidityYesShares: 2 }));
    expect(d.shouldTrade).toBe(false);
    expect(d.reason).toContain("insufficient liquidity");
  });

  it("rejects when STOP_NEW_TRADES=true", () => {
    const d = decideNearExpiryScoop(base({ stopNewTrades: true }));
    expect(d.shouldTrade).toBe(false);
    expect(d.reason).toContain("STOP_NEW_TRADES");
  });

  it("rejects when MAX_OPEN_POSITIONS reached", () => {
    const d = decideNearExpiryScoop(base({ openPositionsCount: 1 }));
    expect(d.shouldTrade).toBe(false);
    expect(d.reason).toContain("MAX_OPEN_POSITIONS");
  });

  it("rejects when DAILY_LOSS_LIMIT breached", () => {
    const d = decideNearExpiryScoop(
      base({ riskState: { maxOpenPositions: 1, dailyLossLimitUsd: 25, dailyPnlUsd: -30 } })
    );
    expect(d.shouldTrade).toBe(false);
    expect(d.reason).toContain("DAILY_LOSS_LIMIT");
  });

  it("chooses YES vs NO correctly when only one side <=0.98", () => {
    expect(decideNearExpiryScoop(base({ bestAskYes: 0.97, bestAskNo: 0.99 })).side).toBe("YES");
    expect(decideNearExpiryScoop(base({ bestAskYes: 0.99, bestAskNo: 0.97 })).side).toBe("NO");
  });

  it("does nothing when both sides >0.98", () => {
    const d = decideNearExpiryScoop(base({ bestAskYes: 0.99, bestAskNo: 0.995 }));
    expect(d.shouldTrade).toBe(false);
    expect(d.side).toBe(null);
  });
});
