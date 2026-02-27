import type { SportsProbabilityProvider } from "./sports";

export class EndpointSportsProvider implements SportsProbabilityProvider {
  id = "endpoint";

  constructor(private readonly endpoint: string) {}

  async getProbability(input: {
    market: { question: string };
    side: "YES" | "NO";
    horizonSec: number;
  }): Promise<{ p: number; confidence: number; reason: string } | null> {
    if (!this.endpoint) return null;
    try {
      const url = new URL(this.endpoint);
      url.searchParams.set("question", input.market.question);
      url.searchParams.set("side", input.side);
      url.searchParams.set("horizonSec", String(input.horizonSec));
      const resp = await fetch(url.toString());
      if (!resp.ok) return null;
      const json: any = await resp.json();
      const p = Number(json?.p ?? json?.probability ?? NaN);
      const confidence = Number(json?.confidence ?? 0.4);
      if (!Number.isFinite(p)) return null;
      return {
        p: Math.max(0, Math.min(1, p)),
        confidence: Math.max(0, Math.min(1, confidence)),
        reason: String(json?.reason ?? "endpoint sports model")
      };
    } catch {
      return null;
    }
  }
}
