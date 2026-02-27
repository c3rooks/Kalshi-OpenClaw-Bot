import type { NormalizedMarket } from "../../plugins/types";

export type SportsProbabilityProvider = {
  id: string;
  getProbability(input: {
    market: NormalizedMarket;
    side: "YES" | "NO";
    horizonSec: number;
  }): Promise<{ p: number; confidence: number; reason: string } | null>;
};

export class NoExternalSportsProvider implements SportsProbabilityProvider {
  id = "none";

  async getProbability(): Promise<{ p: number; confidence: number; reason: string } | null> {
    return null;
  }
}
