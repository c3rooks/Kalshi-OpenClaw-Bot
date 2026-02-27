import { getDb } from "./db";

export type Stats = {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  todayPnl: number;
  totalPnl: number;
  fillRate: number;
  cancels: number;
  avgFillTimeMs: number;
  cancelsPerFill: number;
  estimatedSimPnlUsd: number;
  dryRun: boolean;
  stopNewTrades: boolean;
  dashboardAllowControl?: boolean;
  currentTradeSizeUsd?: number;
  liveTradingActive?: boolean;
  driftMsEstimate?: number;
  driftWarning?: boolean;
};

export type PnlRangeRow = {
  label: "today" | "week" | "month" | "year";
  fromTs: number;
  toTs: number;
  trades: number;
  wins: number;
  losses: number;
  realizedPnl: number;
  winRate: number;
};

export function getStats(flags: {
  dryRun: boolean;
  stopNewTrades: boolean;
  currentTradeSizeUsd?: number;
}): Stats {
  const db = getDb();

  const trades = db.prepare(`SELECT COUNT(*) AS c FROM orders WHERE market_id NOT LIKE 'demo-%'`).get() as { c: number };
  const wins = db.prepare(`SELECT COUNT(*) AS c FROM positions WHERE outcome='WIN' AND market_id NOT LIKE 'demo-%'`).get() as { c: number };
  const losses = db.prepare(`SELECT COUNT(*) AS c FROM positions WHERE outcome='LOSS' AND market_id NOT LIKE 'demo-%'`).get() as { c: number };
  const todayPnl = db.prepare(`SELECT value FROM today_pnl`).get() as { value: number | null } | undefined;
  const totalPnl = db.prepare(
    `SELECT COALESCE(SUM(pnl_usd), 0) AS v FROM positions WHERE resolved_ts IS NOT NULL AND market_id NOT LIKE 'demo-%'`
  ).get() as {
    v: number;
  };
  const fillRate = db.prepare(`SELECT value FROM fill_rate`).get() as { value: number | null } | undefined;
  const avgFill = db.prepare(`SELECT value FROM avg_fill_time`).get() as { value: number | null } | undefined;
  const cpf = db.prepare(`SELECT value FROM cancels_per_fill`).get() as { value: number | null } | undefined;
  const cancels = db
    .prepare(`SELECT COUNT(*) AS c FROM orders WHERE status='CANCELLED' AND market_id NOT LIKE 'demo-%'`)
    .get() as { c: number };

  const resolved = wins.c + losses.c;
  return {
    totalTrades: trades.c,
    wins: wins.c,
    losses: losses.c,
    winRate: resolved ? wins.c / resolved : 0,
    todayPnl: todayPnl?.value ?? 0,
    totalPnl: totalPnl.v,
    fillRate: fillRate?.value ?? 0,
    cancels: cancels.c,
    avgFillTimeMs: avgFill?.value ?? 0,
    cancelsPerFill: cpf?.value ?? 0,
    estimatedSimPnlUsd: totalPnl.v,
    dryRun: flags.dryRun,
    stopNewTrades: flags.stopNewTrades,
    currentTradeSizeUsd: flags.currentTradeSizeUsd
  };
}

export function getRecentOrders(limit: number, status?: string): Record<string, unknown>[] {
  const db = getDb();
  if (status) {
    return db
      .prepare(`SELECT * FROM orders WHERE status = ? AND market_id NOT LIKE 'demo-%' ORDER BY id DESC LIMIT ?`)
      .all(status, limit) as Record<string, unknown>[];
  }
  return db
    .prepare(`SELECT * FROM orders WHERE market_id NOT LIKE 'demo-%' ORDER BY id DESC LIMIT ?`)
    .all(limit) as Record<string, unknown>[];
}

