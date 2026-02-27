import { Router } from "express";
import {
  type TradesFilter,
  getExecutionReport,
  getMarketSamples,
  getMarketIntelligenceDetails,
  getOrdersForCsv,
  getPerfSummary,
  getPositions,
  getPositionsForCsv,
  getPnlRangeRows,
  getRecentOrders,
  getUnresolvedPositionDetails,
  getScanSummary,
  getStats,
  getManualOpportunities,
  getHistoricalFillRateNearTarget,
  getTopIntelligence,
  getTopIntelligenceByType,
  getLearningProfileMetrics,
  getRecentPromotionEvents,
  getTopAttributionCauses,
  getTradesForCsv,
  getTradesPage
} from "../db/queries";
import { sendOpenClawTestMessage } from "../notify/notifier";
import { kalshiAuthCheck, resetKalshiHttpClient, getKalshiHttpClient } from "../kalshi/client";
import { getRuntimeBotConfig, setRuntimeBotConfig, type RuntimeBotConfig } from "../settings/runtimeConfig";
import { deleteSecret, getSecretMask, setSecret } from "../settings/secureStore";
import { getSetting, setSetting } from "../settings/settingsStore";
import { validatePemLike } from "../kalshi/auth";
import { buildAdapter, buildDataFeed, buildStrategy } from "../plugins/factory";
import { MarketIntelligenceLayer } from "../intel/intelEngine";
import { KalshiTrader } from "../kalshi/trader";
import { clearRuntimeData } from "../db/db";
import { getFeatureCalibrationSettings, predictCalibratedWinProb } from "../learning/featureCalibration";

export type DashboardControlDeps = {
  getDryRun: () => boolean;
  setDryRun: (value: boolean) => void;
  allowDryRunToggle: boolean;
  dashboardAllowControl: boolean;
  getStopNewTrades: () => boolean;
  setStopNewTrades: (value: boolean) => void;
  getMaxUsdPerTrade: () => number;
  setMaxUsdPerTrade: (value: number) => void;
  onControlTriggered: (message: string, json?: Record<string, unknown>) => void;
  toCsv: (rows: Record<string, unknown>[]) => string;
  getLiveTrading: () => boolean;
  getDriftMsEstimate: () => number | null;
  getBlockedReason: () => string | null;
  getBlockedForMs: () => number | null;
};

function parseTradesFilters(query: Record<string, unknown>): TradesFilter {
  const now = Date.now();
  const range = typeof query.range === "string" ? query.range : "today";
  let fromTs: number | undefined;
  let toTs: number | undefined = now;

  if (range === "today") {
    const d = new Date();
    fromTs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  } else if (range === "7d") {
    fromTs = now - 7 * 24 * 60 * 60 * 1000;
  } else if (range === "30d") {
    fromTs = now - 30 * 24 * 60 * 60 * 1000;
  } else if (range === "custom") {
    if (typeof query.from === "string" && query.from) fromTs = Number(query.from);
    if (typeof query.to === "string" && query.to) toTs = Number(query.to);
  }

  const sortBy: TradesFilter["sortBy"] =
    query.sort_by === "price" || query.sort_by === "size_shares" || query.sort_by === "status" || query.sort_by === "ts"
      ? query.sort_by
      : "ts";
  const sortDir: TradesFilter["sortDir"] = query.sort_dir === "asc" || query.sort_dir === "desc" ? query.sort_dir : "desc";

  return {
    fromTs,
    toTs,
    status: typeof query.status === "string" && query.status ? query.status : undefined,
    side: typeof query.side === "string" && query.side ? query.side : undefined,
    minPrice: typeof query.min_price === "string" && query.min_price ? Number(query.min_price) : undefined,
    maxPrice: typeof query.max_price === "string" && query.max_price ? Number(query.max_price) : undefined,
    search: typeof query.search === "string" ? query.search : undefined,
    sortBy,
    sortDir,
    page: typeof query.page === "string" ? Number(query.page) : 1,
    pageSize: typeof query.page_size === "string" ? Number(query.page_size) : 25
  };
}

function parseBool(v: unknown, fallback = false): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return ["1", "true", "yes", "on"].includes(v.toLowerCase());
  return fallback;
}

