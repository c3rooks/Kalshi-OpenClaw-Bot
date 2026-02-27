import type { WeatherProbabilityProvider } from "./weather";

export class EndpointWeatherProvider implements WeatherProbabilityProvider {
  id = "endpoint";

  constructor(
    private readonly endpoint: string,
    private readonly apiKey?: string
  ) {}

  async getProbability(input: {
    market: { question: string };
    threshold?: number;
    relation?: "ABOVE" | "BELOW";
    horizonSec: number;
  }): Promise<{ p: number; confidence: number; reason: string } | null> {
    if (!this.endpoint) return null;
    try {
      const url = new URL(this.endpoint);
      url.searchParams.set("question", input.market.question);
      if (Number.isFinite(input.threshold)) url.searchParams.set("threshold", String(input.threshold));
      if (input.relation) url.searchParams.set("relation", input.relation);
      url.searchParams.set("horizonSec", String(input.horizonSec));
      if (this.apiKey) url.searchParams.set("apiKey", this.apiKey);
      const resp = await fetch(url.toString());
      if (!resp.ok) return null;
      const json: any = await resp.json();
      const p = Number(json?.p ?? json?.probability ?? NaN);
      const confidence = Number(json?.confidence ?? 0.5);
      if (!Number.isFinite(p)) return null;
      return {
        p: Math.max(0, Math.min(1, p)),
        confidence: Math.max(0, Math.min(1, confidence)),
        reason: String(json?.reason ?? "endpoint weather model")
      };
    } catch {
      return null;
    }
  }
}