export function getPositions(status: "open" | "resolved"): Record<string, unknown>[] {
  const db = getDb();
  if (status === "open") {
    return db
      .prepare(`SELECT * FROM positions WHERE resolved_ts IS NULL AND market_id NOT LIKE 'demo-%' ORDER BY id DESC`)
      .all() as Record<string, unknown>[];
  }
  return db
    .prepare(`SELECT * FROM positions WHERE resolved_ts IS NOT NULL AND market_id NOT LIKE 'demo-%' ORDER BY id DESC LIMIT 200`)
    .all() as Record<string, unknown>[];
}

export function getOpenPositionCount(): number {
  const row = getDb().prepare(`SELECT COUNT(*) AS c FROM positions WHERE resolved_ts IS NULL`).get() as { c: number };
  return row.c;
}

export function getDailyPnl(): number {
  const row = getDb().prepare(`SELECT value FROM today_pnl`).get() as { value: number | null } | undefined;
  return row?.value ?? 0;
}

export function getTodayOrderCount(): number {
  const fromTs = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS c FROM orders WHERE ts >= ? AND market_id NOT LIKE 'demo-%'`)
    .get(fromTs) as { c: number };
  return row.c;
}

export function getLastOrderTsForMarket(marketId: string): number | null {
  const row = getDb()
    .prepare(`SELECT MAX(ts) AS ts FROM orders WHERE market_id = ?`)
    .get(marketId) as { ts: number | null };
  return row?.ts ?? null;
}

export type OpenPositionRow = {
  id: number;
  market_id: string;
  side: "YES" | "NO";
  avg_price: number;
  shares: number;
  cost_usd: number;
  fees_usd?: number;
};

export function getUnresolvedPositions(): OpenPositionRow[] {
  const db = getDb();
  return db
    .prepare(`SELECT id, market_id, side, avg_price, shares, cost_usd, COALESCE(fees_usd,0) AS fees_usd FROM positions WHERE resolved_ts IS NULL`)
    .all() as OpenPositionRow[];
}

export type OpenPositionDetailRow = OpenPositionRow & { ts_open: number };

export function getUnresolvedPositionDetails(): OpenPositionDetailRow[] {
  return getDb()
    .prepare(`SELECT id, ts_open, market_id, side, avg_price, shares, cost_usd, COALESCE(fees_usd,0) AS fees_usd FROM positions WHERE resolved_ts IS NULL`)
    .all() as OpenPositionDetailRow[];
}

export type ScanSummary = {
  attemptsPerHour: Array<{ hour: string; attempts: number; fills: number; cancels: number }>;
  fills: number;
  cancels: number;
  estimatedSimPnlUsd: number;
  marketsWithinWindow: number;
};

export function getScanSummary(hours = 24, windowSec = 15): ScanSummary {
  const db = getDb();
  const startTs = Date.now() - hours * 60 * 60 * 1000;

  const attemptsPerHour = db
    .prepare(
      `SELECT
         strftime('%Y-%m-%d %H:00', ts/1000, 'unixepoch') AS hour,
         COUNT(*) AS attempts,
         SUM(CASE WHEN status='FILLED' THEN 1 ELSE 0 END) AS fills,
         SUM(CASE WHEN status='CANCELLED' THEN 1 ELSE 0 END) AS cancels
       FROM orders
       WHERE ts >= ?
       GROUP BY hour
       ORDER BY hour DESC
       LIMIT ?`
    )
    .all(startTs, hours) as Array<{ hour: string; attempts: number; fills: number; cancels: number }>;

  const agg = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status='FILLED' THEN 1 ELSE 0 END) AS fills,
         SUM(CASE WHEN status='CANCELLED' THEN 1 ELSE 0 END) AS cancels
       FROM orders
       WHERE ts >= ?`
    )
    .get(startTs) as { fills: number | null; cancels: number | null };

  const est = db.prepare(`SELECT COALESCE(SUM(COALESCE(pnl_usd, 0)), 0) AS v FROM positions`).get() as { v: number };

  const withinWindow = db
    .prepare(
      `SELECT COUNT(*) AS c
       FROM (
         SELECT market_id, MAX(ts) AS max_ts
         FROM markets
         GROUP BY market_id
       ) latest
       JOIN markets m ON m.market_id = latest.market_id AND m.ts = latest.max_ts
       WHERE (m.expiry_ts - ?) BETWEEN 0 AND ?`
    )
    .get(Date.now(), windowSec * 1000) as { c: number };

  return {
    attemptsPerHour,
    fills: agg.fills ?? 0,
    cancels: agg.cancels ?? 0,
    estimatedSimPnlUsd: est.v,
    marketsWithinWindow: withinWindow.c
  };
}

