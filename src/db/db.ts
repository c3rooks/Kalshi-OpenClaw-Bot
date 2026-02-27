import Database from "better-sqlite3";
import { config } from "../config";
import { runMigrations } from "./migrations";

const db = new Database(config.dbPath);
runMigrations(db);

type Jsonable = unknown;

export function getDb(): Database.Database {
  return db;
}

export function insertEvent(level: string, message: string, json?: Jsonable): void {
  db.prepare(`INSERT INTO events(ts, level, message, json) VALUES(?, ?, ?, ?)`).run(
    Date.now(),
    level,
    message,
    json ? JSON.stringify(json) : null
  );
}

export type MarketSnapshot = {
  marketId: string;
  ticker?: string;
  question?: string;
  eventTitle?: string;
  marketTitle?: string;
  category?: string;
  status?: string;
  volume?: number;
  expiryTs?: number;
  bestYes?: number;
  bestNo?: number;
  liquidityYes?: number;
  liquidityNo?: number;
  raw?: unknown;
};

export function insertMarketSnapshot(row: MarketSnapshot): void {
  db.prepare(
    `INSERT INTO markets(
      ts, market_id, ticker, question, event_title, market_title, category, status, volume,
      expiry_ts, best_yes, best_no, liquidity_yes, liquidity_no, raw_json
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    Date.now(),
    row.marketId,
    row.ticker ?? row.marketId,
    row.question ?? null,
    row.eventTitle ?? null,
    row.marketTitle ?? null,
    row.category ?? null,
    row.status ?? null,
    row.volume ?? null,
    row.expiryTs ?? null,
    row.bestYes ?? null,
    row.bestNo ?? null,
    row.liquidityYes ?? null,
    row.liquidityNo ?? null,
    row.raw ? JSON.stringify(row.raw) : null
  );
}

export type OrderRowInput = {
  marketId: string;
  side: "YES" | "NO";
  price: number;
  sizeUsd: number;
  sizeShares: number;
  status: string;
  exchangeOrderId?: string;
  feeUsd?: number;
  fillSizeShares?: number;
  fillTs?: number;
  cancelTs?: number;
  raw?: unknown;
};

export function insertOrder(row: OrderRowInput): number {
  const result = db.prepare(
    `INSERT INTO orders(ts, market_id, side, price, size_usd, size_shares, status, exchange_order_id, fee_usd, fill_size_shares, fill_ts, cancel_ts, raw_json)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    Date.now(),
    row.marketId,
    row.side,
    row.price,
    row.sizeUsd,
    row.sizeShares,
    row.status,
    row.exchangeOrderId ?? null,
    row.feeUsd ?? null,
    row.fillSizeShares ?? null,
    row.fillTs ?? null,
    row.cancelTs ?? null,
    row.raw ? JSON.stringify(row.raw) : null
  );
  return Number(result.lastInsertRowid);
}

export function updateOrderStatus(
  id: number,
  status: string,
  opts?: { exchangeOrderId?: string; feeUsd?: number; fillSizeShares?: number; fillTs?: number; cancelTs?: number; raw?: unknown }
): void {
  db.prepare(
    `UPDATE orders
     SET status = ?,
         exchange_order_id = COALESCE(?, exchange_order_id),
         fee_usd = COALESCE(?, fee_usd),
         fill_size_shares = COALESCE(?, fill_size_shares),
         fill_ts = COALESCE(?, fill_ts),
         cancel_ts = COALESCE(?, cancel_ts),
         raw_json = COALESCE(?, raw_json)
     WHERE id = ?`
  ).run(
    status,
    opts?.exchangeOrderId ?? null,
    opts?.feeUsd ?? null,
    opts?.fillSizeShares ?? null,
    opts?.fillTs ?? null,
    opts?.cancelTs ?? null,
    opts?.raw ? JSON.stringify(opts.raw) : null,
    id
  );
}

