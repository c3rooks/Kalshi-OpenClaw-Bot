import { BtcPriceFeed } from "../market/btcPriceFeed";
import { KalshiBtcAdapter } from "./adapters/kalshiBtcAdapter";
import { KalshiGenericBinaryAdapter } from "./adapters/kalshiGenericBinaryAdapter";
import { BtcCoinbaseDataFeed } from "./feeds/btcCoinbaseFeed";
import { NoExternalFeed } from "./feeds/noExternalFeed";
import { NearExpiry98cStrategy } from "./strategies/nearExpiry98c";
import { NearExpiry98cWithBufferStrategy } from "./strategies/nearExpiry98cWithBuffer";
import { NearExpiryPriceOnlyStrategy } from "./strategies/nearExpiryPriceOnly";
import { HourlyPriceOnlyStrategy } from "./strategies/hourlyPriceOnly";
import type { DataFeed, MarketAdapter, StrategyPlugin } from "./types";

export type PluginRuntimeConfig = {
  adapter: "KalshiGenericBinary" | "KalshiBtcFast";
  strategy: "NearExpiry98c" | "NearExpiry98cWithExternalBuffer" | "NearExpiryPriceOnly" | "HourlyPriceOnly";
  btcPriceFeedMode: "coinbase_ws" | "coinbase_poll";
};

export function buildAdapter(id: PluginRuntimeConfig["adapter"]): MarketAdapter {
  if (id === "KalshiBtcFast") return new KalshiBtcAdapter();
  return new KalshiGenericBinaryAdapter();
}

export function buildStrategy(id: PluginRuntimeConfig["strategy"]): StrategyPlugin {
  if (id === "NearExpiry98cWithExternalBuffer") return new NearExpiry98cWithBufferStrategy();
  if (id === "NearExpiryPriceOnly") return new NearExpiryPriceOnlyStrategy();
  if (id === "HourlyPriceOnly") return new HourlyPriceOnlyStrategy();
  return new NearExpiry98cStrategy();
}

export function buildDataFeed(cfg: PluginRuntimeConfig): DataFeed {
  if (cfg.strategy === "NearExpiry98cWithExternalBuffer") {
    return new BtcCoinbaseDataFeed(new BtcPriceFeed(cfg.btcPriceFeedMode));
  }
  return new NoExternalFeed();
}
