import { assertRequiredConfig, config } from "./config";
import {
  getLocalOrderByExchangeId,
  hasPositionForOriginOrder,
  insertMarketIntelligence,
  insertMarketSnapshot,
  insertPerfMetric,
  insertPosition,
  resolvePosition,
  updateOrderStatus
} from "./db/db";
import { seedDemoDataIfEmpty } from "./db/seed";
import { getHistoricalFillRateForMarketType, getHistoricalFillRateNearTarget, getStats, getUnresolvedPositions } from "./db/queries";
import { startDashboardServer } from "./dashboard/server";
import { CommandListener } from "./notify/commandListener";
import { createNotifier } from "./notify/notifier";
import { KalshiTrader, type OpenPosition } from "./kalshi/trader";
import { getKalshiHttpClient } from "./kalshi/client";
import { RiskManager } from "./risk/riskManager";
import { SizingLadder } from "./risk/sizingLadder";
import { getRuntimeBotConfig } from "./settings/runtimeConfig";
import { getSetting, setSetting } from "./settings/settingsStore";
import { buildAdapter, buildDataFeed, buildStrategy } from "./plugins/factory";
import type { NormalizedMarket } from "./plugins/types";
import { MarketIntelligenceLayer } from "./intel/intelEngine";
import { classifyMarket } from "./intel/marketTypeClassifier";
import { recalibrateWeatherModelFromDb } from "./intel/weatherCalibration";
import { LearningEngine } from "./learning/engine";
import { predictCalibratedWinProb, recalibrateFeatureModelFromDb } from "./learning/featureCalibration";
import { logger } from "./utils/logger";
import { sleep } from "./utils/time";

type RuntimeState = {
  stopNewTrades: boolean;
  maxUsdPerTrade: number;
  blockedReason: string | null;
  blockedSinceTs: number | null;
};

type Candidate = {
  decisionId: number;
  market: NormalizedMarket;
  side: "YES" | "NO";
  price: number;
  sizeUsd: number;
  askSize: number;
  tteSec: number;
  liquidityAtTarget: number;
  spreadHint: number;
  reason: string;
  edge: number;
  fillProb: number;
  qualityScore: number;
  calibratedScore: number;
};

function matchesMarketFocus(
  focus: "crypto_weather" | "all" | "hourly",
  market: Pick<NormalizedMarket, "category" | "eventTitle" | "marketTitle" | "question" | "ticker" | "expiryTs">
): boolean {
  if (focus === "all") return true;
  const hay = `${market.category ?? ""} ${market.eventTitle ?? ""} ${market.marketTitle ?? ""} ${market.question ?? ""} ${market.ticker ?? ""}`.toLowerCase();
  if (focus === "hourly") {
    const textHourly = /\bhourly\b|\bhour\b|next hour|this hour|in 1 hour|\b1h\b|\b60 min\b|:00\b/.test(hay);
    const exp = Number(market.expiryTs ?? NaN);
    const close = Number.isFinite(exp) ? new Date(exp) : null;
    const now = Date.now();
    const tteSec = Number.isFinite(exp) ? (exp - now) / 1000 : NaN;
    const clockHourly =
      close != null &&
      close.getUTCMinutes() === 0 &&
      close.getUTCSeconds() === 0 &&
      Number.isFinite(tteSec) &&
      tteSec > 0 &&
      tteSec <= 2 * 60 * 60;
    return textHourly || clockHourly;
  }
  const category = String(market.category ?? "").toLowerCase();
  if (/multigame|sports|player|points|rebounds|assists|touchdown|nba|nfl|mlb|nhl|soccer|tennis|golf|mma|ufc/.test(hay)) {
    return false;
  }
  if (/\bcrypto\b/.test(category) || /\bweather\b/.test(category)) return true;
  const hasCryptoKeyword = /\bbtc\b|bitcoin|\beth\b|ethereum|\bcrypto\b/.test(hay);
  const hasCryptoStructure = /above|below|over|under|touch|reach|settle|close|end of day|\$[0-9]|price|level|range|\b\d{3,}\b/.test(hay);
  const isCrypto = hasCryptoKeyword && hasCryptoStructure;
  const hasWeatherKeyword = /weather|rain|snow|temp|temperature|precip|inches|fahrenheit|celsius|°f|°c|mm\b|wind|hurricane/.test(hay);
  const hasWeatherStructure = /in | at | for | by | on |through|between|accumulation|high|low|forecast|chance|daily/.test(hay);
  const isWeather = hasWeatherKeyword && hasWeatherStructure;
  return isCrypto || isWeather;
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const esc = (v: unknown): string => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [headers.join(",")];
  for (const row of rows) lines.push(headers.map((h) => esc(row[h])).join(","));
  return lines.join("\n");
}

