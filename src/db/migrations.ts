import Database from "better-sqlite3";

function addColumnIfMissing(db: Database.Database, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

export function runMigrations(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      json TEXT
    );

    CREATE TABLE IF NOT EXISTS markets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      market_id TEXT NOT NULL,
      question TEXT,
      expiry_ts INTEGER,
      best_yes REAL,
      best_no REAL,
      liquidity_yes REAL,
      liquidity_no REAL,
      raw_json TEXT
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      market_id TEXT NOT NULL,
      side TEXT NOT NULL CHECK(side IN ('YES','NO')),
      price REAL NOT NULL,
      size_usd REAL NOT NULL,
      size_shares REAL NOT NULL,
      status TEXT NOT NULL,
      exchange_order_id TEXT,
      fill_ts INTEGER,
      cancel_ts INTEGER,
      raw_json TEXT
    );

    CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts_open INTEGER NOT NULL,
      market_id TEXT NOT NULL,
      side TEXT NOT NULL CHECK(side IN ('YES','NO')),
      avg_price REAL NOT NULL,
      shares REAL NOT NULL,
      cost_usd REAL NOT NULL,
      resolved_ts INTEGER,
      outcome TEXT CHECK(outcome IN ('WIN','LOSS')),
      payout_usd REAL,
      pnl_usd REAL
    );

    CREATE TABLE IF NOT EXISTS bot_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS perf (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      metric TEXT NOT NULL,
      value_ms REAL NOT NULL,
      json TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_ts INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS market_intelligence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      market_id TEXT NOT NULL,
      side TEXT NOT NULL CHECK(side IN ('YES','NO')),
      market_type TEXT,
      underlying TEXT,
      location TEXT,
      quality_score REAL NOT NULL,
      quality_reasons TEXT,
      p_model REAL,
      confidence REAL,
      implied_price REAL,
      fill_prob REAL,
      expected_cost REAL,
      edge REAL,
      ev_per_trade REAL,
      decision TEXT NOT NULL,
      reasons TEXT,
      raw_json TEXT
    );

    CREATE TABLE IF NOT EXISTS decision_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      profile TEXT NOT NULL,
      is_champion INTEGER NOT NULL DEFAULT 0,
      market_id TEXT NOT NULL,
      side TEXT CHECK(side IN ('YES','NO')),
      action TEXT NOT NULL,
      reason TEXT,
      tte_sec REAL,
      price REAL,
      size_usd REAL,
      quality_score REAL,
      edge REAL,
      fill_prob REAL,
      expected_cost REAL,
      implied_price REAL,
      p_model REAL,
      config_json TEXT,
      linked_order_id INTEGER,
      linked_position_id INTEGER,
      outcome TEXT CHECK(outcome IN ('WIN','LOSS')),
      pnl_usd REAL,
      resolved_ts INTEGER,
      raw_json TEXT
    );

    CREATE TABLE IF NOT EXISTS attribution_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      decision_id INTEGER,
      market_id TEXT NOT NULL,
      outcome TEXT CHECK(outcome IN ('WIN','LOSS')) NOT NULL,
      pnl_usd REAL NOT NULL,
      root_cause TEXT NOT NULL,
      details_json TEXT
    );

    CREATE TABLE IF NOT EXISTS strategy_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      profile TEXT NOT NULL,
      role TEXT NOT NULL,
      params_json TEXT NOT NULL,
      sample_size INTEGER NOT NULL,
      wins INTEGER NOT NULL,
      losses INTEGER NOT NULL,
      pnl_usd REAL NOT NULL,
      max_drawdown_usd REAL NOT NULL,
      score REAL NOT NULL,
      promoted INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS promotion_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      from_profile TEXT,
      to_profile TEXT NOT NULL,
      reason TEXT NOT NULL,
      metrics_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_orders_market_id ON orders(market_id);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_positions_market_id ON positions(market_id);
    CREATE INDEX IF NOT EXISTS idx_positions_resolved_ts ON positions(resolved_ts);
    CREATE INDEX IF NOT EXISTS idx_perf_metric_ts ON perf(metric, ts);
    CREATE INDEX IF NOT EXISTS idx_markets_market_ts ON markets(market_id, ts);
    CREATE INDEX IF NOT EXISTS idx_market_intel_market_ts ON market_intelligence(market_id, ts);
    CREATE INDEX IF NOT EXISTS idx_decision_profile_ts ON decision_log(profile, ts);
    CREATE INDEX IF NOT EXISTS idx_decision_market_ts ON decision_log(market_id, ts);
    CREATE INDEX IF NOT EXISTS idx_decision_unresolved ON decision_log(linked_position_id, outcome);
    CREATE INDEX IF NOT EXISTS idx_attribution_market_ts ON attribution_log(market_id, ts);
    CREATE INDEX IF NOT EXISTS idx_promotion_ts ON promotion_events(ts);

    CREATE VIEW IF NOT EXISTS today_pnl AS
      SELECT COALESCE(SUM(pnl_usd), 0) AS value
      FROM positions
      WHERE resolved_ts >= strftime('%s','now','start of day') * 1000;

    CREATE VIEW IF NOT EXISTS fill_rate AS
      SELECT
        CASE WHEN COUNT(*) = 0 THEN 0
        ELSE CAST(SUM(CASE WHEN status = 'FILLED' THEN 1 ELSE 0 END) AS REAL) / COUNT(*)
        END AS value
      FROM orders;

    CREATE VIEW IF NOT EXISTS avg_fill_time AS
      SELECT AVG(fill_ts - ts) AS value
      FROM orders
      WHERE fill_ts IS NOT NULL;

    CREATE VIEW IF NOT EXISTS cancels_per_fill AS
      SELECT
        CASE WHEN SUM(CASE WHEN status='FILLED' THEN 1 ELSE 0 END) = 0 THEN 0
        ELSE CAST(SUM(CASE WHEN status='CANCELLED' THEN 1 ELSE 0 END) AS REAL)
           / SUM(CASE WHEN status='FILLED' THEN 1 ELSE 0 END)
        END AS value
      FROM orders;
  `);

  addColumnIfMissing(db, "orders", "exchange_order_id", "TEXT");
  addColumnIfMissing(db, "orders", "fee_usd", "REAL");
  addColumnIfMissing(db, "orders", "fill_size_shares", "REAL");
  addColumnIfMissing(db, "markets", "ticker", "TEXT");
  addColumnIfMissing(db, "markets", "event_title", "TEXT");
  addColumnIfMissing(db, "markets", "market_title", "TEXT");
  addColumnIfMissing(db, "markets", "category", "TEXT");
  addColumnIfMissing(db, "markets", "status", "TEXT");
  addColumnIfMissing(db, "markets", "volume", "REAL");
  addColumnIfMissing(db, "market_intelligence", "market_type", "TEXT");
  addColumnIfMissing(db, "market_intelligence", "underlying", "TEXT");
  addColumnIfMissing(db, "market_intelligence", "location", "TEXT");
  addColumnIfMissing(db, "positions", "origin_order_id", "INTEGER");
  addColumnIfMissing(db, "positions", "fees_usd", "REAL");
}
