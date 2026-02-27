import type { NormalizedMarket } from "../../plugins/types";

type WeatherForecastInput = {
  market: NormalizedMarket;
  threshold?: number;
  relation?: "ABOVE" | "BELOW";
  horizonSec: number;
};

export type WeatherProbabilityProvider = {
  id: string;
  getProbability(input: WeatherForecastInput): Promise<{ p: number; confidence: number; reason: string } | null>;
};

export class NoExternalWeatherProvider implements WeatherProbabilityProvider {
  id = "none";

  async getProbability(): Promise<{ p: number; confidence: number; reason: string } | null> {
    return null;
  }
}
