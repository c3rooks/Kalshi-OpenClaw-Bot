import { insertMarketSnapshot, insertOrder, insertPosition, resolvePosition } from "./db";
import { getDb } from "./db";
import { logger } from "../utils/logger";

export function seedDemoDataIfEmpty(): boolean {
  const db = getDb();
  const counts = db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM orders) AS order_count,
        (SELECT COUNT(*) FROM positions) AS position_count,
        (SELECT COUNT(*) FROM markets) AS market_count`
    )
    .get() as { order_count: number; position_count: number; market_count: number };

  if (counts.order_count > 0 || counts.position_count > 0 || counts.market_count > 0) {
    return false;
  }

  const now = Date.now();

  const demoMarkets = [
    {
      marketId: "demo-btc-5m-1",
      question: "BTC above or below $100k in 5m?",
      expiryTs: now + 8_000,
      bestYes: 0.985,
      bestNo: 0.02,
      liquidityYes: 210,
      liquidityNo: 34
    },
    {
      marketId: "demo-btc-5m-2",
      question: "BTC up or down in next 5 minutes?",
      expiryTs: now + 65_000,
      bestYes: 0.55,
      bestNo: 0.47,
      liquidityYes: 480,
      liquidityNo: 510
    },
    {
      marketId: "demo-btc-5m-3",
      question: "BTC above or below open in 5m?",
      expiryTs: now + 11_000,
      bestYes: 0.99,
      bestNo: 0.015,
      liquidityYes: 95,
      liquidityNo: 81
    }
  ];

  for (const m of demoMarkets) {
    insertMarketSnapshot({
      marketId: m.marketId,
      question: m.question,
      expiryTs: m.expiryTs,
      bestYes: m.bestYes,
      bestNo: m.bestNo,
      liquidityYes: m.liquidityYes,
      liquidityNo: m.liquidityNo,
      raw: { seeded: true }
    });
  }

  const orderA = insertOrder({
    marketId: "demo-btc-5m-1",
    side: "YES",
    price: 0.98,
    sizeUsd: 10,
    sizeShares: 10 / 0.98,
    status: "FILLED",
    fillTs: now - 30_000,
    raw: { seeded: true }
  });
  const _orderB = insertOrder({
    marketId: "demo-btc-5m-3",
    side: "YES",
    price: 0.98,
    sizeUsd: 10,
    sizeShares: 10 / 0.98,
    status: "CANCELLED",
    cancelTs: now - 20_000,
    raw: { seeded: true }
  });
  const _orderC = insertOrder({
    marketId: "demo-btc-5m-2",
    side: "NO",
    price: 0.98,
    sizeUsd: 10,
    sizeShares: 10 / 0.98,
    status: "CANCELLED",
    cancelTs: now - 8_000,
    raw: { seeded: true }
  });

  const posWon = insertPosition({
    marketId: "demo-btc-5m-1",
    side: "YES",
    avgPrice: 0.98,
    shares: 10 / 0.98,
    costUsd: 10
  });
  resolvePosition(posWon, {
    outcome: "WIN",
    payoutUsd: 10 / 0.98,
    pnlUsd: 10 / 0.98 - 10,
    resolvedTs: now - 5_000
  });

  logger.info("Seeded demo data into SQLite", {
    seeded: true,
    orders: [orderA],
    openPositionId: null
  });
  return true;
}
