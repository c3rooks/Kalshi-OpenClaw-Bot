import { logger } from "../utils/logger";

export type BtcPriceFeedMode = "coinbase_ws" | "coinbase_poll";

export class BtcPriceFeed {
  private spotPrice: number | null = null;
  private ws: WebSocket | null = null;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(private readonly mode: BtcPriceFeedMode) {}

  start(): void {
    if (this.mode === "coinbase_ws") {
      this.startWebsocket();
    }
    this.startPolling();
  }

  stop(): void {
    this.ws?.close();
    this.ws = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  getSpotPrice(): number | null {
    return this.spotPrice;
  }

  private startWebsocket(): void {
    try {
      this.ws = new WebSocket("wss://ws-feed.exchange.coinbase.com");
      this.ws.onopen = () => {
        this.ws?.send(
          JSON.stringify({
            type: "subscribe",
            product_ids: ["BTC-USD"],
            channels: ["ticker"]
          })
        );
      };
      this.ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data || "{}"));
          if (msg?.type !== "ticker") return;
          const p = Number(msg?.price);
          if (Number.isFinite(p)) this.spotPrice = p;
        } catch {
          // ignore malformed payloads
        }
      };
      this.ws.onerror = () => {
        logger.warn("Coinbase WS price feed error; relying on polling fallback");
      };
      this.ws.onclose = () => {
        logger.warn("Coinbase WS feed closed; relying on polling fallback");
      };
    } catch (err) {
      logger.warn("Failed to start Coinbase WS; relying on polling fallback", {
        error: (err as Error).message
      });
    }
  }

  private startPolling(): void {
    const poll = async () => {
      try {
        const resp = await fetch("https://api.coinbase.com/v2/prices/BTC-USD/spot");
        if (!resp.ok) return;
        const data: any = await resp.json();
        const p = Number(data?.data?.amount);
        if (Number.isFinite(p)) this.spotPrice = p;
      } catch {
        // ignore transient failures
      }
    };

    void poll();
    this.pollTimer = setInterval(() => {
      void poll();
    }, 5000);
  }
}