export type MarketSample = {
  market_id: string;
  ticker: string | null;
  event_title: string | null;
  market_title: string | null;
  question: string;
  category: string | null;
  status: string | null;
  volume: number | null;
  expiry_ts: number;
  best_yes: number;
  best_no: number;
  liquidity_yes: number;
  liquidity_no: number;
  ts: number;
};

export function getMarketSamples(limit = 5): MarketSample[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT market_id, ticker, event_title, market_title, question, category, status, volume, expiry_ts, best_yes, best_no, liquidity_yes, liquidity_no, ts
       FROM markets
       WHERE market_id NOT LIKE 'demo-%'
       ORDER BY ts DESC
       LIMIT ?`
    )
    .all(limit) as MarketSample[];
}

export function getRecentMidPrices(marketId: string, limit = 30): number[] {
  const rows = getDb()
    .prepare(
      `SELECT best_yes, best_no
       FROM markets
       WHERE market_id = ?
       ORDER BY ts DESC
       LIMIT ?`
    )
    .all(marketId, limit) as Array<{ best_yes: number | null; best_no: number | null }>;

  return rows
    .reverse()
    .map((r) => {
      const by = Number(r.best_yes ?? NaN);
      const bn = Number(r.best_no ?? NaN);
      if (!Number.isFinite(by) || !Number.isFinite(bn)) return NaN;
      return (by + (1 - bn)) / 2;
    })
    .filter((x) => Number.isFinite(x));
}

export function getHistoricalFillRateNearTarget(targetPrice: number): number {
  const t = Number.isFinite(targetPrice) ? targetPrice : 0.98;
  const row = getDb()
    .prepare(
      `SELECT
         COUNT(*) AS n,
         SUM(CASE WHEN status='FILLED' THEN 1 ELSE 0 END) AS f
       FROM orders
       WHERE ABS(price - ?) <= 0.03`
    )
    .get(t) as { n: number; f: number | null };
  if (!row.n) return 0.25;
  return (row.f ?? 0) / row.n;
}

export function getHistoricalFillRateForMarketType(typePrefix: string): number {
  const row = getDb()
    .prepare(
      `SELECT
         COUNT(*) AS n,
         SUM(CASE WHEN o.status='FILLED' THEN 1 ELSE 0 END) AS f
       FROM orders o
       JOIN (
         SELECT market_id, market_type, MAX(ts) AS max_ts
         FROM market_intelligence
         WHERE market_type LIKE ?
         GROUP BY market_id
       ) mi ON mi.market_id = o.market_id`
    )
    .get(`${typePrefix}%`) as { n: number; f: number | null };
  if (!row.n) return 0.25;
  return (row.f ?? 0) / row.n;
}

export function getTopIntelligence(limit = 25): Record<string, unknown>[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT mi.*
       FROM market_intelligence mi
       JOIN (
         SELECT market_id, MAX(ts) AS max_ts
         FROM market_intelligence
         GROUP BY market_id
       ) latest
         ON latest.market_id = mi.market_id
        AND latest.max_ts = mi.ts
       ORDER BY mi.edge DESC
       LIMIT ?`
    )
    .all(limit) as Record<string, unknown>[];
}

export type WeatherCalibrationRow = {
  market_id: string;
  side: "YES" | "NO";
  outcome: "WIN" | "LOSS";
  ts_open: number;
  resolved_ts: number;
  market_type: string | null;
  p_model: number | null;
};

