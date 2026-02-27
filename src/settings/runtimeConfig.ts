import { config } from "../config";
import { getSetting, setSetting } from "./settingsStore";

export type RuntimeBotConfig = {
  adapter: "KalshiGenericBinary" | "KalshiBtcFast";
  strategy: "NearExpiry98c" | "NearExpiry98cWithExternalBuffer" | "NearExpiryPriceOnly" | "HourlyPriceOnly";
  marketFocus: "crypto_weather" | "all" | "hourly";
  timeWindowSec: number;
  targetPrice: number;
  targetPriceCents: number;
  exactPriceOnly: boolean;
  maxUsdPerTrade: number;
  maxOrderNotionalUsd: number;
  duplicateCooldownSec: number;
  maxOrdersPerDay: number;
  liveArmTimeoutMin: number;
  dailyLossLimitUsd: number;
  maxOpenPositions: number;
  topCandidatesPerTick: number;
  slippageBuffer: number;
  minQualityScore: number;
  minEdge: number;
  minFillProb: number;

  notificationsEnabled: boolean;
  openclawSendMode: "cli" | "none";
  openclawBinaryPath: string;
  openclawTelegramTarget: string;

  kalshiEnv: "demo" | "prod";
  kalshiApiBaseUrl: string;
  extraKalshiKeyId: string;
  weatherProvider: "none" | "endpoint" | "nws";
  weatherProviderEndpoint: string;
  weatherProviderApiKey: string;
  sportsProvider: "none" | "endpoint" | "espn";
  sportsProviderEndpoint: string;
  weatherEnable: boolean;
  maxTotalExposureUsd: number;
  maxPerSymbolExposureUsd: number;
  maxPerLocationExposureUsd: number;
  correlationGuard: boolean;
  feeRate: number;

  liveEnabled: boolean;
};

const DEFAULTS: RuntimeBotConfig = {
  adapter: "KalshiGenericBinary",
  strategy: config.strategyMode === "NEAR_EXPIRY_98C_WITH_EXTERNAL_BUFFER" ? "NearExpiry98cWithExternalBuffer" : "NearExpiry98c",
  marketFocus: "all",
  timeWindowSec: config.windowSec,
  targetPrice: config.targetPrice,
  targetPriceCents: config.targetPriceCents,
  exactPriceOnly: config.exactPriceOnly,
  maxUsdPerTrade: config.maxRiskPerTradeUsd,
  maxOrderNotionalUsd: config.maxRiskPerTradeUsd,
  duplicateCooldownSec: 120,
  maxOrdersPerDay: 120,
  liveArmTimeoutMin: 120,
  dailyLossLimitUsd: config.dailyLossLimitUsd,
  maxOpenPositions: config.maxOpenPositions,
  topCandidatesPerTick: 3,
  slippageBuffer: 0.05,
  minQualityScore: config.minQualityScore,
  minEdge: config.minEdge,
  minFillProb: config.minFillProb,

  notificationsEnabled: config.telegramNotify,
  openclawSendMode: "cli",
  openclawBinaryPath: config.openclawSendCmd ?? "openclaw",
  openclawTelegramTarget: "",

  kalshiEnv: config.kalshiEnv,
  kalshiApiBaseUrl: config.kalshiApiBaseUrl,
  extraKalshiKeyId: "",
  weatherProvider: config.weatherProvider,
  weatherProviderEndpoint: config.weatherProviderEndpoint ?? "",
  weatherProviderApiKey: config.weatherProviderApiKey ?? "",
  sportsProvider: config.sportsProvider,
  sportsProviderEndpoint: config.sportsProviderEndpoint ?? "",
  weatherEnable: config.weatherEnable,
  maxTotalExposureUsd: config.maxTotalExposureUsd,
  maxPerSymbolExposureUsd: config.maxPerSymbolExposureUsd,
  maxPerLocationExposureUsd: config.maxPerLocationExposureUsd,
  correlationGuard: config.correlationGuard,
  feeRate: config.feeRate,

  liveEnabled: false
};

