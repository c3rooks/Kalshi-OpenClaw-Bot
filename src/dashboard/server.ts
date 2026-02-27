import express from "express";
import fs from "node:fs";
import path from "node:path";
import { buildApiRouter, type DashboardControlDeps } from "./api";
import {
  renderBrowsePage,
  renderConfigPage,
  renderExecutionReportPage,
  renderHelpPage,
  renderHome,
  renderIntelCryptoPage,
  renderIntelWeatherPage,
  renderIntelligencePage,
  renderMarketDetailPage,
  renderPerformancePage,
  renderScanTestPage,
  renderTradesPage
} from "./views";
import { getStats } from "../db/queries";

export function startDashboardServer(port: number, deps: DashboardControlDeps): void {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false }));

  const distAssetsDir = path.join(__dirname, "public");
  const srcAssetsDir = path.resolve(process.cwd(), "src/dashboard/public");
  const assetsDir = fs.existsSync(distAssetsDir) ? distAssetsDir : srcAssetsDir;
  app.use("/assets", express.static(assetsDir));

  app.get("/", (_req, res) => {
    const stats = getStats({
      dryRun: deps.getDryRun(),
      stopNewTrades: deps.getStopNewTrades(),
      currentTradeSizeUsd: deps.getMaxUsdPerTrade()
    });
    stats.dashboardAllowControl = deps.dashboardAllowControl;
    stats.liveTradingActive = deps.getLiveTrading() && !deps.getDryRun();
    const drift = deps.getDriftMsEstimate();
    stats.driftMsEstimate = drift ?? undefined;
    stats.driftWarning = drift != null && Math.abs(drift) > 250;
    res.status(200).type("html").send(renderHome(stats));
  });

  app.get("/help", (_req, res) => res.status(200).type("html").send(renderHelpPage()));
  app.get("/config", (_req, res) => res.status(200).type("html").send(renderConfigPage()));
  app.get("/scan-test", (_req, res) => res.status(200).type("html").send(renderScanTestPage()));
  app.get("/trades", (_req, res) => res.status(200).type("html").send(renderTradesPage()));
  app.get("/report", (_req, res) => res.status(200).type("html").send(renderExecutionReportPage()));
  app.get("/intelligence", (_req, res) => res.status(200).type("html").send(renderIntelligencePage()));
  app.get("/intel/crypto", (_req, res) => res.status(200).type("html").send(renderIntelCryptoPage()));
  app.get("/intel/weather", (_req, res) => res.status(200).type("html").send(renderIntelWeatherPage()));
  app.get("/performance", (_req, res) => res.status(200).type("html").send(renderPerformancePage()));
  app.get("/browse", (_req, res) => res.status(200).type("html").send(renderBrowsePage()));
  app.get("/market/:ticker", (req, res) => res.status(200).type("html").send(renderMarketDetailPage(String(req.params.ticker))));

  app.get("/health", (_req, res) => {
    const drift = deps.getDriftMsEstimate();
    res.status(200).json({
      status: "OK",
      ok: true,
      dryRun: deps.getDryRun(),
      stopNewTrades: deps.getStopNewTrades(),
      dashboardAllowControl: deps.dashboardAllowControl,
      driftMsEstimate: drift,
      driftWarning: drift != null && Math.abs(drift) > 250,
      ts: Date.now()
    });
  });

  app.use("/api", buildApiRouter(deps));

  const server = app.listen(port, "127.0.0.1", () => {
    // eslint-disable-next-line no-console
    console.log(`[dashboard] http://127.0.0.1:${port}`);
  });
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      // eslint-disable-next-line no-console
      console.error(`[dashboard] port in use: 127.0.0.1:${port}. Stop the old process or change DASHBOARD_PORT.`);
      return;
    }
    // eslint-disable-next-line no-console
    console.error(`[dashboard] server error: ${err.message}`);
  });
}