export function getResolvedWeatherCalibrationRows(opts?: { lookbackDays?: number; limit?: number }): WeatherCalibrationRow[] {
  const db = getDb();
  const lookbackDays = Math.max(1, Number(opts?.lookbackDays ?? 120));
  const limit = Math.max(10, Number(opts?.limit ?? 4000));
  const fromTs = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;

  return db
    .prepare(
      `SELECT
         p.market_id,
         p.side,
         p.outcome,
         p.ts_open,
         p.resolved_ts,
         COALESCE(
           (
             SELECT mi.market_type
             FROM market_intelligence mi
             WHERE mi.market_id = p.market_id
               AND mi.side = p.side
               AND mi.ts <= p.ts_open
               AND mi.market_type LIKE 'WEATHER%'
             ORDER BY mi.ts DESC
             LIMIT 1
           ),
           (
             SELECT mi.market_type
             FROM market_intelligence mi
             WHERE mi.market_id = p.market_id
               AND mi.ts <= p.ts_open
               AND mi.market_type LIKE 'WEATHER%'
             ORDER BY mi.ts DESC
             LIMIT 1
           )
         ) AS market_type,
         COALESCE(
           (
             SELECT mi.p_model
             FROM market_intelligence mi
             WHERE mi.market_id = p.market_id
               AND mi.side = p.side
               AND mi.ts <= p.ts_open
               AND mi.market_type LIKE 'WEATHER%'
             ORDER BY mi.ts DESC
             LIMIT 1
           ),
           (
             SELECT mi.p_model
             FROM market_intelligence mi
             WHERE mi.market_id = p.market_id
               AND mi.ts <= p.ts_open
               AND mi.market_type LIKE 'WEATHER%'
             ORDER BY mi.ts DESC
             LIMIT 1
           )
         ) AS p_model
       FROM positions p
       WHERE p.resolved_ts IS NOT NULL
         AND p.market_id NOT LIKE 'demo-%'
         AND p.ts_open >= ?
         AND EXISTS (
           SELECT 1
           FROM market_intelligence mi2
           WHERE mi2.market_id = p.market_id
             AND mi2.ts <= p.ts_open
             AND mi2.market_type LIKE 'WEATHER%'
         )
       ORDER BY p.resolved_ts DESC
       LIMIT ?`
    )
    .all(fromTs, limit) as WeatherCalibrationRow[];
}

