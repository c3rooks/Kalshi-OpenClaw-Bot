import type { DataFeed, NormalizedMarket } from "../types";

export class NoExternalFeed implements DataFeed {
  readonly id = "NONE";
  start(): void {}
  stop(): void {}
  getReferenceValue(_market: NormalizedMarket): number | null { return null; }
}
