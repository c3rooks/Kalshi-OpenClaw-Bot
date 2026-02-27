import type { ParsedMarketFields } from "./marketTypeClassifier";

type SymbolState = {
  spot: number;
  lastTs: number;
  ewmaVar: number;
  alpha: number;
  samples: number;
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * Math.abs(x));
  const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x));
  return sign * y;
}

function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.sqrt(2)));
}

export class CryptoProbabilityEngine {
  private readonly states = new Map<string, SymbolState>();

  updateTick(symbol: "BTC" | "ETH", price: number, ts = Date.now()): void {
    if (!Number.isFinite(price) || price <= 0) return;
    const key = symbol.toUpperCase();
    const st = this.states.get(key);
    if (!st) {
      this.states.set(key, {
        spot: price,
        lastTs: ts,
        ewmaVar: 1e-8,
        alpha: 0.15,
        samples: 1
      });
      return;
    }

    const prev = Math.max(1e-9, st.spot);
    const ret = Math.log(price / prev);
    const dtSec = Math.max(0.2, (ts - st.lastTs) / 1000);
    const normalized = ret / Math.sqrt(dtSec);
    st.ewmaVar = st.alpha * normalized * normalized + (1 - st.alpha) * st.ewmaVar;
    st.spot = price;
    st.lastTs = ts;
    st.samples += 1;
  }

  getCryptoSpot(symbol: "BTC" | "ETH"): number | null {
    const st = this.states.get(symbol);
    return st ? st.spot : null;
  }

  getVolEstimate(symbol: "BTC" | "ETH"): number | null {
    const st = this.states.get(symbol);
    if (!st) return null;
    return Math.sqrt(Math.max(st.ewmaVar, 1e-8));
  }

  pTerminalAbove(symbol: "BTC" | "ETH", strike: number, timeSec: number): number | null {
    const spot = this.getCryptoSpot(symbol);
    const sigma = this.getVolEstimate(symbol);
    if (!Number.isFinite(spot) || !Number.isFinite(sigma) || !Number.isFinite(strike) || strike <= 0) return null;

    const tSec = Math.max(timeSec, 1);
    const stdev = Math.max(1e-9, (sigma as number) * Math.sqrt(tSec));
    const mu = Math.log(spot as number) - 0.5 * (sigma as number) * (sigma as number) * tSec;
    const z = (Math.log(strike) - mu) / stdev;
    return clamp(1 - normalCdf(z), 0, 1);
  }

  pTouchBarrier(symbol: "BTC" | "ETH", strike: number, timeSec: number, direction: "UP" | "DOWN"): number | null {
    const spot = this.getCryptoSpot(symbol);
    const sigma = this.getVolEstimate(symbol);
    if (!Number.isFinite(spot) || !Number.isFinite(sigma) || !Number.isFinite(strike) || strike <= 0) return null;

    const s0 = spot as number;
    const vol = Math.max(1e-6, sigma as number);
    const tSec = Math.max(timeSec, 1);
    const denom = vol * Math.sqrt(tSec);
    if (!Number.isFinite(denom) || denom <= 0) return null;

    const logRatio = Math.log(strike / s0);
    const z = Math.abs(logRatio) / denom;
    const crossing = 2 * (1 - normalCdf(z));

    if (direction === "UP" && strike <= s0) return 1;
    if (direction === "DOWN" && strike >= s0) return 1;
    return clamp(crossing, 0, 1);
  }

  evaluateMarket(input: {
    parsed: ParsedMarketFields;
    timeToCloseSec: number;
  }): { pModel: number | null; confidence: number; reason: string } {
    const parsed = input.parsed;
    if (!parsed.underlying || !Number.isFinite(parsed.threshold)) {
      return { pModel: null, confidence: 0, reason: "missing underlying or threshold" };
    }

    const symbol = parsed.underlying;
    const spot = this.getCryptoSpot(symbol);
    const vol = this.getVolEstimate(symbol);
    const state = this.states.get(symbol);
    if (!Number.isFinite(spot) || !Number.isFinite(vol) || !state) {
      return { pModel: null, confidence: 0, reason: "missing spot/volatility" };
    }

    let p: number | null = null;
    if (parsed.marketType === "CRYPTO_THRESHOLD") {
      const up = parsed.relation !== "BELOW";
      const pUp = this.pTerminalAbove(symbol, parsed.threshold as number, input.timeToCloseSec);
      p = pUp == null ? null : up ? pUp : 1 - pUp;
    } else if (parsed.marketType === "CRYPTO_TOUCH") {
      const direction: "UP" | "DOWN" = (parsed.threshold as number) >= (spot as number) ? "UP" : "DOWN";
      p = this.pTouchBarrier(symbol, parsed.threshold as number, input.timeToCloseSec, direction);
    }

    if (p == null) return { pModel: null, confidence: 0, reason: "model unavailable" };

    const ageSec = (Date.now() - state.lastTs) / 1000;
    const freshness = clamp(1 - ageSec / 15, 0, 1);
    const stability = clamp(1 - Math.min(vol as number, 0.03) / 0.03, 0, 1);
    const sampleFactor = clamp(state.samples / 120, 0, 1);
    const confidence = clamp(0.25 + 0.35 * freshness + 0.2 * stability + 0.2 * sampleFactor, 0.05, 0.95);

    return { pModel: p, confidence, reason: parsed.marketType === "CRYPTO_TOUCH" ? "barrier model" : "terminal GBM model" };
  }
}
