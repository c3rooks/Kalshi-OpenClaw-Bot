import { config } from "../../config";
import { getRuntimeBotConfig } from "../../settings/runtimeConfig";
import type { SportsProbabilityProvider } from "./sports";
import { NoExternalSportsProvider } from "./sports";
import type { WeatherProbabilityProvider } from "./weather";
import { NoExternalWeatherProvider } from "./weather";
import { EndpointWeatherProvider } from "./endpointWeather";
import { EndpointSportsProvider } from "./endpointSports";
import { NwsWeatherProvider } from "./nwsWeather";
import { EspnSportsProvider } from "./espnSports";

export function buildWeatherProvider(): WeatherProbabilityProvider {
  const runtime = getRuntimeBotConfig();
  const provider = runtime.weatherProvider ?? config.weatherProvider;
  if (provider === "endpoint" && runtime.weatherProviderEndpoint) {
    return new EndpointWeatherProvider(runtime.weatherProviderEndpoint, runtime.weatherProviderApiKey);
  }
  if (provider === "nws") return new NwsWeatherProvider();
  return new NoExternalWeatherProvider();
}

export function buildSportsProvider(): SportsProbabilityProvider {
  const runtime = getRuntimeBotConfig();
  const provider = runtime.sportsProvider ?? config.sportsProvider;
  if (provider === "endpoint" && runtime.sportsProviderEndpoint) {
    return new EndpointSportsProvider(runtime.sportsProviderEndpoint);
  }
  if (provider === "espn") return new EspnSportsProvider();
  return new NoExternalSportsProvider();
}