async function checkClockDrift(): Promise<number | null> {
  try {
    const runtime = getRuntimeBotConfig();
    const t0 = Date.now();
    const resp = await fetch(runtime.kalshiApiBaseUrl, { method: "HEAD" });
    const t1 = Date.now();
    const dateHeader = resp.headers.get("date");
    if (!dateHeader) return null;
    const serverTs = Date.parse(dateHeader);
    if (!Number.isFinite(serverTs)) return null;
    const localMidTs = (t0 + t1) / 2;
    // Midpoint estimate lowers bias from request latency.
    return localMidTs - serverTs;
  } catch {
    return null;
  }
}

function rankCandidates(cands: Candidate[]): Candidate[] {
  return [...cands].sort((a, b) => {
    const calRank = b.calibratedScore - a.calibratedScore;
    if (Math.abs(calRank) > 0.001) return calRank;
    const expiryRank = a.tteSec - b.tteSec;
    if (Math.abs(expiryRank) > 0.001) return expiryRank;
    const liqRank = b.liquidityAtTarget - a.liquidityAtTarget;
    if (Math.abs(liqRank) > 0.001) return liqRank;
    return a.spreadHint - b.spreadHint;
  });
}

function mapRemoteStatus(value: unknown): "FILLED" | "CANCELLED" | "REJECTED" | "PARTIAL" | "PENDING" {
  const s = String(value ?? "").toUpperCase();
  if (s.includes("FILL") || s.includes("EXECUT")) return "FILLED";
  if (s.includes("CANCEL")) return "CANCELLED";
  if (s.includes("REJECT")) return "REJECTED";
  if (s.includes("PART")) return "PARTIAL";
  return "PENDING";
}

function parseRemoteFeeUsd(order: any): number {
  const candidates = [order?.fee, order?.fees, order?.fee_paid, order?.fees_paid, order?.total_fee];
  const found = candidates.map((x) => Number(x)).find((x) => Number.isFinite(x)) ?? 0;
  return found > 1 ? found / 100 : found;
}

async function reconcileRemoteOrders(
  openPositions: OpenPosition[],
  notifier: ReturnType<typeof createNotifier>
): Promise<"ok" | "auth_denied" | "error"> {
  try {
    const client = getKalshiHttpClient();
    const resp = await client.get("/trade-api/v2/portfolio/orders", { limit: 200 }, true);
    const remoteOrders: any[] = Array.isArray(resp?.orders)
      ? resp.orders
      : Array.isArray(resp?.data?.orders)
        ? resp.data.orders
        : [];
    if (!remoteOrders.length) return "ok";

    for (const ro of remoteOrders) {
      const exchangeId = String(ro?.order_id ?? ro?.id ?? ro?.orderId ?? "").trim();
      if (!exchangeId) continue;

      const local = getLocalOrderByExchangeId(exchangeId);
      if (!local) continue;
      const remoteStatus = mapRemoteStatus(ro?.status ?? ro?.state);
      const filledShares = Number(ro?.filled_count ?? ro?.filled ?? ro?.filled_size ?? 0);
      const feeUsd = parseRemoteFeeUsd(ro);

      if (remoteStatus === "FILLED" && local.status !== "FILLED") {
        updateOrderStatus(local.id, "FILLED", {
          fillTs: Date.now(),
          feeUsd: Number.isFinite(feeUsd) ? feeUsd : 0,
          fillSizeShares: Number.isFinite(filledShares) && filledShares > 0 ? filledShares : local.size_shares,
          raw: { reconciled: true, remoteStatus: ro?.status ?? ro?.state }
        });
        if (!hasPositionForOriginOrder(local.id)) {
          const shares = Number.isFinite(filledShares) && filledShares > 0 ? filledShares : local.size_shares;
          const positionRowId = insertPosition({
            originOrderId: local.id,
            marketId: local.market_id,
            side: local.side,
            avgPrice: local.price,
            shares,
            costUsd: local.size_usd,
            feesUsd: Number.isFinite(feeUsd) ? feeUsd : 0
          });
          openPositions.push({
            positionRowId,
            marketId: local.market_id,
            side: local.side,
            shares,
            avgPrice: local.price,
            costUsd: local.size_usd
          });
          await notifier.notify(`order reconciled filled market=${local.market_id} side=${local.side}`);
        }
      } else if (remoteStatus === "CANCELLED" && local.status !== "CANCELLED") {
        updateOrderStatus(local.id, "CANCELLED", {
          cancelTs: Date.now(),
          raw: { reconciled: true, remoteStatus: ro?.status ?? ro?.state }
        });
      } else if (remoteStatus === "REJECTED" && local.status !== "REJECTED") {
        updateOrderStatus(local.id, "REJECTED", {
          raw: { reconciled: true, remoteStatus: ro?.status ?? ro?.state }
        });
      } else if (remoteStatus === "PARTIAL" && local.status === "PENDING") {
        updateOrderStatus(local.id, "PARTIAL", {
          feeUsd: Number.isFinite(feeUsd) ? feeUsd : undefined,
          fillSizeShares: Number.isFinite(filledShares) ? filledShares : undefined,
          raw: { reconciled: true, remoteStatus: ro?.status ?? ro?.state }
        });
      }
    }
    return "ok";
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (/authentication_error|forbidden|unauthorized/i.test(msg)) {
      logger.warn("order reconciliation disabled due to auth", { reason: "orders scope missing or denied" });
      return "auth_denied";
    }
    logger.debug("order reconciliation skipped", { error: msg });
    return "error";
  }
}