export function insertPosition(input: {
  originOrderId?: number;
  marketId: string;
  side: "YES" | "NO";
  avgPrice: number;
  shares: number;
  costUsd: number;
  feesUsd?: number;
}): number {
  const result = db
    .prepare(`INSERT INTO positions(ts_open, origin_order_id, market_id, side, avg_price, shares, cost_usd, fees_usd) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(Date.now(), input.originOrderId ?? null, input.marketId, input.side, input.avgPrice, input.shares, input.costUsd, input.feesUsd ?? 0);

  return Number(result.lastInsertRowid);
}

export function resolvePosition(
  id: number,
  resolved: { outcome: "WIN" | "LOSS"; payoutUsd: number; pnlUsd: number; feesUsd?: number; resolvedTs?: number }
): void {
  db.prepare(`UPDATE positions SET resolved_ts = ?, outcome = ?, payout_usd = ?, pnl_usd = ?, fees_usd = COALESCE(?, fees_usd) WHERE id = ?`).run(
    resolved.resolvedTs ?? Date.now(),
    resolved.outcome,
    resolved.payoutUsd,
    resolved.pnlUsd,
    resolved.feesUsd ?? null,
    id
  );
}

export function getBotState(key: string): string | undefined {
  const row = db.prepare(`SELECT value FROM bot_state WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value;
}

export function setBotState(key: string, value: string): void {
  db.prepare(
    `INSERT INTO bot_state(key, value) VALUES(?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`
  ).run(key, value);
}

export function insertPerfMetric(metric: string, valueMs: number, json?: unknown): void {
  db.prepare(`INSERT INTO perf(ts, metric, value_ms, json) VALUES(?, ?, ?, ?)`).run(
    Date.now(),
    metric,
    valueMs,
    json ? JSON.stringify(json) : null
  );
}

export function insertMarketIntelligence(row: {
  marketId: string;
  side: "YES" | "NO";
  marketType?: string;
  underlying?: string;
  location?: string;
  qualityScore: number;
  qualityReasons: string[];
  pModel: number;
  confidence: number;
  impliedPrice: number;
  fillProb: number;
  expectedCost: number;
  edge: number;
  evPerTrade: number;
  decision: "TRADE" | "SKIP";
  reasons: string[];
  raw?: unknown;
}): void {
  db.prepare(
    `INSERT INTO market_intelligence(
      ts, market_id, side, market_type, underlying, location, quality_score, quality_reasons, p_model, confidence, implied_price,
      fill_prob, expected_cost, edge, ev_per_trade, decision, reasons, raw_json
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    Date.now(),
    row.marketId,
    row.side,
    row.marketType ?? null,
    row.underlying ?? null,
    row.location ?? null,
    row.qualityScore,
    JSON.stringify(row.qualityReasons),
    row.pModel,
    row.confidence,
    row.impliedPrice,
    row.fillProb,
    row.expectedCost,
    row.edge,
    row.evPerTrade,
    row.decision,
    JSON.stringify(row.reasons),
    row.raw ? JSON.stringify(row.raw) : null
  );
}

export type DecisionLogInput = {
  profile: string;
  isChampion: boolean;
  marketId: string;
  side?: "YES" | "NO" | null;
  action: "BUY" | "NOOP";
  reason: string;
  tteSec: number;
  price?: number | null;
  sizeUsd?: number | null;
  qualityScore?: number;
  edge?: number;
  fillProb?: number;
  expectedCost?: number;
  impliedPrice?: number;
  pModel?: number | null;
  config?: unknown;
  raw?: unknown;
};

export function insertDecisionLog(input: DecisionLogInput): number {
  const result = db
    .prepare(
      `INSERT INTO decision_log(
        ts, profile, is_champion, market_id, side, action, reason, tte_sec, price, size_usd,
        quality_score, edge, fill_prob, expected_cost, implied_price, p_model, config_json, raw_json
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      Date.now(),
      input.profile,
      input.isChampion ? 1 : 0,
      input.marketId,
      input.side ?? null,
      input.action,
      input.reason,
      input.tteSec,
      input.price ?? null,
      input.sizeUsd ?? null,
      input.qualityScore ?? null,
      input.edge ?? null,
      input.fillProb ?? null,
      input.expectedCost ?? null,
      input.impliedPrice ?? null,
      input.pModel ?? null,
      input.config ? JSON.stringify(input.config) : null,
      input.raw ? JSON.stringify(input.raw) : null
    );
  return Number(result.lastInsertRowid);
}

export function bindDecisionExecution(decisionId: number, data: { orderId?: number; positionId?: number }): void {
  db.prepare(`UPDATE decision_log SET linked_order_id = COALESCE(?, linked_order_id), linked_position_id = COALESCE(?, linked_position_id) WHERE id = ?`).run(
    data.orderId ?? null,
    data.positionId ?? null,
    decisionId
  );
}

export function resolveDecisionOutcomeByPosition(
  positionId: number,
  outcome: "WIN" | "LOSS",
  pnlUsd: number,
  marketId: string,
  rootCause: string,
  details?: unknown
): void {
  const now = Date.now();
  const row = db
    .prepare(`SELECT id FROM decision_log WHERE linked_position_id = ? ORDER BY id DESC LIMIT 1`)
    .get(positionId) as { id: number } | undefined;
  const decisionId = row?.id ?? null;
  if (decisionId != null) {
    db.prepare(`UPDATE decision_log SET outcome = ?, pnl_usd = ?, resolved_ts = ? WHERE id = ?`).run(outcome, pnlUsd, now, decisionId);
  }
  db.prepare(`INSERT INTO attribution_log(ts, decision_id, market_id, outcome, pnl_usd, root_cause, details_json) VALUES(?, ?, ?, ?, ?, ?, ?)`).run(
    now,
    decisionId,
    marketId,
    outcome,
    pnlUsd,
    rootCause,
    details ? JSON.stringify(details) : null
  );
}

export function insertStrategyVersionSnapshot(input: {
  profile: string;
  role: "champion" | "challenger";
  params: unknown;
  sampleSize: number;
  wins: number;
  losses: number;
  pnlUsd: number;
  maxDrawdownUsd: number;
  score: number;
  promoted: boolean;
}): void {
  db.prepare(
    `INSERT INTO strategy_versions(
      ts, profile, role, params_json, sample_size, wins, losses, pnl_usd, max_drawdown_usd, score, promoted
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    Date.now(),
    input.profile,
    input.role,
    JSON.stringify(input.params),
    input.sampleSize,
    input.wins,
    input.losses,
    input.pnlUsd,
    input.maxDrawdownUsd,
    input.score,
    input.promoted ? 1 : 0
  );
}

export function insertPromotionEvent(input: {
  fromProfile: string | null;
  toProfile: string;
  reason: string;
  metrics?: unknown;
}): void {
  db.prepare(`INSERT INTO promotion_events(ts, from_profile, to_profile, reason, metrics_json) VALUES(?, ?, ?, ?, ?)`).run(
    Date.now(),
    input.fromProfile,
    input.toProfile,
    input.reason,
    input.metrics ? JSON.stringify(input.metrics) : null
  );
}

export function clearRuntimeData(scope: "demo" | "all" = "demo"): {
  markets: number;
  orders: number;
  positions: number;
  perf: number;
  intelligence: number;
  learning: number;
  events: number;
  botState: number;
} {
  const like = "demo-%";
  const del = (sql: string, ...params: unknown[]): number => Number(db.prepare(sql).run(...params).changes);

  if (scope === "all") {
    return {
      markets: del(`DELETE FROM markets`),
      orders: del(`DELETE FROM orders`),
      positions: del(`DELETE FROM positions`),
      perf: del(`DELETE FROM perf`),
      intelligence: del(`DELETE FROM market_intelligence`),
      learning:
        del(`DELETE FROM decision_log`) +
        del(`DELETE FROM attribution_log`) +
        del(`DELETE FROM strategy_versions`) +
        del(`DELETE FROM promotion_events`),
      events: del(`DELETE FROM events`),
      botState: del(`DELETE FROM bot_state`)
    };
  }

  return {
    markets: del(`DELETE FROM markets WHERE market_id LIKE ? OR COALESCE(raw_json,'') LIKE '%"seeded":true%'`, like),
    orders: del(`DELETE FROM orders WHERE market_id LIKE ? OR COALESCE(raw_json,'') LIKE '%"seeded":true%'`, like),
    positions: del(`DELETE FROM positions WHERE market_id LIKE ?`, like),
    perf: 0,
    intelligence: del(
      `DELETE FROM market_intelligence WHERE market_id LIKE ? OR COALESCE(raw_json,'') LIKE '%"seeded":true%'`,
      like
    ),
    learning:
      del(`DELETE FROM decision_log WHERE market_id LIKE ?`, like) +
      del(`DELETE FROM attribution_log WHERE market_id LIKE ?`, like),
    events: 0,
    botState: 0
  };
}

export type ReconOrderRow = {
  id: number;
  ts: number;
  market_id: string;
  side: "YES" | "NO";
  price: number;
  size_usd: number;
  size_shares: number;
  status: string;
  exchange_order_id: string | null;
  fee_usd: number | null;
  fill_size_shares: number | null;
  fill_ts: number | null;
  cancel_ts: number | null;
};

export function getLocalOrderByExchangeId(exchangeOrderId: string): ReconOrderRow | null {
  const row = db
    .prepare(
      `SELECT id, ts, market_id, side, price, size_usd, size_shares, status, exchange_order_id, fee_usd, fill_size_shares, fill_ts, cancel_ts
       FROM orders
       WHERE exchange_order_id = ?
       ORDER BY id DESC
       LIMIT 1`
    )
    .get(exchangeOrderId) as ReconOrderRow | undefined;
  return row ?? null;
}

export function getReconcilableOrders(sinceTs: number): ReconOrderRow[] {
  return db
    .prepare(
      `SELECT id, ts, market_id, side, price, size_usd, size_shares, status, exchange_order_id, fee_usd, fill_size_shares, fill_ts, cancel_ts
       FROM orders
       WHERE exchange_order_id IS NOT NULL
         AND ts >= ?
       ORDER BY ts DESC`
    )
    .all(sinceTs) as ReconOrderRow[];
}

export function hasPositionForOriginOrder(orderId: number): boolean {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM positions WHERE origin_order_id = ?`).get(orderId) as { c: number };
  return row.c > 0;
}