export function getTopIntelligenceByType(typePrefix: "CRYPTO" | "WEATHER", limit = 25): Record<string, unknown>[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT mi.*
       FROM market_intelligence mi
       JOIN (
         SELECT market_id, MAX(ts) AS max_ts
         FROM market_intelligence
         WHERE market_type LIKE ?
         GROUP BY market_id
       ) latest
         ON latest.market_id = mi.market_id
        AND latest.max_ts = mi.ts
       WHERE mi.market_type LIKE ?
       ORDER BY mi.edge DESC
       LIMIT ?`
    )
    .all(`${typePrefix}%`, `${typePrefix}%`, limit) as Record<string, unknown>[];
}

export function getMarketIntelligenceDetails(marketId: string): Record<string, unknown>[] {
  return getDb()
    .prepare(
      `SELECT *
       FROM market_intelligence
       WHERE market_id = ?
       ORDER BY ts DESC
       LIMIT 50`
    )
    .all(marketId) as Record<string, unknown>[];
}

function startOfUtcDay(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function startOfUtcWeek(ts: number): number {
  const d = new Date(ts);
  const day = d.getUTCDay(); // 0=Sun
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const startDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  startDay.setUTCDate(startDay.getUTCDate() + mondayOffset);
  return startDay.getTime();
}

function startOfUtcMonth(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function startOfUtcYear(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), 0, 1);
}

function oneRange(label: PnlRangeRow["label"], fromTs: number, toTs: number): PnlRangeRow {
  const db = getDb();
  const agg = db
    .prepare(
      `SELECT
         COUNT(*) AS trades,
         SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) AS wins,
         SUM(CASE WHEN outcome='LOSS' THEN 1 ELSE 0 END) AS losses,
         COALESCE(SUM(COALESCE(pnl_usd,0)),0) AS realized_pnl
       FROM positions
       WHERE resolved_ts IS NOT NULL
         AND market_id NOT LIKE 'demo-%'
         AND resolved_ts >= ?
         AND resolved_ts < ?`
    )
    .get(fromTs, toTs) as { trades: number; wins: number | null; losses: number | null; realized_pnl: number | null };

  const trades = Number(agg.trades ?? 0);
  const wins = Number(agg.wins ?? 0);
  const losses = Number(agg.losses ?? 0);
  return {
    label,
    fromTs,
    toTs,
    trades,
    wins,
    losses,
    realizedPnl: Number(agg.realized_pnl ?? 0),
    winRate: trades > 0 ? wins / trades : 0
  };
}

export function getPnlRangeRows(nowTs = Date.now()): PnlRangeRow[] {
  const startDay = startOfUtcDay(nowTs);
  const startWeek = startOfUtcWeek(nowTs);
  const startMonth = startOfUtcMonth(nowTs);
  const startYear = startOfUtcYear(nowTs);
  const end = nowTs + 1;

  return [
    oneRange("today", startDay, end),
    oneRange("week", startWeek, end),
    oneRange("month", startMonth, end),
    oneRange("year", startYear, end)
  ];
}

export function getManualOpportunities(limit = 12): Record<string, unknown>[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT mi.market_id,
              mi.side,
              mi.edge,
              mi.quality_score,
              mi.fill_prob,
              mi.implied_price,
              mi.p_model,
              mi.decision,
              m.question,
              m.expiry_ts,
              m.best_yes,
              m.best_no,
              m.liquidity_yes,
              m.liquidity_no
       FROM market_intelligence mi
       JOIN (
         SELECT market_id, MAX(ts) AS max_ts
         FROM market_intelligence
         GROUP BY market_id
       ) latest_i ON latest_i.market_id = mi.market_id AND latest_i.max_ts = mi.ts
       LEFT JOIN (
         SELECT market_id, question, expiry_ts, best_yes, best_no, liquidity_yes, liquidity_no, MAX(ts) AS max_ts
         FROM markets
         GROUP BY market_id
       ) m ON m.market_id = mi.market_id
       WHERE mi.decision='TRADE'
         AND mi.market_id NOT LIKE 'demo-%'
         AND NOT EXISTS (
           SELECT 1 FROM orders o
           WHERE o.market_id = mi.market_id
             AND o.ts >= strftime('%s','now','-2 hours') * 1000
         )
       ORDER BY mi.edge DESC, mi.quality_score DESC
       LIMIT ?`
    )
    .all(limit) as Record<string, unknown>[];
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const w = idx - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

