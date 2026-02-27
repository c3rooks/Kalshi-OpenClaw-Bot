import type { ParsedRules } from "../plugins/types";
import type { MarketKind, ProbabilityEstimate } from "./types";
import type { WeatherProbabilityProvider } from "./providers/weather";
import type { SportsProbabilityProvider } from "./providers/sports";
import { parseSportsMarket } from "./parsing/sportsEntityParser";

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
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

export function estimateVolatilityFromMids(mids: number[]): number {
  if (mids.length < 4) return 0.02;
  const returns: number[] = [];
  for (let i = 1; i < mids.length; i += 1) {
    const prev = Math.max(0.0001, mids[i - 1]);
    const curr = Math.max(0.0001, mids[i]);
    returns.push(Math.log(curr / prev));
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, r) => a + (r - mean) * (r - mean), 0) / Math.max(1, returns.length - 1);
  return Math.sqrt(Math.max(variance, 1e-8));
}

export function inferMarketKind(category: string | undefined, question: string): MarketKind {
  const c = (category || "").toLowerCase();
  const q = (question || "").toLowerCase();
  if (c.includes("weather") || q.includes("temperature") || q.includes("rain") || q.includes("snow")) return "weather";
  const sportsLegs = parseSportsMarket(question);
  if (sportsLegs.some((l) => l.type !== "UNKNOWN")) return "sports";
  if (
    c.includes("sports") ||
    /\b(nba|nfl|mlb|nhl|wnba|soccer|tennis|golf|mma|ufc|ncaa)\b/.test(q) ||
    /\b(points?|rebounds?|assists?|yards?|touchdowns?|goals?|hits?|runs?|strikeouts?|wins?)\b/.test(q) ||
    (q.includes("will ") && q.includes(" win"))
  ) {
    return "sports";
  }
  if (q.includes("above") || q.includes("below") || q.includes("over") || q.includes("under")) return "threshold";
  return "generic";
}

export async function computeProbabilityEstimate(input: {
  kind: MarketKind;
  side: "YES" | "NO";
  impliedPrice: number;
  rules: ParsedRules;
  referenceValue: number | null;
  timeToCloseSec: number;
  mids: number[];
  weatherProvider: WeatherProbabilityProvider;
  sportsProvider: SportsProbabilityProvider;
  marketQuestion: string;
  marketCategory?: string;
}): Promise<ProbabilityEstimate> {
  const reasons: string[] = [];
  const implied = clamp(input.impliedPrice, 0.01, 0.99);

  if (input.kind === "weather") {
    const p = await input.weatherProvider.getProbability({
      market: {
        marketId: "",
        ticker: "",
        question: input.marketQuestion,
        expiryTs: Date.now() + input.timeToCloseSec * 1000,
        category: input.marketCategory
      },
      threshold: input.rules.threshold,
      relation: input.rules.relation,
      horizonSec: input.timeToCloseSec
    });
    if (p) {
      const pModel = input.side === "YES" ? p.p : 1 - p.p;
      return { pModel: clamp(pModel, 0, 1), confidence: clamp(p.confidence, 0, 1), reasons: [p.reason], kind: input.kind };
    }
    reasons.push("weather provider unavailable");
  }

  if (input.kind === "sports") {
    const p = await input.sportsProvider.getProbability({
      market: {
        marketId: "",
        ticker: "",
        question: input.marketQuestion,
        expiryTs: Date.now() + input.timeToCloseSec * 1000,
        category: input.marketCategory
      },
      side: input.side,
      horizonSec: input.timeToCloseSec
    });
    if (p) {
      return { pModel: clamp(p.p, 0, 1), confidence: clamp(p.confidence, 0, 1), reasons: [p.reason], kind: input.kind };
    }
    reasons.push("sports provider unavailable");
  }

  if (
    input.kind === "threshold" &&
    input.rules.reliableThreshold &&
    Number.isFinite(input.rules.threshold) &&
    input.rules.threshold != null &&
    input.rules.relation &&
    Number.isFinite(input.referenceValue)
  ) {
    const sigma = estimateVolatilityFromMids(input.mids);
    const s0 = Math.max(1e-6, input.referenceValue as number);
    const k = Math.max(1e-6, input.rules.threshold as number);
    const tYears = Math.max(input.timeToCloseSec, 1) / (365 * 24 * 60 * 60);
    const stdev = Math.max(1e-8, sigma * Math.sqrt(tYears));
    const mu = Math.log(s0) - 0.5 * sigma * sigma * tYears;
    const z = (Math.log(k) - mu) / stdev;
    const pAbove = 1 - normalCdf(z);
    const pYes = input.rules.relation === "ABOVE" ? pAbove : 1 - pAbove;
    const pModel = input.side === "YES" ? pYes : 1 - pYes;
    const confidence = clamp(0.45 + Math.min(input.mids.length, 30) / 100 + Math.max(0, 0.02 - sigma) * 5, 0.1, 0.9);
    reasons.push("GBM threshold estimate");
    return { pModel: clamp(pModel, 0, 1), confidence, reasons, kind: input.kind };
  }

  reasons.push("fallback to implied probability");
  return {
    pModel: implied,
    confidence: 0.2,
    reasons,
    kind: input.kind
  };
}