export function getRuntimeBotConfig(): RuntimeBotConfig {
  const cfg = (getSetting<Record<string, unknown>>("bot.config", {}) ?? {}) as Partial<RuntimeBotConfig>;
  const rawAdapter = String(cfg.adapter ?? DEFAULTS.adapter);
  const rawStrategy = String(cfg.strategy ?? DEFAULTS.strategy);
  const rawFocus = String((cfg as Record<string, unknown>).marketFocus ?? DEFAULTS.marketFocus);
  const combined = {
    ...DEFAULTS,
    ...cfg,
    adapter: rawAdapter === "KalshiBtcFast" || rawAdapter === "KalshiGenericBinary" ? rawAdapter : DEFAULTS.adapter,
    strategy:
      rawStrategy === "NearExpiry98cWithExternalBuffer" || rawStrategy === "NearExpiry98c" || rawStrategy === "NearExpiryPriceOnly" || rawStrategy === "HourlyPriceOnly"
        ? rawStrategy
        : DEFAULTS.strategy,
    marketFocus: (rawFocus === "all" || rawFocus === "hourly" || rawFocus === "crypto_weather" ? rawFocus : "all") as "all" | "crypto_weather" | "hourly",
    openclawSendMode: cfg.openclawSendMode === "none" ? "none" : "cli",
    targetPrice: Number(cfg.targetPrice ?? DEFAULTS.targetPrice),
    targetPriceCents: Number(cfg.targetPriceCents ?? Math.round((cfg.targetPrice ?? DEFAULTS.targetPrice) * 100))
  };
  const targetPriceCents = Math.max(1, Math.min(99, Math.round(Number(combined.targetPriceCents))));
  const targetPrice = targetPriceCents / 100;
  const kalshiEnv: "demo" | "prod" = combined.kalshiEnv === "prod" ? "prod" : "demo";
  const kalshiApiBaseUrl = String(combined.kalshiApiBaseUrl || DEFAULTS.kalshiApiBaseUrl).trim() || DEFAULTS.kalshiApiBaseUrl;
  const weatherProvider: "none" | "endpoint" | "nws" =
    combined.weatherProvider === "endpoint" ? "endpoint" : combined.weatherProvider === "none" ? "none" : "nws";
  const sportsProvider: "none" | "endpoint" | "espn" =
    combined.sportsProvider === "endpoint" ? "endpoint" : combined.sportsProvider === "none" ? "none" : "espn";

  const cleaned: RuntimeBotConfig = {
    adapter: combined.adapter,
    strategy: combined.strategy,
    marketFocus: combined.marketFocus,
    timeWindowSec: Number(combined.timeWindowSec ?? DEFAULTS.timeWindowSec),
    targetPrice,
    targetPriceCents,
    exactPriceOnly: Boolean(combined.exactPriceOnly),
    maxUsdPerTrade: Number(combined.maxUsdPerTrade ?? DEFAULTS.maxUsdPerTrade),
    maxOrderNotionalUsd: Number(combined.maxOrderNotionalUsd ?? DEFAULTS.maxOrderNotionalUsd),
    duplicateCooldownSec: Number(combined.duplicateCooldownSec ?? DEFAULTS.duplicateCooldownSec),
    maxOrdersPerDay: Number(combined.maxOrdersPerDay ?? DEFAULTS.maxOrdersPerDay),
    liveArmTimeoutMin: Number(combined.liveArmTimeoutMin ?? DEFAULTS.liveArmTimeoutMin),
    dailyLossLimitUsd: Number(combined.dailyLossLimitUsd ?? DEFAULTS.dailyLossLimitUsd),
    maxOpenPositions: Number(combined.maxOpenPositions ?? DEFAULTS.maxOpenPositions),
    topCandidatesPerTick: Number(combined.topCandidatesPerTick ?? DEFAULTS.topCandidatesPerTick),
    slippageBuffer: Number(combined.slippageBuffer ?? DEFAULTS.slippageBuffer),
    minQualityScore: Number(combined.minQualityScore ?? DEFAULTS.minQualityScore),
    minEdge: Number(combined.minEdge ?? DEFAULTS.minEdge),
    minFillProb: Number(combined.minFillProb ?? DEFAULTS.minFillProb),
    notificationsEnabled: Boolean(combined.notificationsEnabled),
    openclawSendMode: combined.openclawSendMode === "none" ? "none" : "cli",
    openclawBinaryPath: String(combined.openclawBinaryPath ?? DEFAULTS.openclawBinaryPath),
    openclawTelegramTarget: String(combined.openclawTelegramTarget ?? ""),
    kalshiEnv,
    kalshiApiBaseUrl,
    extraKalshiKeyId: String(combined.extraKalshiKeyId ?? ""),
    weatherProvider,
    weatherProviderEndpoint: String(combined.weatherProviderEndpoint ?? ""),
    weatherProviderApiKey: String(combined.weatherProviderApiKey ?? ""),
    sportsProvider,
    sportsProviderEndpoint: String(combined.sportsProviderEndpoint ?? ""),
    weatherEnable: Boolean(combined.weatherEnable),
    maxTotalExposureUsd: Number(combined.maxTotalExposureUsd ?? DEFAULTS.maxTotalExposureUsd),
    maxPerSymbolExposureUsd: Number(combined.maxPerSymbolExposureUsd ?? DEFAULTS.maxPerSymbolExposureUsd),
    maxPerLocationExposureUsd: Number(combined.maxPerLocationExposureUsd ?? DEFAULTS.maxPerLocationExposureUsd),
    correlationGuard: Boolean(combined.correlationGuard),
    feeRate: Number(combined.feeRate ?? DEFAULTS.feeRate),
    liveEnabled: Boolean(combined.liveEnabled)
  };
  return cleaned;
}

export function setRuntimeBotConfig(patch: Partial<RuntimeBotConfig>): RuntimeBotConfig {
  const current = getRuntimeBotConfig();
  const next = { ...current, ...patch };
  if (patch.targetPriceCents != null && Number.isFinite(Number(patch.targetPriceCents))) {
    const cents = Math.max(1, Math.min(99, Math.round(Number(patch.targetPriceCents))));
    next.targetPriceCents = cents;
    next.targetPrice = cents / 100;
  }
  if (patch.targetPrice != null && Number.isFinite(Number(patch.targetPrice))) {
    const p = Math.max(0.01, Math.min(0.99, Number(patch.targetPrice)));
    next.targetPrice = p;
    next.targetPriceCents = Math.round(p * 100);
  }
  setSetting("bot.config", next);
  return next;
}