function finiteOr(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function buildBrowseFailReasons(error: unknown): string[] {
  const raw = error instanceof Error ? error.message : String(error ?? "evaluation failed");
  const msg = raw.toLowerCase();
  if (msg.includes("too many requests") || msg.includes("429")) return ["rate limited by API", "retry shortly"];
  if (msg.includes("authentication_error") || msg.includes("401") || msg.includes("403")) return ["authentication failed", "check kalshi credentials"];
  if (msg.includes("404")) return ["market not found on endpoint", "stale or delisted market"];
  if (msg.includes("fetch failed") || msg.includes("network")) return ["network/API fetch failed", "check connectivity"];
  return ["could not evaluate market", "missing market or orderbook data"];
}

function toBrowseScore(intel: {
  edge: number;
  quality: number;
  fillProb: number;
  confidence: number;
  pModel: number;
  impliedPrice: number;
  expectedCost: number;
}): number {
  const p = predictCalibratedWinProb({
    edge: intel.edge,
    quality: intel.quality,
    fillProb: intel.fillProb,
    confidence: intel.confidence,
    pModel: intel.pModel,
    impliedPrice: intel.impliedPrice,
    expectedCost: intel.expectedCost
  });
  return Math.round(Math.max(0, Math.min(1, p)) * 100);
}

function toRiskLevel(input: { score: number; edge: number; fillProb: number; quality: number }): "LOW" | "MEDIUM" | "HIGH" {
  if (input.score >= 70 && input.edge >= 0.03 && input.fillProb >= 0.6 && input.quality >= 70) return "LOW";
  if (input.score >= 45 && input.edge >= 0.01 && input.fillProb >= 0.35 && input.quality >= 45) return "MEDIUM";
  return "HIGH";
}

export function buildApiRouter(deps: DashboardControlDeps): Router {
  const router = Router();
  const runtimeKeys: Array<keyof RuntimeBotConfig> = [
    "adapter",
    "strategy",
    "marketFocus",
    "timeWindowSec",
    "targetPrice",
    "targetPriceCents",
    "exactPriceOnly",
    "maxUsdPerTrade",
    "maxOrderNotionalUsd",
    "duplicateCooldownSec",
    "maxOrdersPerDay",
    "liveArmTimeoutMin",
    "dailyLossLimitUsd",
    "maxOpenPositions",
    "topCandidatesPerTick",
    "slippageBuffer",
    "minQualityScore",
    "minEdge",
    "minFillProb",
    "notificationsEnabled",
    "openclawSendMode",
    "openclawBinaryPath",
    "openclawTelegramTarget",
    "kalshiEnv",
    "kalshiApiBaseUrl",
    "extraKalshiKeyId",
    "weatherProvider",
    "weatherProviderEndpoint",
    "weatherProviderApiKey",
    "sportsProvider",
    "sportsProviderEndpoint",
    "weatherEnable",
    "maxTotalExposureUsd",
    "maxPerSymbolExposureUsd",
    "maxPerLocationExposureUsd",
    "correlationGuard",
    "feeRate",
    "liveEnabled"
  ];

  function matchesFocus(
    focus: "crypto_weather" | "all" | "hourly",
    market: {
      category?: string;
      eventTitle?: string;
      marketTitle?: string;
      question?: string;
      ticker?: string;
      expiryTs?: number;
    }
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

  async function mapWithLimit<T, R>(items: T[], concurrency: number, fn: (item: T, idx: number) => Promise<R>): Promise<R[]> {
    const out = new Array<R>(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const idx = cursor;
        cursor += 1;
        if (idx >= items.length) return;
        out[idx] = await fn(items[idx], idx);
      }
    });
    await Promise.all(workers);
    return out;
  }

  async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
    let timer: NodeJS.Timeout | null = null;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    try {
      const result = await Promise.race([promise, timeout]);
      return result as T | null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  router.get("/stats", (_req, res) => {
    const stats = getStats({
      dryRun: deps.getDryRun(),
      stopNewTrades: deps.getStopNewTrades(),
      currentTradeSizeUsd: deps.getMaxUsdPerTrade()
    });
    const ranges = getPnlRangeRows();
    const byLabel = Object.fromEntries(ranges.map((r) => [r.label, r]));
    (stats as Record<string, unknown>).pnlToday = byLabel.today?.realizedPnl ?? 0;
    (stats as Record<string, unknown>).pnlWeek = byLabel.week?.realizedPnl ?? 0;
    (stats as Record<string, unknown>).pnlMonth = byLabel.month?.realizedPnl ?? 0;
    (stats as Record<string, unknown>).pnlYear = byLabel.year?.realizedPnl ?? 0;
    stats.liveTradingActive = deps.getLiveTrading() && !deps.getDryRun();
    const drift = deps.getDriftMsEstimate();
    stats.driftMsEstimate = drift ?? undefined;
    stats.driftWarning = drift != null && Math.abs(drift) > 250;
    const blockedReason = deps.getBlockedReason();
    (stats as Record<string, unknown>).blockedReason = blockedReason;
    (stats as Record<string, unknown>).blockedForMs = blockedReason ? deps.getBlockedForMs() : null;
    (stats as Record<string, unknown>).learningActiveProfile = String(getSetting("learning.active_profile", "champion") ?? "champion");
    res.json(stats);
  });

  router.get("/account", async (_req, res) => {
    try {
      const client = getKalshiHttpClient();
      const row = await client.get("/trade-api/v2/portfolio/balance", undefined, true);
      const raw = row?.data ?? row;
      const cents = (v: unknown): number | null => {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };
      const balanceCents = cents(raw?.balance ?? raw?.balance_cents ?? raw?.portfolio_balance);
      const availableCents = cents(
        raw?.available_balance ?? raw?.available_balance_cents ?? raw?.cash_available ?? raw?.withdrawable_balance
      );
      res.json({
        ok: true,
        currency: "USD",
        balanceUsd: balanceCents != null ? balanceCents / 100 : null,
        availableUsd: availableCents != null ? availableCents / 100 : null
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  router.get("/pnl/ranges", (_req, res) => {
    res.json({ ok: true, rows: getPnlRangeRows() });
  });

  router.get("/open-positions-live", async (_req, res) => {
    try {
      const cfg = getRuntimeBotConfig();
      const adapter = buildAdapter(cfg.adapter);
      const rows = getUnresolvedPositionDetails();
      const items = await mapWithLimit(rows, 8, async (p) => {
        try {
          const market = adapter.getMarketByTicker
            ? await adapter.getMarketByTicker(p.market_id)
            : { marketId: p.market_id, ticker: p.market_id, question: "", expiryTs: Date.now() };
          const ob = await adapter.getOrderbook(
            market ?? { marketId: p.market_id, ticker: p.market_id, question: "", expiryTs: Date.now() }
          );
          const bestBidYes = Number(ob.levels?.bestBidYes ?? NaN);
          const bestBidNo = Number(ob.levels?.bestBidNo ?? NaN);
          const fallbackAsk = p.side === "YES" ? Number(ob.bestAskYes ?? NaN) : Number(ob.bestAskNo ?? NaN);
          const mark =
            p.side === "YES"
              ? (Number.isFinite(bestBidYes) && bestBidYes > 0 ? bestBidYes : fallbackAsk)
              : (Number.isFinite(bestBidNo) && bestBidNo > 0 ? bestBidNo : fallbackAsk);
          const currentValueUsd = Number.isFinite(mark) ? p.shares * mark : null;
          const feesUsd = Number(p.fees_usd ?? 0);
          const unrealizedPnlUsd = currentValueUsd != null ? currentValueUsd - p.cost_usd - feesUsd : null;
          const expiryTs = Number(market?.expiryTs ?? NaN);
          return {
            id: p.id,
            marketId: p.market_id,
            side: p.side,
            shares: p.shares,
            avgPrice: p.avg_price,
            costUsd: p.cost_usd,
            feesUsd,
            markPrice: Number.isFinite(mark) ? mark : null,
            currentValueUsd,
            unrealizedPnlUsd,
            openedTs: p.ts_open,
            expiryTs: Number.isFinite(expiryTs) ? expiryTs : null,
            tteSec: Number.isFinite(expiryTs) ? (expiryTs - Date.now()) / 1000 : null
          };
        } catch {
          return {
            id: p.id,
            marketId: p.market_id,
            side: p.side,
            shares: p.shares,
            avgPrice: p.avg_price,
            costUsd: p.cost_usd,
            feesUsd: Number(p.fees_usd ?? 0),
            markPrice: null,
            currentValueUsd: null,
            unrealizedPnlUsd: null,
            openedTs: p.ts_open,
            expiryTs: null,
            tteSec: null
          };
        }
      });
      const totalCostUsd = items.reduce((a, b) => a + Number(b.costUsd ?? 0), 0);
      const totalCurrentValueUsd = items.reduce((a, b) => a + Number(b.currentValueUsd ?? 0), 0);
      const totalUnrealizedPnlUsd = items.reduce((a, b) => a + Number(b.unrealizedPnlUsd ?? 0), 0);
      res.json({
        ok: true,
        count: items.length,
        totals: { totalCostUsd, totalCurrentValueUsd, totalUnrealizedPnlUsd },
        items
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  router.get("/perf", (req, res) => {
    const hours = Math.max(1, Math.min(168, Number(req.query.hours ?? 24)));
    res.json(getPerfSummary(hours));
  });

  router.get("/report", (_req, res) => {
    res.json(getExecutionReport());
  });

  router.get("/settings", (_req, res) => {
    const cfg = getRuntimeBotConfig();
    const liveConfirmCode = String(getSetting("live.confirm.code", "") ?? "");
    const liveArmedUntilTs = Number(getSetting("live.enabled.expires_at", 0) ?? 0);
    res.json({
      ok: true,
      settings: cfg,
      flags: { dryRun: deps.getDryRun(), liveTrading: deps.getLiveTrading() },
      liveConfirmCode,
      liveArmedUntilTs: Number.isFinite(liveArmedUntilTs) && liveArmedUntilTs > 0 ? liveArmedUntilTs : null
    });
  });

  router.post("/settings", (req, res) => {
    const body = (req.body ?? {}) as Partial<RuntimeBotConfig> & {
      dryRun?: boolean;
      liveEnable?: boolean;
      liveAcknowledge?: boolean;
      liveConfirmCode?: string;
    };

    if (body.openclawSendMode === "cli") {
      const target = String(body.openclawTelegramTarget ?? getRuntimeBotConfig().openclawTelegramTarget ?? "").trim();
      if (!target) {
        res.status(400).json({ ok: false, error: "OPENCLAW_TELEGRAM_TARGET is required when OPENCLAW_SEND_MODE=cli" });
        return;
      }
    }

    const runtimePatch: Partial<RuntimeBotConfig> = {};
    for (const k of runtimeKeys) {
      if (Object.prototype.hasOwnProperty.call(body, k)) {
        (runtimePatch as Record<string, unknown>)[k] = (body as Record<string, unknown>)[k];
      }
    }

    const next = setRuntimeBotConfig(runtimePatch);
    resetKalshiHttpClient();

    if (typeof body.dryRun === "boolean") deps.setDryRun(body.dryRun);

    if (body.liveEnable === true) {
      const code = String(getSetting("live.confirm.code", "") ?? "");
      const valid = body.liveAcknowledge === true && body.liveConfirmCode === code && deps.getDryRun() === false;
      if (!valid) {
        res.status(400).json({ ok: false, error: "LIVE gate failed", expectedCode: code });
        return;
      }
      const armedAt = Date.now();
      const armedUntil = armedAt + Math.max(1, next.liveArmTimeoutMin) * 60 * 1000;
      setSetting("live.enabled", true);
      setSetting("live.enabled.at", armedAt);
      setSetting("live.enabled.expires_at", armedUntil);
    }
    if (body.liveEnable === false) {
      setSetting("live.enabled", false);
      setSetting("live.enabled.expires_at", 0);
    }

    res.json({ ok: true, settings: next });
  });

  router.get("/secrets", async (_req, res) => {
    const pemMask = await getSecretMask("KALSHI_PRIVATE_KEY_PEM");
    res.json({ ok: true, secrets: { KALSHI_PRIVATE_KEY_PEM: pemMask } });
  });

  router.post("/secrets", async (req, res) => {
    const body = req.body as { name?: string; value?: string; action?: "set" | "delete" };
    const name = String(body?.name ?? "");
    if (!name) {
      res.status(400).json({ ok: false, error: "name required" });
      return;
    }

    if (body?.action === "delete") {
      await deleteSecret(name);
      res.json({ ok: true, mask: null });
      return;
    }

    const value = String(body?.value ?? "");
    if (!value.trim()) {
      res.status(400).json({ ok: false, error: "value required" });
      return;
    }

    if (name === "KALSHI_PRIVATE_KEY_PEM" && !validatePemLike(value)) {
      res.status(400).json({ ok: false, error: "invalid PEM private key format" });
      return;
    }

    try {
      await setSecret(name, value);
      res.json({ ok: true, mask: `••••${value.slice(-6)}` });
    } catch (err) {
      res.status(400).json({
        ok: false,
        error:
          (err as Error).message ||
          "Failed to save secret. If keychain is unavailable, set LOCAL_MASTER_KEY in .env and restart."
      });
    }
  });

  router.post("/setup/openclaw/test", async (_req, res) => {
    const cfg = getRuntimeBotConfig();
    if (cfg.openclawSendMode !== "cli") {
      res.status(400).json({ ok: false, error: "OpenClaw send mode is disabled" });
      return;
    }
    if (!cfg.openclawTelegramTarget.trim()) {
      res.status(400).json({ ok: false, error: "OPENCLAW_TELEGRAM_TARGET is required" });
      return;
    }

    const result = await sendOpenClawTestMessage(
      cfg.openclawBinaryPath || "openclaw",
      cfg.openclawTelegramTarget.trim(),
      "Bot dashboard connected"
    );
    if (!result.ok) {
      res.status(500).json({ ok: false, error: result.error ?? "send failed" });
      return;
    }
    res.json({ ok: true });
  });

  router.post("/setup/kalshi/test", async (_req, res) => {
    const start = Date.now();
    try {
      const summary = await kalshiAuthCheck();
      res.json({ ...summary, latencyMs: Date.now() - start });
    } catch (err) {
      const cfg = getRuntimeBotConfig();
      res.status(500).json({
        ok: false,
        error: (err as Error).message,
        latencyMs: Date.now() - start,
        hint: "Verify KALSHI_ENV/base URL and matching Key ID + private key for that environment.",
        apiBase: cfg.kalshiApiBaseUrl
      });
    }
  });

  router.post("/setup/kalshi/market-data-test", async (_req, res) => {
    const start = Date.now();
    try {
      const client = getKalshiHttpClient();
      const r = await client.get("/trade-api/v2/markets", { limit: 5 }, false);
      const markets = Array.isArray(r?.markets) ? r.markets.length : Array.isArray(r?.data?.markets) ? r.data.markets.length : 0;
      res.json({ ok: true, markets, latencyMs: Date.now() - start });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message, latencyMs: Date.now() - start });
    }
  });

  router.get("/scan-test", async (_req, res) => {
    const cfg = getRuntimeBotConfig();
    const adapter = buildAdapter(cfg.adapter);
    const strategy = buildStrategy(cfg.strategy);
    const feed = buildDataFeed({
      adapter: cfg.adapter,
      strategy: cfg.strategy,
      btcPriceFeedMode: "coinbase_ws"
    });
    feed.start();

    try {
      const markets = await adapter.listCandidateMarkets();
      const now = Date.now();
      const stats = getStats({
        dryRun: deps.getDryRun(),
        stopNewTrades: deps.getStopNewTrades(),
        currentTradeSizeUsd: deps.getMaxUsdPerTrade()
      });

      const results: Array<Record<string, unknown>> = [];
      for (const m of markets.slice(0, 20)) {
        const ob = await adapter.getOrderbook(m);
        const rules = await adapter.parseRules(m);
        const action = strategy.decide({
          market: m,
          orderbook: ob,
          rules,
          referenceValue: feed.getReferenceValue(m),
          stopNewTrades: deps.getStopNewTrades(),
          openPositionsCount: 0,
          maxOpenPositions: cfg.maxOpenPositions,
          dailyPnlUsd: stats.todayPnl,
          dailyLossLimitUsd: cfg.dailyLossLimitUsd,
          maxUsdPerTrade: cfg.maxUsdPerTrade,
          targetPrice: cfg.targetPrice,
          exactPriceOnly: cfg.exactPriceOnly,
          nowTs: now,
          slippageBuffer: cfg.slippageBuffer,
          timeWindowSec: cfg.timeWindowSec,
          externalBufferUsd: 25
        });

        results.push({
          marketId: m.marketId,
          question: m.question,
          expiryTs: m.expiryTs,
          bestAskYes: ob.bestAskYes,
          bestAskNo: ob.bestAskNo,
          action: action.action,
          side: action.side,
          price: action.price,
          reason: action.reason
        });
      }

      res.json({ ok: true, adapter: cfg.adapter, strategy: cfg.strategy, candidates: results.slice(0, 10) });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    } finally {
      feed.stop();
    }
  });

  router.get("/intelligence/top", (req, res) => {
    const limit = Math.max(1, Math.min(100, Number(req.query.limit ?? 25)));
    res.json({ ok: true, items: getTopIntelligence(limit) });
  });

  router.get("/learning/status", (_req, res) => {
    const featureCalibration = getFeatureCalibrationSettings();
    res.json({
      ok: true,
      activeProfile: String(getSetting("learning.active_profile", "champion") ?? "champion"),
      metrics: getLearningProfileMetrics(7 * 24),
      topAttributionCauses: getTopAttributionCauses(10),
      recentPromotions: getRecentPromotionEvents(20),
      featureCalibration
    });
  });

  router.get("/intelligence/market/:ticker", (req, res) => {
    const ticker = String(req.params.ticker ?? "");
    res.json({ ok: true, items: getMarketIntelligenceDetails(ticker) });
  });

  router.get("/intel/crypto", (req, res) => {
    const limit = Math.max(1, Math.min(100, Number(req.query.limit ?? 25)));
    res.json({ ok: true, items: getTopIntelligenceByType("CRYPTO", limit) });
  });

  router.get("/intel/weather", (req, res) => {
    const limit = Math.max(1, Math.min(100, Number(req.query.limit ?? 25)));
    res.json({ ok: true, items: getTopIntelligenceByType("WEATHER", limit) });
  });

  router.get("/browse/markets", async (req, res) => {
    let feed: ReturnType<typeof buildDataFeed> | null = null;
    try {
      const cfg = getRuntimeBotConfig();
      const adapter = buildAdapter(cfg.adapter);
      const strategy = buildStrategy(cfg.strategy);
      feed = buildDataFeed({
        adapter: cfg.adapter,
        strategy: cfg.strategy,
        btcPriceFeedMode: "coinbase_ws"
      });
      const intel = new MarketIntelligenceLayer({ weatherEnabled: cfg.weatherEnable });
      feed.start();
      const limit = Math.max(1, Math.min(200, Number(req.query.limit ?? 80)));
      const focusRaw = String(req.query.focus ?? cfg.marketFocus ?? "all");
      const focus: "all" | "crypto_weather" | "hourly" =
        focusRaw === "all" || focusRaw === "hourly" || focusRaw === "crypto_weather"
          ? (focusRaw as "all" | "crypto_weather" | "hourly")
          : "all";
      const filters = {
        status: typeof req.query.status === "string" ? req.query.status : "open",
        category: typeof req.query.category === "string" ? req.query.category : undefined,
        search: typeof req.query.search === "string" ? req.query.search : undefined,
        closeWithinSec: Number.isFinite(Number(req.query.closeWithinSec)) ? Number(req.query.closeWithinSec) : undefined,
        minVolume: Number.isFinite(Number(req.query.minVolume)) ? Number(req.query.minVolume) : undefined
      };
      const markets = await adapter.listMarkets(filters);
      const focused = markets.filter((m) => matchesFocus(focus, m));
      const selected = focused.slice(0, Math.min(limit, 60));
      const enrichCount = Math.min(selected.length, 12);
      const enrichSlice = selected.slice(0, enrichCount);
      const baseSlice = selected.slice(enrichCount);

      const enrichedHead = await mapWithLimit(enrichSlice, 3, async (m) => {
        try {
          const evaluated = await withTimeout(
            (async () => {
          const ob = await adapter.getOrderbook(m);
          const rules = await adapter.parseRules(m);
          const nowTs = Date.now();
          const tteSec = (Number(m.expiryTs ?? 0) - nowTs) / 1000;
          const ref = feed!.getReferenceValue(m);
          const side: "YES" | "NO" = Number.isFinite(ob.bestAskYes) && Number.isFinite(ob.bestAskNo)
            ? ob.bestAskYes <= ob.bestAskNo ? "YES" : "NO"
            : Number.isFinite(ob.bestAskYes)
              ? "YES"
              : "NO";
          const action = strategy.decide({
            market: m,
            orderbook: ob,
            rules,
            referenceValue: ref,
            stopNewTrades: false,
            openPositionsCount: 0,
            maxOpenPositions: cfg.maxOpenPositions,
            dailyPnlUsd: 0,
            dailyLossLimitUsd: cfg.dailyLossLimitUsd,
            maxUsdPerTrade: cfg.maxUsdPerTrade,
            targetPrice: cfg.targetPrice,
            exactPriceOnly: cfg.exactPriceOnly,
            nowTs,
            slippageBuffer: cfg.slippageBuffer,
            timeWindowSec: cfg.timeWindowSec,
            externalBufferUsd: 25
          });
          const intelResult = await intel.evaluate({
            market: m,
            orderbook: ob,
            rules,
            side: action.side ?? side,
            sizeUsd: action.sizeUsd ?? cfg.maxUsdPerTrade,
            targetPrice: cfg.targetPrice,
            timeToCloseSec: tteSec,
            recentFillRate: getHistoricalFillRateNearTarget(cfg.targetPrice),
            feeRate: cfg.feeRate,
            minEdge: cfg.minEdge,
            minFillProb: cfg.minFillProb,
            minQualityScore: cfg.minQualityScore
          });
          const edge = finiteOr(intelResult.edge, 0);
          const quality = finiteOr(intelResult.quality?.score, 0);
          const fillProb = finiteOr(intelResult.fillProb, 0);
          const confidence = finiteOr(intelResult.confidence, 0);
          const implied = finiteOr(intelResult.impliedPrice, 0);
          const expectedCost = finiteOr(intelResult.expectedCost, 0);
          const pModel = finiteOr(intelResult.pModel, implied);
          const hitProb = Math.max(0, Math.min(1, pModel));
          const score100 = toBrowseScore({
            edge,
            quality,
            fillProb,
            confidence,
            pModel: hitProb,
            impliedPrice: implied,
            expectedCost
          });
          const riskLevel = toRiskLevel({
            score: finiteOr(score100, 0),
            edge,
            fillProb,
            quality
          });
          const scoreReasons = (intelResult.reasons ?? []).filter(Boolean).slice(0, 4);
          return {
            ...m,
            bestAskYes: Number.isFinite(ob.bestAskYes) ? ob.bestAskYes : null,
            bestAskNo: Number.isFinite(ob.bestAskNo) ? ob.bestAskNo : null,
            liquidityYesShares: Number.isFinite(ob.liquidityYesShares) ? ob.liquidityYesShares : null,
            liquidityNoShares: Number.isFinite(ob.liquidityNoShares) ? ob.liquidityNoShares : null,
            impliedYes: Number.isFinite(ob.bestAskYes) ? ob.bestAskYes : null,
            impliedNo: Number.isFinite(ob.bestAskNo) ? ob.bestAskNo : null,
            recommendedSide: action.side ?? side,
            hitProbability: hitProb,
            qualityScore: quality,
            fillProb,
            edge,
            score100: finiteOr(score100, 0),
            riskLevel,
            scoreReasons
          };
            })(),
            1800
          );
          if (evaluated) return evaluated;
          return {
            ...m,
            bestAskYes: null,
            bestAskNo: null,
            liquidityYesShares: null,
            liquidityNoShares: null,
            impliedYes: null,
            impliedNo: null,
            recommendedSide: null,
            hitProbability: 0.5,
            qualityScore: 20,
            fillProb: 0.2,
            edge: 0,
            score100: 20,
            riskLevel: "HIGH",
            scoreReasons: ["market data timeout", "showing base listing only"]
          };
        } catch (err) {
          return {
            ...m,
            bestAskYes: null,
            bestAskNo: null,
            liquidityYesShares: null,
            liquidityNoShares: null,
            impliedYes: null,
            impliedNo: null,
            recommendedSide: null,
            hitProbability: null,
            qualityScore: 0,
            fillProb: 0,
            edge: 0,
            score100: 0,
            riskLevel: "HIGH",
            scoreReasons: buildBrowseFailReasons(err)
          };
        }
      });

      const baseTail = baseSlice.map((m) => ({
        ...m,
        bestAskYes: null,
        bestAskNo: null,
        liquidityYesShares: null,
        liquidityNoShares: null,
        impliedYes: null,
        impliedNo: null,
        recommendedSide: null,
        hitProbability: 0.5,
        qualityScore: 20,
        fillProb: 0.2,
        edge: 0,
        score100: 20,
        riskLevel: "HIGH",
        scoreReasons: ["base listing only", "expand/refresh to evaluate more"]
      }));
      const enriched = [...enrichedHead, ...baseTail];

      res.json({
        ok: true,
        source: "kalshi_api",
        count: focused.length,
        returned: enriched.length,
        focus,
        markets: enriched
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    } finally {
      try {
        feed?.stop();
      } catch {
        // ignore
      }
    }
  });

  router.get("/opportunities", async (req, res) => {
    try {
      const cfg = getRuntimeBotConfig();
      const limit = Math.max(1, Math.min(25, Number(req.query.limit ?? 10)));
      const focusRaw = String(req.query.focus ?? cfg.marketFocus ?? "all");
      const focus: "all" | "crypto_weather" | "hourly" =
        focusRaw === "all" || focusRaw === "hourly" || focusRaw === "crypto_weather"
          ? (focusRaw as "all" | "crypto_weather" | "hourly")
          : "all";
      const items = getManualOpportunities(limit).filter((x) =>
        matchesFocus(focus, {
          question: String(x.question ?? ""),
          ticker: String(x.market_id ?? ""),
          expiryTs: Number(x.expiry_ts ?? NaN)
        })
      );
      res.json({
        ok: true,
        focus,
        source: "scored_only",
        items,
        message: items.length
          ? "Strategy-scored opportunities."
          : "No strategy-qualified opportunities right now. Bot is correctly waiting."
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  router.post("/admin/clear-data", (req, res) => {
    const scope = String(req.body?.scope ?? "demo").toLowerCase() === "all" ? "all" : "demo";
    const deleted = clearRuntimeData(scope);
    deps.onControlTriggered(`Dashboard admin clear data scope=${scope}`, { source: "dashboard", scope, deleted });
    res.json({ ok: true, scope, deleted });
  });

  router.get("/browse/market/:ticker", async (req, res) => {
    try {
      const cfg = getRuntimeBotConfig();
      const adapter = buildAdapter(cfg.adapter);
      const ticker = String(req.params.ticker);
      const market = (adapter.getMarketByTicker ? await adapter.getMarketByTicker(ticker) : null) ?? null;
      if (!market) {
        res.status(404).json({ ok: false, error: "Market not found" });
        return;
      }
      const orderbook = await adapter.getOrderbook(market);
      const strategy = buildStrategy(cfg.strategy);
      const rules = await adapter.parseRules(market);
      const action = strategy.decide({
        market,
        orderbook,
        rules,
        referenceValue: null,
        stopNewTrades: deps.getStopNewTrades(),
        openPositionsCount: 0,
        maxOpenPositions: cfg.maxOpenPositions,
        dailyPnlUsd: 0,
        dailyLossLimitUsd: cfg.dailyLossLimitUsd,
        maxUsdPerTrade: cfg.maxUsdPerTrade,
        targetPrice: cfg.targetPrice,
        exactPriceOnly: cfg.exactPriceOnly,
        nowTs: Date.now(),
        slippageBuffer: cfg.slippageBuffer,
        timeWindowSec: cfg.timeWindowSec,
        externalBufferUsd: 25
      });
      const intelligence = getMarketIntelligenceDetails(market.marketId);
      res.json({ ok: true, market, orderbook, action, intelligence });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  router.post("/browse/paper-trade", async (req, res) => {
    const body = req.body as { ticker?: string; side?: "YES" | "NO"; sizeUsd?: number };
    if (!body?.ticker || (body.side !== "YES" && body.side !== "NO")) {
      res.status(400).json({ ok: false, error: "ticker and side are required" });
      return;
    }

    try {
      const cfg = getRuntimeBotConfig();
      const adapter = buildAdapter(cfg.adapter);
      const market = adapter.getMarketByTicker ? await adapter.getMarketByTicker(body.ticker) : null;
      if (!market) {
        res.status(404).json({ ok: false, error: "Market not found" });
        return;
      }
      const ob = await adapter.getOrderbook(market);
      const price = body.side === "YES" ? ob.bestAskYes : ob.bestAskNo;
      const askSize = body.side === "YES" ? ob.liquidityYesShares : ob.liquidityNoShares;
      const trader = new KalshiTrader();
      trader.setDryRun(true);
      const r = await trader.attemptEntry({
        marketId: market.marketId,
        question: market.question,
        side: body.side,
        price,
        sizeUsd: Number(body.sizeUsd ?? cfg.maxUsdPerTrade),
        askSize,
        timeToExpirySec: (market.expiryTs - Date.now()) / 1000
      });
      res.json({ ok: true, result: r });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  router.post("/trade/manual", async (req, res) => {
    const body = req.body as { ticker?: string; side?: "YES" | "NO"; sizeUsd?: number; mode?: "live" | "paper" };
    if (!body?.ticker || (body.side !== "YES" && body.side !== "NO")) {
      res.status(400).json({ ok: false, error: "ticker and side are required" });
      return;
    }
    const mode = body.mode === "live" ? "live" : "paper";
    if (mode === "live" && deps.getDryRun()) {
      res.status(400).json({ ok: false, error: "Cannot run live manual order while DRY_RUN=true" });
      return;
    }
    if (mode === "live" && !deps.getLiveTrading()) {
      res.status(400).json({ ok: false, error: "Live trading gate not active" });
      return;
    }

    try {
      const cfg = getRuntimeBotConfig();
      const adapter = buildAdapter(cfg.adapter);
      const market = adapter.getMarketByTicker ? await adapter.getMarketByTicker(body.ticker) : null;
      if (!market) {
        res.status(404).json({ ok: false, error: "Market not found" });
        return;
      }
      const ob = await adapter.getOrderbook(market);
      const price = body.side === "YES" ? ob.bestAskYes : ob.bestAskNo;
      if (!Number.isFinite(price) || price <= 0 || price >= 1) {
        res.status(400).json({ ok: false, error: "No tradable ask currently available for selected side" });
        return;
      }
      const askSize = body.side === "YES" ? ob.liquidityYesShares : ob.liquidityNoShares;
      const trader = new KalshiTrader();
      trader.setDryRun(mode !== "live");
      const r = await trader.attemptEntry({
        marketId: market.marketId,
        question: market.question,
        side: body.side,
        price,
        sizeUsd: Number(body.sizeUsd ?? cfg.maxUsdPerTrade),
        askSize,
        timeToExpirySec: (market.expiryTs - Date.now()) / 1000
      });
      res.json({ ok: true, mode, marketId: market.marketId, side: body.side, price, result: r });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  router.get("/export/orders.csv", (_req, res) => {
    res.status(200).type("text/csv").send(deps.toCsv(getOrdersForCsv()));
  });

  router.get("/export/positions.csv", (_req, res) => {
    res.status(200).type("text/csv").send(deps.toCsv(getPositionsForCsv()));
  });

  router.get("/scan-summary", (req, res) => {
    const hours = Math.max(1, Math.min(72, Number(req.query.hours ?? 24)));
    const windowSec = Math.max(1, Math.min(300, Number(req.query.windowSec ?? 15)));
    res.json(getScanSummary(hours, windowSec));
  });

  router.get("/market-samples", (req, res) => {
    const limit = Math.max(1, Math.min(25, Number(req.query.limit ?? 5)));
    res.json(getMarketSamples(limit));
  });

  router.get("/orders", (req, res) => {
    const limit = Number(req.query.limit ?? 50);
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    res.json(getRecentOrders(Math.max(1, Math.min(500, limit)), status));
  });

  router.get("/positions", (req, res) => {
    const status = req.query.status === "resolved" ? "resolved" : "open";
    res.json(getPositions(status));
  });

  router.get("/trades", (req, res) => {
    const filters = parseTradesFilters(req.query as Record<string, unknown>);
    res.json(getTradesPage(filters));
  });

  router.get("/trades/export.csv", (req, res) => {
    const filters = parseTradesFilters(req.query as Record<string, unknown>);
    res.status(200).type("text/csv").send(deps.toCsv(getTradesForCsv(filters)));
  });

  router.post("/control/stop", (_req, res) => {
    if (!deps.dashboardAllowControl) {
      res.status(403).json({ ok: false, error: "DASHBOARD_ALLOW_CONTROL=false" });
      return;
    }
    deps.setStopNewTrades(true);
    deps.onControlTriggered("Dashboard control: STOP_NEW_TRADES=true", { source: "dashboard" });
    res.json({ ok: true, stopNewTrades: true });
  });

  router.post("/control/start", (_req, res) => {
    if (!deps.dashboardAllowControl) {
      res.status(403).json({ ok: false, error: "DASHBOARD_ALLOW_CONTROL=false" });
      return;
    }
    deps.setStopNewTrades(false);
    deps.onControlTriggered("Dashboard control: STOP_NEW_TRADES=false", { source: "dashboard" });
    res.json({ ok: true, stopNewTrades: false });
  });

  router.post("/control/dry-run", (req, res) => {
    if (!deps.allowDryRunToggle) {
      res.status(403).json({ ok: false, error: "ALLOW_DRYRUN_TOGGLE=false" });
      return;
    }
    if (!deps.dashboardAllowControl) {
      res.status(403).json({ ok: false, error: "DASHBOARD_ALLOW_CONTROL=false" });
      return;
    }
    const enabled = parseBool(req.body?.enabled, true);
    deps.setDryRun(enabled);
    deps.onControlTriggered(`Dashboard control: DRY_RUN=${enabled}`, { source: "dashboard", dryRun: enabled });
    res.json({ ok: true, dryRun: deps.getDryRun() });
  });

  router.post("/control/max-usd", (req, res) => {
    if (!deps.dashboardAllowControl) {
      res.status(403).json({ ok: false, error: "DASHBOARD_ALLOW_CONTROL=false" });
      return;
    }
    const value = Number(req.body?.value);
    if (!Number.isFinite(value) || value <= 0) {
      res.status(400).json({ ok: false, error: "invalid value" });
      return;
    }
    deps.setMaxUsdPerTrade(value);
    deps.onControlTriggered(`Dashboard control: MAX_RISK_PER_TRADE_USD=${value}`, { source: "dashboard", maxUsdPerTrade: value });
    res.json({ ok: true, maxUsdPerTrade: deps.getMaxUsdPerTrade() });
  });

  return router;
}
