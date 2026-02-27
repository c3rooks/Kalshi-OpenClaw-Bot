import { kalshiAuthCheck } from "../src/kalshi/client";
import { getRuntimeBotConfig } from "../src/settings/runtimeConfig";

async function main(): Promise<void> {
  try {
    const cfg = getRuntimeBotConfig();
    const result = await kalshiAuthCheck();
    // eslint-disable-next-line no-console
    console.log("Kalshi auth check OK");
    // eslint-disable-next-line no-console
    console.log(`env=${cfg.kalshiEnv}`);
    // eslint-disable-next-line no-console
    console.log(`apiBase=${cfg.kalshiApiBaseUrl}`);
    // eslint-disable-next-line no-console
    console.log(`latencyMs=${result.latencyMs}`);
    if (result.balanceUsd != null) {
      // eslint-disable-next-line no-console
      console.log(`balanceUsd=${result.balanceUsd.toFixed(2)}`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Kalshi auth check FAILED");
    // eslint-disable-next-line no-console
    console.error((err as Error).message);
    process.exit(1);
  }
}

void main();
