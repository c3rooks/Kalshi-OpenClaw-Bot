import { describe, expect, it } from "vitest";
import { parseStrikeFromQuestion, isSafeDirectionSatisfied } from "../src/strategy/strike";
import { decideStrategyTrade } from "../src/strategy/modes";

describe("parseStrikeFromQuestion", () => {
  it("parses strike and relation for ABOVE question", () => {
    const p = parseStrikeFromQuestion("Will BTC be above $102,500 at 12:00 UTC?");
    expect(p.reliable).toBe(true);
    expect(p.relation).toBe("ABOVE");
    expect(p.strike).toBe(102500);
  });

  it("parses strike with k suffix", () => {
    const p = parseStrikeFromQuestion("Will Bitcoin close below 100k today?");
    expect(p.reliable).toBe(true);
    expect(p.relation).toBe("BELOW");
    expect(p.strike).toBe(100000);
  });

  it("returns unreliable when no strike", () => {
    const p = parseStrikeFromQuestion("Will BTC be up or down in 5m?");
    expect(p.reliable).toBe(false);
    expect(p.strike).toBe(null);
  });
});

describe("BTC buffer logic", () => {
  it("safe direction is satisfied for ABOVE+YES only when spot >= strike+buffer", () => {
    expect(
      isSafeDirectionSatisfied({ relation: "ABOVE", side: "YES", strike: 100000, spot: 100030, bufferUsd: 25 })
    ).toBe(true);
    expect(
      isSafeDirectionSatisfied({ relation: "ABOVE", side: "YES", strike: 100000, spot: 100010, bufferUsd: 25 })
    ).toBe(false);
  });

  it("strategy 2 blocks trade when strike cannot be extracted", () => {
    const d = decideStrategyTrade({
      mode: "LAST_30S_98C_WITH_BTC_BUFFER",
      question: "Will BTC be up or down in 5m?",
      timeToExpirySec: 10,
      bestAskYes: 0.97,
      bestAskNo: 0.3,
      liquidityYesShares: 200,
      liquidityNoShares: 200,
      targetPrice: 0.98,
      exactPriceOnly: true,
      maxUsdPerTrade: 10,
      stopNewTrades: false,
      openPositionsCount: 0,
      maxOpenPositions: 1,
      dailyLossLimitUsd: 25,
      dailyPnlUsd: 0,
      btcSpotPrice: 100500,
      btcBufferUsd: 25
    });
    expect(d.shouldTrade).toBe(false);
    expect(d.reason).toContain("strike extraction failed");
  });

  it("strategy 2 trades only when buffer condition passes", () => {
    const yesBlocked = decideStrategyTrade({
      mode: "LAST_30S_98C_WITH_BTC_BUFFER",
      question: "Will BTC be above $100,000 at 12:00 UTC?",
      timeToExpirySec: 20,
      bestAskYes: 0.97,
      bestAskNo: 0.99,
      liquidityYesShares: 200,
      liquidityNoShares: 200,
      targetPrice: 0.98,
      exactPriceOnly: true,
      maxUsdPerTrade: 10,
      stopNewTrades: false,
      openPositionsCount: 0,
      maxOpenPositions: 1,
      dailyLossLimitUsd: 25,
      dailyPnlUsd: 0,
      btcSpotPrice: 100010,
      btcBufferUsd: 25
    });
    expect(yesBlocked.shouldTrade).toBe(false);

    const yesAllowed = decideStrategyTrade({
      mode: "LAST_30S_98C_WITH_BTC_BUFFER",
      question: "Will BTC be above $100,000 at 12:00 UTC?",
      timeToExpirySec: 20,
      bestAskYes: 0.97,
      bestAskNo: 0.99,
      liquidityYesShares: 200,
      liquidityNoShares: 200,
      targetPrice: 0.98,
      exactPriceOnly: true,
      maxUsdPerTrade: 10,
      stopNewTrades: false,
      openPositionsCount: 0,
      maxOpenPositions: 1,
      dailyLossLimitUsd: 25,
      dailyPnlUsd: 0,
      btcSpotPrice: 100040,
      btcBufferUsd: 25
    });
    expect(yesAllowed.shouldTrade).toBe(true);
    expect(yesAllowed.side).toBe("YES");
  });
});