function safeParse(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export type ExecutionReport = {
  fillRateAt098: number;
  avgTimeToExpiryAtAttemptSec: number;
  avgTimeToFillMs: number;
  pnlDistribution: {
    count: number;
    min: number;
    p25: number;
    p50: number;
    p75: number;
    max: number;
    mean: number;
  };
  worstDrawdownUsd: number;
  bestAskMovedAwayBeforeFillCount: number;
  partialFillFrequency: number;
};

export function getExecutionReport(): ExecutionReport {
  const db = getDb();
  const orders = db.prepare(`SELECT ts, fill_ts, price, status, raw_json FROM orders ORDER BY ts ASC`).all() as Array<{
    ts: number;
    fill_ts: number | null;
    price: number;
    status: string;
    raw_json: string | null;
  }>;
  const positions = db
    .prepare(`SELECT pnl_usd FROM positions WHERE resolved_ts IS NOT NULL ORDER BY resolved_ts ASC`)
    .all() as Array<{ pnl_usd: number | null }>;

  const targetOrders = orders.filter((o) => Math.round(o.price * 100) === 98);
  const fillRateAt098 = targetOrders.length
    ? targetOrders.filter((o) => String(o.status).toUpperCase() === "FILLED").length / targetOrders.length
    : 0;

  const tteValues: number[] = [];
  const fillTimes: number[] = [];
  let movedAwayCount = 0;
  let partialSeen = 0;

  for (const o of orders) {
    const raw = safeParse(o.raw_json);
    const tte = Number(raw.timeToExpirySec ?? NaN);
    if (Number.isFinite(tte)) tteValues.push(tte);
    if (Number(raw.movedAwayCount ?? 0) > 0) movedAwayCount += Number(raw.movedAwayCount ?? 0);
    if (raw.partialFillSeen === true) partialSeen += 1;
    if (o.fill_ts && o.fill_ts >= o.ts) fillTimes.push(o.fill_ts - o.ts);
  }

  const avgTimeToExpiryAtAttemptSec = tteValues.length ? tteValues.reduce((a, b) => a + b, 0) / tteValues.length : 0;
  const avgTimeToFillMs = fillTimes.length ? fillTimes.reduce((a, b) => a + b, 0) / fillTimes.length : 0;

  const pnlValues = positions
    .map((p) => Number(p.pnl_usd ?? NaN))
    .filter((x) => Number.isFinite(x));
  const sorted = [...pnlValues].sort((a, b) => a - b);
  const mean = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;

  let running = 0;
  let peak = 0;
  let worstDrawdownUsd = 0;
  for (const p of pnlValues) {
    running += p;
    if (running > peak) peak = running;
    const dd = peak - running;
    if (dd > worstDrawdownUsd) worstDrawdownUsd = dd;
  }

  return {
    fillRateAt098,
    avgTimeToExpiryAtAttemptSec,
    avgTimeToFillMs,
    pnlDistribution: {
      count: sorted.length,
      min: sorted.length ? sorted[0] : 0,
      p25: quantile(sorted, 0.25),
      p50: quantile(sorted, 0.5),
      p75: quantile(sorted, 0.75),
      max: sorted.length ? sorted[sorted.length - 1] : 0,
      mean
    },
    worstDrawdownUsd,
    bestAskMovedAwayBeforeFillCount: movedAwayCount,
    partialFillFrequency: orders.length ? partialSeen / orders.length : 0
  };
}

export function getOrdersForCsv(): Record<string, unknown>[] {
  return getDb().prepare(`SELECT * FROM orders ORDER BY id DESC`).all() as Record<string, unknown>[];
}

export function getPositionsForCsv(): Record<string, unknown>[] {
  return getDb().prepare(`SELECT * FROM positions ORDER BY id DESC`).all() as Record<string, unknown>[];
}

export type TradesFilter = {
  fromTs?: number;
  toTs?: number;
  status?: string;
  side?: string;
  minPrice?: number;
  maxPrice?: number;
  search?: string;
  sortBy?: "ts" | "price" | "size_shares" | "status";
  sortDir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
};

export type TradesPage = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  items: Record<string, unknown>[];
};

function buildTradesWhere(filters: TradesFilter): { whereSql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (Number.isFinite(filters.fromTs)) {
    clauses.push("o.ts >= ?");
    params.push(filters.fromTs as number);
  }
  if (Number.isFinite(filters.toTs)) {
    clauses.push("o.ts <= ?");
    params.push(filters.toTs as number);
  }
  if (filters.status) {
    clauses.push("UPPER(o.status) = UPPER(?)");
    params.push(filters.status);
  }
  if (filters.side) {
    clauses.push("UPPER(o.side) = UPPER(?)");
    params.push(filters.side);
  }
  if (Number.isFinite(filters.minPrice)) {
    clauses.push("o.price >= ?");
    params.push(filters.minPrice as number);
  }
  if (Number.isFinite(filters.maxPrice)) {
    clauses.push("o.price <= ?");
    params.push(filters.maxPrice as number);
  }
  if (filters.search && filters.search.trim()) {
    const s = `%${filters.search.trim()}%`;
    clauses.push("(o.market_id LIKE ? OR COALESCE(o.raw_json, '') LIKE ?)");
    params.push(s, s);
  }

  return {
    whereSql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    params
  };
}

