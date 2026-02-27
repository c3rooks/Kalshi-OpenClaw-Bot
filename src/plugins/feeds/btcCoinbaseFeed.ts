import { BtcPriceFeed } from "../../market/btcPriceFeed";
import type { DataFeed, NormalizedMarket } from "../types";

export class BtcCoinbaseDataFeed implements DataFeed {
  readonly id = "BTC_COINBASE";
  constructor(private readonly feed: BtcPriceFeed) {}
  start(): void { this.feed.start(); }
  stop(): void { this.feed.stop(); }
  getReferenceValue(_market: NormalizedMarket): number | null { return this.feed.getSpotPrice(); }
}
