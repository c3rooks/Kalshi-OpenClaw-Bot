import { URL } from "node:url";
import { config } from "../config";
import { getSecret } from "../settings/secureStore";
import { getRuntimeBotConfig } from "../settings/runtimeConfig";
import { logger } from "../utils/logger";
import { signKalshiRequest } from "./auth";
import type { KalshiCreds } from "./types";

type Query = Record<string, string | number | boolean | undefined>;

function encodeQuery(query?: Query): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v == null) continue;
    params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

async function loadKalshiCreds(): Promise<KalshiCreds | null> {
  const cfg = getRuntimeBotConfig();
  const keyId = String(cfg.extraKalshiKeyId ?? "").trim();
  const pem = await getSecret("KALSHI_PRIVATE_KEY_PEM");
  if (!keyId || !pem) return null;
  return { keyId, privateKeyPem: pem };
}

function normalizeBaseUrl(value: string): string {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "https://api.elections.kalshi.com";
  const noTrailingSlash = trimmed.replace(/\/+$/, "");
  return noTrailingSlash.replace(/\/trade-api\/v[0-9]+$/i, "");
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export class KalshiHttpClient {
  private static throttleChain: Promise<void> = Promise.resolve();
  private static nextAllowedAtMs = 0;

  constructor(private readonly baseUrl: string) {}

  async get(path: string, query?: Query, authRequired = false): Promise<any> {
    return this.request("GET", path, undefined, query, authRequired);
  }

  async post(path: string, body?: unknown, authRequired = false): Promise<any> {
    return this.request("POST", path, body, undefined, authRequired);
  }

  async delete(path: string, query?: Query, authRequired = false): Promise<any> {
    return this.request("DELETE", path, undefined, query, authRequired);
  }

  private async throttle(method: string, path: string): Promise<void> {
    const lower = path.toLowerCase();
    const isOrderbook = lower.includes("/orderbook");
    const isMarketsList = lower === "/trade-api/v2/markets";
    const isMarketData = method === "GET" && (isOrderbook || isMarketsList);
    const minGapMs = isMarketData ? 180 : 80;
    const prev = KalshiHttpClient.throttleChain;
    let release!: () => void;
    KalshiHttpClient.throttleChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      const now = Date.now();
      const waitMs = Math.max(0, KalshiHttpClient.nextAllowedAtMs - now);
      if (waitMs > 0) await wait(waitMs);
      KalshiHttpClient.nextAllowedAtMs = Date.now() + minGapMs;
    } finally {
      release();
    }
  }

  private async request(method: string, path: string, body?: unknown, query?: Query, authRequired = false): Promise<any> {
    const q = encodeQuery(query);
    const pathWithQuery = `${path}${q}`;
    const url = new URL(pathWithQuery, normalizeBaseUrl(this.baseUrl)).toString();

    const headers: Record<string, string> = {
      Accept: "application/json"
    };

    if (body != null) {
      headers["Content-Type"] = "application/json";
    }

    if (authRequired) {
      const creds = await loadKalshiCreds();
      if (!creds) {
        throw new Error("Kalshi credentials are not configured. Set KALSHI_KEY_ID and KALSHI_PRIVATE_KEY_PEM first.");
      }

      const timestampMs = String(Date.now());
      const signature = signKalshiRequest({
        timestampMs,
        method,
        pathWithQuery,
        privateKeyPem: creds.privateKeyPem
      });

      headers["KALSHI-ACCESS-KEY"] = creds.keyId;
      headers["KALSHI-ACCESS-TIMESTAMP"] = timestampMs;
      headers["KALSHI-ACCESS-SIGNATURE"] = signature;
    }

    const start = Date.now();
    const maxAttempts = 3;
    let lastErr: Error | null = null;
    let lastRespStatus: number | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      try {
        await this.throttle(method, path);
        const resp = await fetch(url, {
          method,
          headers,
          body: body == null ? undefined : JSON.stringify(body),
          signal: controller.signal
        });

        const text = await resp.text();
        let parsed: any = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          parsed = { raw: text };
        }

        if (!resp.ok) {
          lastRespStatus = resp.status;
          const errValue = parsed?.error;
          const msg =
            typeof errValue === "string"
              ? errValue
              : typeof errValue?.message === "string"
                ? errValue.message
                : `HTTP ${resp.status}`;
          if (attempt < maxAttempts && isRetryableStatus(resp.status)) {
            const retryAfterSec = Number(resp.headers.get("retry-after"));
            const retryWaitMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : 300 * attempt;
            await wait(retryWaitMs);
            continue;
          }
          throw new Error(`Kalshi ${method} ${path} failed: ${msg}`);
        }

        const latency = Date.now() - start;
        if (latency > 1500) {
          logger.warn("Slow Kalshi API response", { method, path, latencyMs: latency });
        }
        return parsed;
      } catch (err) {
        const e = err as Error & { cause?: unknown };
        lastErr = e;
        const isKnownKalshiError = e.message.startsWith("Kalshi ");
        if (!isKnownKalshiError && attempt < maxAttempts) {
          await wait(150 * attempt);
          continue;
        }
        if (!isKnownKalshiError) {
          const cause = typeof e.cause === "string" ? e.cause : e.cause ? JSON.stringify(e.cause) : "";
          throw new Error(`Kalshi ${method} ${path} network error: ${e.message}${cause ? ` | cause=${cause}` : ""}`);
        }
        throw e;
      } finally {
        clearTimeout(timeout);
      }
    }

    const msg = lastErr?.message ?? `Kalshi ${method} ${path} failed`;
    if (lastRespStatus != null) throw new Error(`${msg} (status=${lastRespStatus})`);
    throw new Error(msg);
  }
}

let cachedClient: KalshiHttpClient | null = null;

export function getKalshiHttpClient(): KalshiHttpClient {
  if (!cachedClient) {
    const cfg = getRuntimeBotConfig();
    cachedClient = new KalshiHttpClient(cfg.kalshiApiBaseUrl || config.kalshiApiBaseUrl);
  }
  return cachedClient;
}

export function resetKalshiHttpClient(): void {
  cachedClient = null;
}

export async function kalshiAuthCheck(): Promise<{ ok: boolean; latencyMs: number; path: string; balanceUsd?: number }> {
  const client = getKalshiHttpClient();
  const start = Date.now();
  const result = await client.get("/trade-api/v2/portfolio/balance", undefined, true);
  const latencyMs = Date.now() - start;
  const balance = Number(result?.balance ?? result?.data?.balance ?? NaN);
  return {
    ok: true,
    latencyMs,
    path: "/trade-api/v2/portfolio/balance",
    balanceUsd: Number.isFinite(balance) ? balance / 100 : undefined
  };
}