function safeSortBy(sortBy: TradesFilter["sortBy"]): string {
  if (sortBy === "price") return "o.price";
  if (sortBy === "size_shares") return "o.size_shares";
  if (sortBy === "status") return "o.status";
  return "o.ts";
}

function safeSortDir(dir: TradesFilter["sortDir"]): "ASC" | "DESC" {
  return String(dir || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
}

export function getTradesPage(filters: TradesFilter): TradesPage {
  const db = getDb();
  const pageSize = Math.max(10, Math.min(200, Number(filters.pageSize ?? 25)));
  const page = Math.max(1, Number(filters.page ?? 1));
  const offset = (page - 1) * pageSize;

  const { whereSql, params } = buildTradesWhere(filters);
  const sortBy = safeSortBy(filters.sortBy);
  const sortDir = safeSortDir(filters.sortDir);

  const totalRow = db.prepare(`SELECT COUNT(*) AS c FROM orders o ${whereSql}`).get(...params) as { c: number };

  const items = db
    .prepare(
      `SELECT o.*,
              m.question,
              m.event_title,
              m.market_title
       FROM orders o
       LEFT JOIN (
         SELECT market_id, question, event_title, market_title, MAX(ts) AS ts
         FROM markets GROUP BY market_id
       ) m ON m.market_id = o.market_id
       ${whereSql}
       ORDER BY ${sortBy} ${sortDir}, o.id DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, pageSize, offset) as Record<string, unknown>[];

  return {
    page,
    pageSize,
    total: totalRow.c,
    totalPages: Math.max(1, Math.ceil(totalRow.c / pageSize)),
    items
  };
}

export function getTradesForCsv(filters: TradesFilter): Record<string, unknown>[] {
  const db = getDb();
  const { whereSql, params } = buildTradesWhere(filters);
  const sortBy = safeSortBy(filters.sortBy);
  const sortDir = safeSortDir(filters.sortDir);

  return db
    .prepare(`SELECT o.* FROM orders o ${whereSql} ORDER BY ${sortBy} ${sortDir}, o.id DESC`)
    .all(...params) as Record<string, unknown>[];
}

type PerfRow = { metric: string; value_ms: number; ts: number };

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const w = idx - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

export function getPerfSummary(hours = 24): Record<string, unknown> {
  const startTs = Date.now() - Math.max(1, hours) * 60 * 60 * 1000;
  const rows = getDb().prepare(`SELECT metric, value_ms, ts FROM perf WHERE ts >= ? ORDER BY ts DESC`).all(startTs) as PerfRow[];

  const byMetric = new Map<string, number[]>();
  for (const r of rows) {
    if (!byMetric.has(r.metric)) byMetric.set(r.metric, []);
    byMetric.get(r.metric)!.push(r.value_ms);
  }

  const metrics: Record<string, unknown> = {};
  for (const [metric, values] of byMetric.entries()) {
    const sorted = [...values].sort((a, b) => a - b);
    const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    metrics[metric] = {
      count: sorted.length,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      mean
    };
  }

  return { sinceTs: startTs, sampleCount: rows.length, metrics };
}

export type LearningProfileMetrics = {
  profile: string;
  decisions: number;
  trades: number;
  resolved: number;
  wins: number;
  losses: number;
  winRate: number;
  pnlUsd: number;
  maxDrawdownUsd: number;
  score: number;
};

export type ResolvedDecisionFeatureRow = {
  ts: number;
  edge: number | null;
  quality_score: number | null;
  fill_prob: number | null;
  expected_cost: number | null;
  implied_price: number | null;
  p_model: number | null;
  pnl_usd: number | null;
  outcome: "WIN" | "LOSS";
};

export function getResolvedDecisionFeatureRows(opts?: { lookbackDays?: number; limit?: number }): ResolvedDecisionFeatureRow[] {
  const lookbackDays = Math.max(7, Number(opts?.lookbackDays ?? 180));
  const limit = Math.max(50, Number(opts?.limit ?? 8000));
  const fromTs = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
  return getDb()
    .prepare(
      `SELECT
         ts,
         edge,
         quality_score,
         fill_prob,
         expected_cost,
         implied_price,
         p_model,
         pnl_usd,
         outcome
       FROM decision_log
       WHERE action='BUY'
         AND outcome IN ('WIN','LOSS')
         AND ts >= ?
       ORDER BY ts ASC
       LIMIT ?`
    )
    .all(fromTs, limit) as ResolvedDecisionFeatureRow[];
}

export function getLearningProfileMetrics(hours = 168): LearningProfileMetrics[] {
  const startTs = Date.now() - Math.max(1, hours) * 60 * 60 * 1000;
  const rows = getDb()
    .prepare(
      `SELECT profile, outcome, pnl_usd, action
       FROM decision_log
       WHERE ts >= ?`
    )
    .all(startTs) as Array<{ profile: string; outcome: "WIN" | "LOSS" | null; pnl_usd: number | null; action: string }>;

  const by = new Map<string, LearningProfileMetrics & { equity: number; peak: number }>();
  for (const r of rows) {
    const p = r.profile || "unknown";
    if (!by.has(p)) {
      by.set(p, {
        profile: p,
        decisions: 0,
        trades: 0,
        resolved: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        pnlUsd: 0,
        maxDrawdownUsd: 0,
        score: 0,
        equity: 0,
        peak: 0
      });
    }
    const cur = by.get(p)!;
    cur.decisions += 1;
    if (String(r.action).toUpperCase() === "BUY") cur.trades += 1;
    if (r.outcome === "WIN" || r.outcome === "LOSS") {
      cur.resolved += 1;
      if (r.outcome === "WIN") cur.wins += 1;
      else cur.losses += 1;
      const pnl = Number(r.pnl_usd ?? 0);
      cur.pnlUsd += pnl;
      cur.equity += pnl;
      if (cur.equity > cur.peak) cur.peak = cur.equity;
      const dd = cur.peak - cur.equity;
      if (dd > cur.maxDrawdownUsd) cur.maxDrawdownUsd = dd;
    }
  }

  return [...by.values()].map((x) => {
    const resolved = x.resolved;
    const winRate = resolved ? x.wins / resolved : 0;
    const score = x.pnlUsd - 0.5 * x.maxDrawdownUsd + 2 * winRate;
    return {
      profile: x.profile,
      decisions: x.decisions,
      trades: x.trades,
      resolved,
      wins: x.wins,
      losses: x.losses,
      winRate,
      pnlUsd: x.pnlUsd,
      maxDrawdownUsd: x.maxDrawdownUsd,
      score
    };
  });
}

export function getTopAttributionCauses(limit = 10): Array<{ rootCause: string; count: number; pnlUsd: number }> {
  return getDb()
    .prepare(
      `SELECT root_cause AS rootCause, COUNT(*) AS count, COALESCE(SUM(pnl_usd),0) AS pnlUsd
       FROM attribution_log
       GROUP BY root_cause
       ORDER BY count DESC
       LIMIT ?`
    )
    .all(limit) as Array<{ rootCause: string; count: number; pnlUsd: number }>;
}

export function getRecentPromotionEvents(limit = 20): Record<string, unknown>[] {
  return getDb()
    .prepare(`SELECT * FROM promotion_events ORDER BY id DESC LIMIT ?`)
    .all(limit) as Record<string, unknown>[];
}