async function buildExposureState(
  openPositions: OpenPosition[],
  adapter: ReturnType<typeof buildAdapter>
): Promise<{
  total: number;
  bySymbol: Record<string, number>;
  byLocation: Record<string, number>;
  parsedByMarket: Record<string, ReturnType<typeof classifyMarket>>;
}> {
  const bySymbol: Record<string, number> = {};
  const byLocation: Record<string, number> = {};
  const parsedByMarket: Record<string, ReturnType<typeof classifyMarket>> = {};
  let total = 0;

  for (const p of openPositions) {
    total += p.costUsd;
    try {
      const m = adapter.getMarketByTicker ? await adapter.getMarketByTicker(p.marketId) : null;
      if (!m) continue;
      const parsed = classifyMarket(m.question, m.expiryTs);
      parsedByMarket[p.marketId] = parsed;
      if (parsed.underlying) bySymbol[parsed.underlying] = (bySymbol[parsed.underlying] ?? 0) + p.costUsd;
      if (parsed.location) byLocation[parsed.location] = (byLocation[parsed.location] ?? 0) + p.costUsd;
    } catch {
      // ignore per-position metadata errors
    }
  }

  return { total, bySymbol, byLocation, parsedByMarket };
}

async function run(): Promise<void> {
  assertRequiredConfig();

  let runtimeCfg = getRuntimeBotConfig();
  const liveConfirmCode = String(Math.floor(100000 + Math.random() * 900000));
  setSetting("live.confirm.code", liveConfirmCode);

  const adapter = buildAdapter(runtimeCfg.adapter);
  const strategy = buildStrategy(runtimeCfg.strategy);
  const feed = buildDataFeed({
    adapter: runtimeCfg.adapter,
    strategy: runtimeCfg.strategy,
    btcPriceFeedMode: "coinbase_ws"
  });
  feed.start();

  const notifier = createNotifier();
  const trader = new KalshiTrader();
  let requestedDryRun = config.dryRun;
  const refreshTradingMode = (): void => {
    const liveEnabled = Boolean(getSetting("live.enabled", false));
    const dry = requestedDryRun || !liveEnabled;
    trader.setDryRun(dry);
  };
  refreshTradingMode();
  const intel = new MarketIntelligenceLayer({ weatherEnabled: runtimeCfg.weatherEnable });
  const learner = new LearningEngine(String(getSetting("learning.active_profile", "champion") ?? "champion"));
  runtimeCfg = learner.getEffectiveRuntime(runtimeCfg);
  setSetting("learning.active_profile", learner.getActiveProfile());

  if (config.seedDemoData && trader.getDryRun()) {
    seedDemoDataIfEmpty();
  }

  const ladder = new SizingLadder();

  const state: RuntimeState = {
    stopNewTrades: false,
    maxUsdPerTrade: Math.min(ladder.getCurrentSizeUsd(), runtimeCfg.maxUsdPerTrade),
    blockedReason: null,
    blockedSinceTs: null
  };
  let driftMsEstimate: number | null = null;
  let lastDriftWarnLogTs = 0;

  const riskManager = new RiskManager({
    maxOpenPositions: runtimeCfg.maxOpenPositions,
    dailyLossLimitUsd: runtimeCfg.dailyLossLimitUsd,
    maxOrdersPerDay: runtimeCfg.maxOrdersPerDay,
    stopNewTrades: state.stopNewTrades
  });

  const openPositions: OpenPosition[] = getUnresolvedPositions().map((p) => ({
    positionRowId: p.id,
    marketId: p.market_id,
    side: p.side,
    shares: p.shares,
    avgPrice: p.avg_price,
    costUsd: p.cost_usd,
    feesUsd: Number(p.fees_usd ?? 0)
  }));

  // Clean up stale demo rows from older seeded datasets so they don't block trading.
  for (let i = openPositions.length - 1; i >= 0; i -= 1) {
    const p = openPositions[i];
    if (!p.marketId.startsWith("demo-")) continue;
    resolvePosition(p.positionRowId, {
      outcome: "LOSS",
      payoutUsd: 0,
      pnlUsd: -p.costUsd,
      resolvedTs: Date.now()
    });
    openPositions.splice(i, 1);
  }

  startDashboardServer(config.dashboardPort, {
    getDryRun: () => requestedDryRun,
    setDryRun: (value) => {
      requestedDryRun = value;
      refreshTradingMode();
    },
    allowDryRunToggle: config.allowDryRunToggle,
    dashboardAllowControl: config.dashboardAllowControl,
    getStopNewTrades: () => state.stopNewTrades,
    setStopNewTrades: (value) => {
      state.stopNewTrades = value;
      riskManager.setStopNewTrades(value);
    },
    getMaxUsdPerTrade: () => state.maxUsdPerTrade,
    setMaxUsdPerTrade: (value) => {
      state.maxUsdPerTrade = value;
    },
    onControlTriggered: (message, json) => {
      logger.info(message, json);
      void notifier.notify(`CONFIRMED: ${message}`);
    },
    toCsv,
    getLiveTrading: () => Boolean(getSetting("live.enabled", false)) && !trader.getDryRun(),
    getDriftMsEstimate: () => driftMsEstimate,
    getBlockedReason: () => state.blockedReason,
    getBlockedForMs: () => (state.blockedSinceTs != null ? Date.now() - state.blockedSinceTs : null)
  });

  const commandListener = new CommandListener(
    config.commandsFilePath,
    {
      get stopNewTrades() {
        return state.stopNewTrades;
      },
      set stopNewTrades(v: boolean) {
        state.stopNewTrades = v;
        riskManager.setStopNewTrades(v);
      }
    },
    notifier,
    async () => {
      const stats = getStats({
        dryRun: trader.getDryRun(),
        stopNewTrades: state.stopNewTrades,
        currentTradeSizeUsd: state.maxUsdPerTrade
      });
      return `trades=${stats.totalTrades}, pnl=${stats.todayPnl.toFixed(2)}, open=${openPositions.length}, dryRun=${stats.dryRun}`;
    }
  );
  commandListener.start();

  driftMsEstimate = await checkClockDrift();
  if (driftMsEstimate != null) {
    insertPerfMetric("clock_drift_ms", Math.abs(driftMsEstimate));
    if (Math.abs(driftMsEstimate) > 250) {
      logger.warn("Clock drift warning (>250ms)", { driftMs: driftMsEstimate });
      lastDriftWarnLogTs = Date.now();
    }
  }

  await notifier.notify(
    `bot started (adapter=${runtimeCfg.adapter}, strategy=${runtimeCfg.strategy}, profile=${learner.getActiveProfile()}, dryRun=${trader.getDryRun()}, sizeUsd=${state.maxUsdPerTrade})`
  );

  try {
    const cal = recalibrateWeatherModelFromDb();
    logger.info("Weather calibration bootstrapped", {
      samples: cal.samples,
      multipliers: cal.multipliers,
      fit: cal.fit
    });
  } catch (err) {
    logger.warn("Weather calibration bootstrap failed", { error: (err as Error).message });
  }
  try {
    const cal = recalibrateFeatureModelFromDb();
    logger.info("Feature calibration bootstrapped", {
      samples: cal.samples,
      params: cal.params,
      metrics: cal.metrics
    });
  } catch (err) {
    logger.warn("Feature calibration bootstrap failed", { error: (err as Error).message });
  }

  let lastDailySummaryDay = new Date().getUTCDate();
  let consecutiveLoopErrors = 0;
  let lastBlockedAlertTs = 0;
  let lastOpportunityTs = Date.now();
  let lastNoOpportunityAlertTs = 0;
  let lastErrorAlertTs = 0;
  let highDriftSinceTs: number | null = null;
  let lastDriftAlertTs = 0;
  let lastWeatherCalibrationTs = Date.now();
  let lastFeatureCalibrationTs = Date.now();
  let reconcileDisabledUntilTs = 0;
  const resolutionBackoffUntil = new Map<string, number>();
  const positionDecisionMeta = new Map<number, { edge: number; fillProb: number; qualityScore: number }>();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const loopStart = Date.now();
    let tickSucceeded = false;
    try {
      runtimeCfg = learner.getEffectiveRuntime(getRuntimeBotConfig());

      if (new Date().getUTCSeconds() % 30 === 0) {
        const now = Date.now();
        const liveExpiryTs = Number(getSetting("live.enabled.expires_at", 0) ?? 0);
        if (Boolean(getSetting("live.enabled", false)) && (!Number.isFinite(liveExpiryTs) || liveExpiryTs <= 0)) {
          const fallbackExpiry = now + Math.max(1, runtimeCfg.liveArmTimeoutMin) * 60 * 1000;
          setSetting("live.enabled.expires_at", fallbackExpiry);
        }
        if (liveExpiryTs > 0 && now >= liveExpiryTs && Boolean(getSetting("live.enabled", false))) {
          setSetting("live.enabled", false);
          refreshTradingMode();
          await notifier.notify("LIVE arm timeout reached: auto-switched to DRY_RUN");
        }

        const latestDrift = await checkClockDrift();
        if (latestDrift != null) {
          driftMsEstimate = latestDrift;
          insertPerfMetric("clock_drift_ms", Math.abs(latestDrift));
          if (Math.abs(latestDrift) > 250) {
            const nowTs = Date.now();
            if (nowTs - lastDriftWarnLogTs >= 5 * 60 * 1000) {
              logger.warn("Clock drift warning (>250ms)", { driftMs: latestDrift });
              lastDriftWarnLogTs = nowTs;
            }
            if (highDriftSinceTs == null) highDriftSinceTs = now;
            const sustainedMs = now - highDriftSinceTs;
            if (sustainedMs >= 5 * 60 * 1000 && now - lastDriftAlertTs >= 15 * 60 * 1000) {
              await notifier.notify(`Critical: clock drift high for ${Math.round(sustainedMs / 60000)}m (driftMs=${Math.round(latestDrift)})`);
              lastDriftAlertTs = now;
            }
          } else {
            highDriftSinceTs = null;
          }
        }
        if (Date.now() >= reconcileDisabledUntilTs) {
          const recon = await reconcileRemoteOrders(openPositions, notifier);
          if (recon === "auth_denied") {
            reconcileDisabledUntilTs = Date.now() + 30 * 60 * 1000;
          }
        }
        const promoted = learner.maybePromote(getRuntimeBotConfig());
        if (promoted.changed) {
          setSetting("learning.active_profile", promoted.profile);
          runtimeCfg = learner.getEffectiveRuntime(getRuntimeBotConfig());
          await notifier.notify(`Auto-learn promoted profile=${promoted.profile} reason=${promoted.reason ?? "n/a"}`);
        }
        if (Date.now() - lastWeatherCalibrationTs >= 60 * 60 * 1000) {
          try {
            const cal = recalibrateWeatherModelFromDb();
            logger.info("Weather calibration refreshed", {
              samples: cal.samples,
              multipliers: cal.multipliers,
              fit: cal.fit
            });
          } catch (err) {
            logger.warn("Weather calibration refresh failed", { error: (err as Error).message });
          } finally {
            lastWeatherCalibrationTs = Date.now();
          }
        }
        if (Date.now() - lastFeatureCalibrationTs >= 60 * 60 * 1000) {
          try {
            const cal = recalibrateFeatureModelFromDb();
            logger.info("Feature calibration refreshed", {
              samples: cal.samples,
              params: cal.params,
              metrics: cal.metrics
            });
          } catch (err) {
            logger.warn("Feature calibration refresh failed", { error: (err as Error).message });
          } finally {
            lastFeatureCalibrationTs = Date.now();
          }
        }
      }

      refreshTradingMode();

      for (let i = openPositions.length - 1; i >= 0; i -= 1) {
        const pos = openPositions[i];
        const backoffUntil = resolutionBackoffUntil.get(pos.marketId) ?? 0;
        if (Date.now() < backoffUntil) continue;
        try {
          const marketStub: NormalizedMarket = {
            marketId: pos.marketId,
            ticker: pos.marketId,
            question: "",
            expiryTs: Date.now()
          };
          const st = await adapter.getMarketState(marketStub);
          if (!st.resolved || !st.winningSide) continue;

          const won = st.winningSide === pos.side;
          const payoutUsd = won ? pos.shares : 0;
          const feesUsd = Number(pos.feesUsd ?? 0);
          const pnlUsd = payoutUsd - pos.costUsd - feesUsd;
          resolvePosition(pos.positionRowId, {
            outcome: won ? "WIN" : "LOSS",
            payoutUsd,
            pnlUsd,
            feesUsd,
            resolvedTs: Date.now()
          });

          if (won) ladder.onResolvedOutcome("WIN");
          else ladder.onResolvedOutcome("LOSS");
          state.maxUsdPerTrade = Math.min(ladder.getCurrentSizeUsd(), runtimeCfg.maxUsdPerTrade);

          const meta = positionDecisionMeta.get(pos.positionRowId);
          learner.recordResolved({
            positionId: pos.positionRowId,
            marketId: pos.marketId,
            outcome: won ? "WIN" : "LOSS",
            pnlUsd,
            edge: meta?.edge,
            fillProb: meta?.fillProb,
            qualityScore: meta?.qualityScore,
            driftMsEstimate
          });

          openPositions.splice(i, 1);
          positionDecisionMeta.delete(pos.positionRowId);
          resolutionBackoffUntil.delete(pos.marketId);
          await notifier.notify(`market resolved ${won ? "WIN" : "LOSS"} for ${pos.marketId}`);
        } catch (err) {
          const msg = (err as Error).message ?? "";
          if (/too many requests|http 429/i.test(msg)) {
            resolutionBackoffUntil.set(pos.marketId, Date.now() + 30_000);
          }
          logger.debug("position resolution check skipped", { marketId: pos.marketId, error: msg });
        }
      }

      ladder.evaluateWindowStep();
      state.maxUsdPerTrade = Math.min(ladder.getCurrentSizeUsd(), runtimeCfg.maxUsdPerTrade);

      const canTrade = riskManager.canOpenNewPosition();
      if (canTrade.ok) {
        state.blockedReason = null;
        state.blockedSinceTs = null;
        const markets = await adapter.listCandidateMarkets();
        const effectiveNow = Date.now() - (driftMsEstimate ?? 0);
        const dailyPnl = getStats({
          dryRun: trader.getDryRun(),
          stopNewTrades: state.stopNewTrades,
          currentTradeSizeUsd: state.maxUsdPerTrade
        }).todayPnl;

        const candidates: Candidate[] = [];
        const historicalFillRate = getHistoricalFillRateNearTarget(runtimeCfg.targetPrice);
        const cryptoFillRate = getHistoricalFillRateForMarketType("CRYPTO");
        const weatherFillRate = getHistoricalFillRateForMarketType("WEATHER");
        const exposure = await buildExposureState(openPositions, adapter);

        const scanWindowSec = Math.max(runtimeCfg.timeWindowSec * 20, 300);
        const scanPool = markets
          .filter((market) => matchesMarketFocus(runtimeCfg.marketFocus, market))
          .filter((market) => {
            const tteSec = (market.expiryTs - effectiveNow) / 1000;
            return tteSec > 0 && tteSec <= scanWindowSec;
          })
          .sort((a, b) => a.expiryTs - b.expiryTs)
          .slice(0, 40);

        for (const market of scanPool) {
          try {
            const tteSec = (market.expiryTs - effectiveNow) / 1000;

          const obStart = Date.now();
          const orderbook = await adapter.getOrderbook(market);
          insertPerfMetric("orderbook_fetch_ms", Date.now() - obStart, { marketId: market.marketId });

          insertMarketSnapshot({
            marketId: market.marketId,
            ticker: market.ticker,
            question: market.question,
            eventTitle: market.eventTitle,
            marketTitle: market.marketTitle,
            category: market.category,
            status: market.status,
            volume: market.volume,
            expiryTs: market.expiryTs,
            bestYes: orderbook.bestAskYes,
            bestNo: orderbook.bestAskNo,
            liquidityYes: orderbook.liquidityYesShares,
            liquidityNo: orderbook.liquidityNoShares,
            raw: { adapter: runtimeCfg.adapter }
          });

          const rules = await adapter.parseRules(market);
          const referenceValue = feed.getReferenceValue(market);
          if (Number.isFinite(referenceValue) && /\\bbtc\\b|bitcoin/i.test(market.question)) {
            intel.updateCryptoTick("BTC", referenceValue as number);
          }
          const action = strategy.decide({
            market,
            orderbook,
            rules,
            referenceValue,
            stopNewTrades: state.stopNewTrades,
            openPositionsCount: openPositions.length,
            maxOpenPositions: runtimeCfg.maxOpenPositions,
            dailyPnlUsd: dailyPnl,
            dailyLossLimitUsd: runtimeCfg.dailyLossLimitUsd,
            maxUsdPerTrade: state.maxUsdPerTrade,
            targetPrice: runtimeCfg.targetPrice,
            exactPriceOnly: runtimeCfg.exactPriceOnly,
            nowTs: effectiveNow,
            slippageBuffer: runtimeCfg.slippageBuffer,
            timeWindowSec: runtimeCfg.timeWindowSec,
            externalBufferUsd: config.externalBufferUsd
          });

          const sideForIntel: "YES" | "NO" = action.side ?? (orderbook.bestAskYes <= orderbook.bestAskNo ? "YES" : "NO");
          const sizeForIntel = action.sizeUsd ?? state.maxUsdPerTrade;
          const preParsed = classifyMarket(market.question, market.expiryTs);
          const typeFillRate = preParsed.marketType.startsWith("CRYPTO")
            ? cryptoFillRate
            : preParsed.marketType.startsWith("WEATHER")
              ? weatherFillRate
              : historicalFillRate;

          const intelResult = await intel.evaluate({
            market,
            orderbook,
            rules,
            side: sideForIntel,
            sizeUsd: sizeForIntel,
            targetPrice: runtimeCfg.targetPrice,
            timeToCloseSec: tteSec,
            recentFillRate: typeFillRate,
            feeRate: runtimeCfg.feeRate,
            minEdge: runtimeCfg.minEdge,
            minFillProb: runtimeCfg.minFillProb,
            minQualityScore: runtimeCfg.minQualityScore
          });

          const strategyPass = action.action === "BUY" && !!action.side && !!action.price && !!action.sizeUsd;
          let exposurePass = true;
          const parsed = intelResult.parsed;
          const projectedTotal = exposure.total + sizeForIntel;
          if (projectedTotal > runtimeCfg.maxTotalExposureUsd) exposurePass = false;
          if (parsed.underlying) {
            const projected = (exposure.bySymbol[parsed.underlying] ?? 0) + sizeForIntel;
            if (projected > runtimeCfg.maxPerSymbolExposureUsd) exposurePass = false;
          }
          if (parsed.location) {
            const projected = (exposure.byLocation[parsed.location] ?? 0) + sizeForIntel;
            if (projected > runtimeCfg.maxPerLocationExposureUsd) exposurePass = false;
          }
          if (runtimeCfg.correlationGuard && parsed.marketType.startsWith("CRYPTO")) {
            const hasCorrelated = Object.values(exposure.parsedByMarket).some(
              (p) =>
                p.marketType.startsWith("CRYPTO") &&
                p.underlying === parsed.underlying &&
                Math.abs((p.windowEndTs ?? 0) - (parsed.windowEndTs ?? 0)) <= 30 * 60 * 1000
            );
            if (hasCorrelated) exposurePass = false;
          }

          const priceOnlyMode = runtimeCfg.strategy === "NearExpiryPriceOnly" || runtimeCfg.strategy === "HourlyPriceOnly";
          const shouldTrade = strategyPass && exposurePass && (priceOnlyMode || intelResult.tradeable);
          const calibratedScore = predictCalibratedWinProb({
            edge: intelResult.edge,
            quality: intelResult.quality.score,
            fillProb: intelResult.fillProb,
            confidence: intelResult.confidence,
            pModel: intelResult.pModel ?? intelResult.impliedPrice,
            impliedPrice: intelResult.impliedPrice,
            expectedCost: intelResult.expectedCost
          });
          const profileSet = learner.getProfileSet(getRuntimeBotConfig());
          let championDecisionId = 0;
          for (const profile of profileSet) {
            const profileStrategyPass = strategyPass && tteSec <= profile.params.timeWindowSec;
            const profileGatePass =
              intelResult.edge >= profile.params.minEdge &&
              intelResult.fillProb >= profile.params.minFillProb &&
              intelResult.quality.score >= profile.params.minQualityScore;
            const profileShouldTrade = profileStrategyPass && exposurePass && (priceOnlyMode || profileGatePass);
            const dId = learner.logDecision({
              profile: profile.name,
              isChampion: profile.champion,
              marketId: market.marketId,
              side: action.side,
              action: profileShouldTrade ? "BUY" : "NOOP",
              reason: `strategy=${action.reason}; edge=${intelResult.edge.toFixed(4)} fill=${intelResult.fillProb.toFixed(3)} q=${intelResult.quality.score.toFixed(1)} exposure=${exposurePass}`,
              tteSec,
              price: action.price,
              sizeUsd: action.sizeUsd,
              qualityScore: intelResult.quality.score,
              edge: intelResult.edge,
              fillProb: intelResult.fillProb,
              expectedCost: intelResult.expectedCost,
              impliedPrice: intelResult.impliedPrice,
              pModel: intelResult.pModel,
              config: profile.params,
              raw: {
                strategyPass,
                profileStrategyPass,
                profileGatePass,
                exposurePass
              }
            });
            if (profile.champion) championDecisionId = dId;
          }

          insertMarketIntelligence({
            marketId: market.marketId,
            side: sideForIntel,
            marketType: parsed.marketType,
            underlying: parsed.underlying,
            location: parsed.location,
            qualityScore: intelResult.quality.score,
            qualityReasons: intelResult.quality.reasons,
            pModel: intelResult.pModel ?? intelResult.impliedPrice,
            confidence: intelResult.confidence,
            impliedPrice: intelResult.impliedPrice,
            fillProb: intelResult.fillProb,
            expectedCost: intelResult.expectedCost,
            edge: intelResult.edge,
            evPerTrade: intelResult.edge,
            decision: shouldTrade ? "TRADE" : "SKIP",
            reasons: [
              `strategy=${action.reason}`,
              `calibratedWinProb=${calibratedScore.toFixed(3)}`,
              ...intelResult.reasons,
              exposurePass ? "exposure ok" : "exposure/correlation guard blocked"
            ],
            raw: {
              side: sideForIntel,
              tteSec,
              strategyPass,
              exposurePass,
              parsed,
              calibratedWinProb: calibratedScore,
              modelInputs: intelResult.modelInputs,
              weatherSnapshot: intelResult.weatherSnapshot
            }
          });

            if (!shouldTrade || !action.side || !action.price || !action.sizeUsd || championDecisionId <= 0) continue;

            const sharesNeeded = action.sizeUsd / action.price;
            const requiredShares = sharesNeeded * (1 + runtimeCfg.slippageBuffer);
            const available = action.side === "YES" ? orderbook.liquidityYesShares : orderbook.liquidityNoShares;
            if (available < requiredShares) continue;

            candidates.push({
              decisionId: championDecisionId,
              market,
              side: action.side,
              price: action.price,
              sizeUsd: action.sizeUsd,
              askSize: available,
              tteSec,
              liquidityAtTarget: available,
              spreadHint: orderbook.spreadHint ?? 0,
              reason: `${action.reason}; edge=${intelResult.edge.toFixed(4)}; fillProb=${intelResult.fillProb.toFixed(3)}; q=${intelResult.quality.score.toFixed(1)}`,
              edge: intelResult.edge,
              fillProb: intelResult.fillProb,
              qualityScore: intelResult.quality.score,
              calibratedScore
            });
          } catch (err) {
            logger.debug("Market scan skipped", { marketId: market.marketId, error: (err as Error).message });
          }
        }

        const selected = rankCandidates(candidates).slice(0, Math.max(1, runtimeCfg.topCandidatesPerTick));
        if (selected.length > 0) {
          lastOpportunityTs = Date.now();
          lastNoOpportunityAlertTs = 0;
        } else {
          const nowTs = Date.now();
          const thresholdMs = 30 * 60 * 1000;
          if (nowTs - lastOpportunityTs >= thresholdMs && nowTs - lastNoOpportunityAlertTs >= thresholdMs) {
            await notifier.notify(`Alert: no trade opportunities for ${Math.round((nowTs - lastOpportunityTs) / 60000)}m`);
            lastNoOpportunityAlertTs = nowTs;
          }
        }

        for (const c of selected) {
          const detectTs = Date.now();
          await notifier.notify(
            `Opportunity detected market=${c.market.marketId} side=${c.side} tte=${c.tteSec.toFixed(1)}s ${c.reason}`
          );

          const submitStartTs = Date.now();
          await notifier.notify(`Order submitted market=${c.market.marketId} side=${c.side} price=${c.price.toFixed(2)} usd=${c.sizeUsd.toFixed(2)}`);
          const result = await trader.attemptEntry({
            marketId: c.market.marketId,
            question: c.market.question,
            side: c.side,
            price: c.price,
            sizeUsd: c.sizeUsd,
            askSize: c.askSize,
            timeToExpirySec: c.tteSec
          });
          learner.bindExecution(c.decisionId, result.orderRowId, result.positionRowId);

          const detectToSubmitMs = Number.isFinite(result.submitMs)
            ? submitStartTs - detectTs + Number(result.submitMs)
            : Date.now() - detectTs;
          insertPerfMetric("candidate_to_order_submit_ms", detectToSubmitMs, { marketId: c.market.marketId, side: c.side });
          if (Number.isFinite(result.submitMs)) insertPerfMetric("order_submit_ms", Number(result.submitMs), { marketId: c.market.marketId, side: c.side });
          if (Number.isFinite(result.cancelMs)) insertPerfMetric("cancel_latency_ms", Number(result.cancelMs), { marketId: c.market.marketId, side: c.side });

          if (result.filled && result.positionRowId) {
            openPositions.push({
              positionRowId: result.positionRowId,
              marketId: c.market.marketId,
              side: c.side,
              shares: result.shares,
              avgPrice: result.avgPrice,
              costUsd: c.sizeUsd,
              feesUsd: Number(result.feeUsd ?? 0)
            });
            positionDecisionMeta.set(result.positionRowId, {
              edge: c.edge,
              fillProb: c.fillProb,
              qualityScore: c.qualityScore
            });
            await notifier.notify(`order filled market=${c.market.marketId} side=${c.side}`);
          } else {
            await notifier.notify(`order cancelled market=${c.market.marketId} side=${c.side}`);
          }
        }
      } else {
        const nowTs = Date.now();
        if (state.blockedReason !== canTrade.reason) {
          state.blockedReason = canTrade.reason ?? "unknown";
          state.blockedSinceTs = nowTs;
          lastBlockedAlertTs = 0;
        }
        const blockedForMs = state.blockedSinceTs != null ? nowTs - state.blockedSinceTs : 0;
        const alertEveryMs = 5 * 60 * 1000;
        if (blockedForMs >= alertEveryMs && nowTs - lastBlockedAlertTs >= alertEveryMs) {
          await notifier.notify(`Risk gate stuck ${Math.round(blockedForMs / 60000)}m: ${state.blockedReason}`);
          lastBlockedAlertTs = nowTs;
        }
        logger.debug("Skipping scan due to risk gate", { reason: canTrade.reason });
      }

      const day = new Date().getUTCDate();
      if (day !== lastDailySummaryDay) {
        const stats = getStats({
          dryRun: trader.getDryRun(),
          stopNewTrades: state.stopNewTrades,
          currentTradeSizeUsd: state.maxUsdPerTrade
        });
        await notifier.notify(
          `daily summary trades=${stats.totalTrades}, winRate=${(stats.winRate * 100).toFixed(1)}%, pnl=${stats.todayPnl.toFixed(2)}, sizeUsd=${state.maxUsdPerTrade.toFixed(2)}`
        );
        lastDailySummaryDay = day;
      }
      tickSucceeded = true;
    } catch (err) {
      consecutiveLoopErrors += 1;
      const message = (err as Error).message;
      logger.error("Main loop error", { error: message, consecutiveLoopErrors });
      if (/too many requests|http 429/i.test(message)) {
        await sleep(1500);
      }
      if (consecutiveLoopErrors >= 5) {
        const now = Date.now();
        if (now - lastErrorAlertTs >= 5 * 60 * 1000) {
          await notifier.notify(`Critical: repeated main loop errors (${consecutiveLoopErrors}) latest=${message}`);
          lastErrorAlertTs = now;
        }
      }
      if (consecutiveLoopErrors >= 5) {
        await sleep(Math.min(5000, 250 * consecutiveLoopErrors));
      }
    }
    if (tickSucceeded && consecutiveLoopErrors > 0) consecutiveLoopErrors = 0;

    insertPerfMetric("scan_loop_ms", Date.now() - loopStart, { adapter: runtimeCfg.adapter, strategy: runtimeCfg.strategy });
    await sleep(config.scanIntervalMs);
  }
}

void run();
