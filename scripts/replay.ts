import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "../src/config";
import { decideNearExpiryScoop } from "../src/strategy/decision";

type Snapshot = {
  ts: number;
  market_id: string;
  question: string | null;
  expiry_ts: number | null;
  best_yes: number | null;
  best_no: number | null;
  liquidity_yes: number | null;
  liquidity_no: number | null;
};

type SimPosition = {
  marketId: string;
  side: "YES" | "NO";
  shares: number;
  costUsd: number;
  expiryTs: number;
};

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, v] = arg.slice(2).split("=");
    if (k) out[k] = v ?? "";
  }
  return out;
}

function fromYmd(s?: string): number | undefined {
  if (!s) return undefined;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.getTime();
}

function toYmdEnd(s?: string): number | undefined {
  if (!s) return undefined;
  const d = new Date(`${s}T23:59:59.999Z`);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.getTime();
}

function loadFromSqlite(dbPath: string, fromTs?: number, toTs?: number): Snapshot[] {
  const db = new Database(dbPath, { readonly: true });
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (Number.isFinite(fromTs)) {
    clauses.push("ts >= ?");
    params.push(fromTs as number);
  }
  if (Number.isFinite(toTs)) {
    clauses.push("ts <= ?");
    params.push(toTs as number);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return db
    .prepare(
      `SELECT ts, market_id, question, expiry_ts, best_yes, best_no, liquidity_yes, liquidity_no
       FROM markets ${where}
       ORDER BY ts ASC`
    )
    .all(...params) as Snapshot[];
}

function loadFromFixture(filePath: string): Snapshot[] {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("fixture JSON must be an array");
  return parsed as Snapshot[];
}

function runReplay(snaps: Snapshot[]) {
  let attempted = 0;
  let fills = 0;
  let cancels = 0;
  let attemptTteTotal = 0;
  let resolvedWins = 0;
  let resolvedLosses = 0;
  let estimatedPnl = 0;

  const openPositions: SimPosition[] = [];
  const latestByMarket = new Map<string, Snapshot>();

  for (const s of snaps) {
    latestByMarket.set(s.market_id, s);

    for (let i = openPositions.length - 1; i >= 0; i -= 1) {
      const p = openPositions[i];
      if (s.ts < p.expiryTs) continue;
      const last = latestByMarket.get(p.marketId);
      if (!last) continue;

      const yes = Number(last.best_yes ?? NaN);
      const no = Number(last.best_no ?? NaN);
      const winningSide: "YES" | "NO" = yes <= no ? "YES" : "NO";
      const won = p.side === winningSide;
      const payout = won ? p.shares : 0;
      const pnl = payout - p.costUsd;
      estimatedPnl += pnl;
      if (won) resolvedWins += 1;
      else resolvedLosses += 1;
      openPositions.splice(i, 1);
    }

    if (!Number.isFinite(s.expiry_ts) || s.expiry_ts == null) continue;
    const tte = (s.expiry_ts - s.ts) / 1000;

    const decision = decideNearExpiryScoop({
      timeToExpirySec: tte,
      bestAskYes: Number(s.best_yes ?? NaN),
      bestAskNo: Number(s.best_no ?? NaN),
      liquidityYesShares: Number(s.liquidity_yes ?? 0),
      liquidityNoShares: Number(s.liquidity_no ?? 0),
      targetPrice: config.targetPrice,
      exactPriceOnly: config.exactPriceOnly,
      maxUsdPerTrade: config.maxRiskPerTradeUsd,
      stopNewTrades: false,
      openPositionsCount: openPositions.length,
      riskState: {
        maxOpenPositions: config.maxOpenPositions,
        dailyLossLimitUsd: config.dailyLossLimitUsd,
        dailyPnlUsd: estimatedPnl
      },
      minTimeToExpirySec: 0,
      maxTimeToExpirySec: config.windowSec
    });

    if (!decision.shouldTrade || !decision.side || !decision.limitPrice || !decision.usdSize) continue;

    attempted += 1;
    attemptTteTotal += tte;

    const shares = decision.usdSize / decision.limitPrice;
    const liq = decision.side === "YES" ? Number(s.liquidity_yes ?? 0) : Number(s.liquidity_no ?? 0);
    if (liq >= shares) {
      fills += 1;
      openPositions.push({
        marketId: s.market_id,
        side: decision.side,
        shares,
        costUsd: decision.usdSize,
        expiryTs: s.expiry_ts
      });
    } else {
      cancels += 1;
    }
  }

  return {
    attemptedTrades: attempted,
    simulatedFills: fills,
    simulatedCancels: cancels,
    estimatedPnlUsd: estimatedPnl,
    fillRate: attempted ? fills / attempted : 0,
    avgAttemptTimeToExpirySec: attempted ? attemptTteTotal / attempted : 0,
    resolvedWins,
    resolvedLosses,
    openPositionsLeft: openPositions.length
  };
}

function timestampForFile(ts = Date.now()): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCHours()).padStart(2, "0")}${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const snapshots = args.fixture
    ? loadFromFixture(path.resolve(args.fixture))
    : loadFromSqlite(path.resolve(config.dbPath), fromYmd(args.from), toYmdEnd(args.to));

  if (!snapshots.length) throw new Error("No snapshots found for replay");

  const report = {
    generatedAt: new Date().toISOString(),
    input: { from: args.from ?? null, to: args.to ?? null, fixture: args.fixture ?? null, snapshots: snapshots.length },
    config: {
      targetPrice: config.targetPrice,
      targetPriceCents: config.targetPriceCents,
      exactPriceOnly: config.exactPriceOnly,
      maxRiskPerTradeUsd: config.maxRiskPerTradeUsd,
      windowSec: config.windowSec,
      maxOpenPositions: config.maxOpenPositions,
      dailyLossLimitUsd: config.dailyLossLimitUsd
    },
    result: runReplay(snapshots)
  };

  fs.mkdirSync(path.resolve("reports"), { recursive: true });
  const outPath = path.resolve("reports", `run-${timestampForFile()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");

  // eslint-disable-next-line no-console
  console.log(`Replay complete. Report: ${outPath}`);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(report.result, null, 2));
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(`Replay failed: ${(err as Error).message}`);
  process.exit(1);
});
