import { buildAdapter } from "../src/plugins/factory";
import { getRuntimeBotConfig } from "../src/settings/runtimeConfig";

async function main(): Promise<void> {
  const cfg = getRuntimeBotConfig();
  const adapter = buildAdapter(cfg.adapter);
  const markets = await adapter.listCandidateMarkets();
  // eslint-disable-next-line no-console
  console.log(`markets_found=${markets.length}`);

  let sampled = 0;
  for (const m of markets.slice(0, 5)) {
    const ob = await adapter.getOrderbook(m);
    sampled += 1;
    // eslint-disable-next-line no-console
    console.log(`${m.marketId} | bestAskYes=${ob.bestAskYes.toFixed(2)} | bestAskNo=${ob.bestAskNo.toFixed(2)} | liqYes=${ob.liquidityYesShares.toFixed(1)} | liqNo=${ob.liquidityNoShares.toFixed(1)}`);
  }
  // eslint-disable-next-line no-console
  console.log(`sampled=${sampled}`);
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(`scan failed: ${(err as Error).message}`);
  process.exit(1);
});
