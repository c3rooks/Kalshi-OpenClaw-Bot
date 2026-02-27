import dotenv from "dotenv";

dotenv.config();

function asBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null) return defaultValue;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function asNum(value: string | undefined, defaultValue: number): number {
  if (value == null || value.trim() === "") return defaultValue;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function normalizeKalshiEnv(value: string | undefined): "demo" | "prod" {
  return value === "prod" ? "prod" : "demo";
}

function defaultKalshiBaseUrl(env: "demo" | "prod"): string {
  return env === "prod" ? "https://api.elections.kalshi.com" : "https://demo-api.kalshi.co";
}

export type AppConfig = {
  dryRun: boolean;
  liveTrading: boolean;
  scanIntervalMs: number;
  orderFillTimeoutMs: number;
  commandsFilePath: string;
  dashboardPort: number;
  allowDryRunToggle: boolean;
  dashboardAllowControl: boolean;
  seedDemoData: boolean;
  dbPath: string;

  kalshiEnv: "demo" | "prod";
  kalshiApiBaseUrl: string;

  targetPriceCents: number;
  targetPrice: number;
  windowSec: number;
  exactPriceOnly: boolean;
  maxRiskPerTradeUsd: number;
  maxOpenPositions: number;
  dailyLossLimitUsd: number;
  minLiquidityContracts: number;
  minQualityScore: number;
  minEdge: number;
  minFillProb: number;
  ladderStartSizeUsd: number;
  ladderStepUsd: number;
  ladderConsecutiveWinsStep: number;
  ladderTradesWindow: number;
  ladderMinWinRate: number;
  ladderMinFillRate: number;

  strategyMode: "NEAR_EXPIRY_98C" | "NEAR_EXPIRY_98C_WITH_EXTERNAL_BUFFER";
  externalBufferUsd: number;
  weatherProvider: "none" | "endpoint" | "nws";
  weatherEnable: boolean;
  weatherProviderEndpoint?: string;
  weatherProviderApiKey?: string;
  sportsProvider: "none" | "endpoint" | "espn";
  sportsProviderEndpoint?: string;
  maxTotalExposureUsd: number;
  maxPerSymbolExposureUsd: number;
  maxPerLocationExposureUsd: number;
  correlationGuard: boolean;
  feeRate: number;

  telegramNotify: boolean;
  openclawSendCmd?: string;
};

const kalshiEnv = normalizeKalshiEnv(process.env.KALSHI_ENV);
const targetPriceCents = Math.max(1, Math.min(99, Math.round(asNum(process.env.TARGET_PRICE_CENTS, 98))));
const targetPrice = targetPriceCents / 100;
const maxRiskPerTradeUsd = asNum(process.env.MAX_RISK_PER_TRADE_USD, 10);

export const config: AppConfig = {
  dryRun: asBool(process.env.DRY_RUN, true),
  liveTrading: asBool(process.env.LIVE_TRADING, false),
  scanIntervalMs: asNum(process.env.SCAN_INTERVAL_MS, 1000),
  orderFillTimeoutMs: asNum(process.env.ORDER_FILL_TIMEOUT_MS, 1500),
  commandsFilePath: process.env.COMMANDS_FILE_PATH ?? "./commands.txt",
  dashboardPort: asNum(process.env.DASHBOARD_PORT, 3000),
  allowDryRunToggle: asBool(process.env.ALLOW_DRYRUN_TOGGLE, false),
  dashboardAllowControl: asBool(process.env.DASHBOARD_ALLOW_CONTROL, false),
  seedDemoData: asBool(process.env.SEED_DEMO_DATA, false),
  dbPath: process.env.DB_PATH ?? "./bot.sqlite",

  kalshiEnv,
  kalshiApiBaseUrl: process.env.KALSHI_API_BASE_URL ?? defaultKalshiBaseUrl(kalshiEnv),

  targetPriceCents,
  targetPrice,
  windowSec: asNum(process.env.WINDOW_SEC, 15),
  exactPriceOnly: asBool(process.env.EXACT_PRICE_ONLY, true),
  maxRiskPerTradeUsd,
  maxOpenPositions: asNum(process.env.MAX_OPEN_POSITIONS, 1),
  dailyLossLimitUsd: asNum(process.env.DAILY_LOSS_LIMIT_USD, 25),
  minLiquidityContracts: asNum(process.env.MIN_LIQUIDITY_CONTRACTS, maxRiskPerTradeUsd / targetPrice),
  minQualityScore: asNum(process.env.MIN_QUALITY_SCORE, 70),
  minEdge: asNum(process.env.MIN_EDGE, 0.03),
  minFillProb: asNum(process.env.MIN_FILL_PROB, 0.6),
  ladderStartSizeUsd: asNum(process.env.LADDER_START_SIZE_USD, 1),
  ladderStepUsd: asNum(process.env.LADDER_STEP_USD, 1),
  ladderConsecutiveWinsStep: asNum(process.env.LADDER_CONSECUTIVE_WINS_STEP, 25),
  ladderTradesWindow: asNum(process.env.LADDER_TRADES_WINDOW, 100),
  ladderMinWinRate: asNum(process.env.LADDER_MIN_WINRATE, 0.6),
  ladderMinFillRate: asNum(process.env.LADDER_MIN_FILL_RATE, 0.2),

  strategyMode:
    process.env.STRATEGY_MODE === "NEAR_EXPIRY_98C_WITH_EXTERNAL_BUFFER"
      ? "NEAR_EXPIRY_98C_WITH_EXTERNAL_BUFFER"
      : "NEAR_EXPIRY_98C",
  externalBufferUsd: asNum(process.env.EXTERNAL_BUFFER_USD, 25),
  weatherProvider:
    process.env.WEATHER_PROVIDER === "endpoint"
      ? "endpoint"
      : process.env.WEATHER_PROVIDER === "none"
        ? "none"
        : "nws",
  weatherEnable: asBool(process.env.WEATHER_ENABLE, true),
  weatherProviderEndpoint: process.env.WEATHER_PROVIDER_ENDPOINT,
  weatherProviderApiKey: process.env.WEATHER_PROVIDER_API_KEY,
  sportsProvider:
    process.env.SPORTS_PROVIDER === "endpoint"
      ? "endpoint"
      : process.env.SPORTS_PROVIDER === "none"
        ? "none"
        : "espn",
  sportsProviderEndpoint: process.env.SPORTS_PROVIDER_ENDPOINT,
  maxTotalExposureUsd: asNum(process.env.MAX_TOTAL_EXPOSURE_USD, 100),
  maxPerSymbolExposureUsd: asNum(process.env.MAX_PER_SYMBOL_EXPOSURE_USD, 40),
  maxPerLocationExposureUsd: asNum(process.env.MAX_PER_LOCATION_EXPOSURE_USD, 40),
  correlationGuard: asBool(process.env.CORRELATION_GUARD, true),
  feeRate: asNum(process.env.FEE_RATE, 0),

  telegramNotify: asBool(process.env.TELEGRAM_NOTIFY, false),
  openclawSendCmd: process.env.OPENCLAW_SEND_CMD
};

export function assertRequiredConfig(): void {
  if (!config.dryRun && !config.liveTrading) {
    throw new Error("If DRY_RUN=false, set LIVE_TRADING=true only after completing LIVE gates in dashboard.");
  }
}
