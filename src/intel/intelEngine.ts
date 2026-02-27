import type { ParsedRules, NormalizedMarket, OrderbookState } from "../plugins/types";
import { config } from "../config";
import { classifyMarket } from "./marketTypeClassifier";
import { qualityScore } from "./qualityScore";
import { CryptoProbabilityEngine } from "./cryptoProbabilityEngine";
import { WeatherProbabilityEngine } from "./weatherProbabilityEngine";
import { executionModel } from "./executionModel";
import { edgeGate } from "./edgeGate";
import { buildSportsProvider, buildWeatherProvider } from "../intelligence/providers/factory";
import { computeProbabilityEstimate, inferMarketKind } from "../intelligence/probabilityEngine";

export type IntelEvaluation = {
  tradeable: boolean;
  parsed: ReturnType<typeof classifyMarket>;
  quality: ReturnType<typeof qualityScore>;
  pModel: number | null;
  confidence: number;
  impliedPrice: number;
  fillProb: number;
  expectedCost: number;
  edge: number;
  reasons: string[];
  weatherSnapshot?: unknown;
  modelInputs?: Record<string, unknown>;
};

export class MarketIntelligenceLayer {
  private readonly crypto = new CryptoProbabilityEngine();
  private readonly weather: WeatherProbabilityEngine;
  private readonly midHistory = new Map<string, number[]>();
  private readonly sportsProvider = buildSportsProvider();
  private readonly weatherProvider = buildWeatherProvider();

  constructor(opts?: { weatherEnabled?: boolean }) {
    this.weather = new WeatherProbabilityEngine(opts?.weatherEnabled ?? config.weatherEnable);
  }

  updateCryptoTick(symbol: "BTC" | "ETH", price: number): void {
    this.crypto.updateTick(symbol, price);
  }

  getCryptoEngine(): CryptoProbabilityEngine {
    return this.crypto;
  }

  private trackMid(marketId: string, mid: number): { volatility: number; momentum: number; samples: number } {
    const arr = this.midHistory.get(marketId) ?? [];
    arr.push(mid);
    if (arr.length > 40) arr.shift();
    this.midHistory.set(marketId, arr);
    if (arr.length < 2) return { volatility: 0, momentum: 0, samples: arr.length };
    const deltas: number[] = [];
    for (let i = 1; i < arr.length; i += 1) deltas.push(arr[i] - arr[i - 1]);
    const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    const variance = deltas.reduce((a, b) => a + (b - mean) * (b - mean), 0) / Math.max(1, deltas.length - 1);
    return { volatility: Math.sqrt(Math.max(variance, 0)), momentum: arr[arr.length - 1] - arr[0], samples: arr.length };
  }

  private genericProbability(input: {
    market: NormalizedMarket;
    orderbook: OrderbookState;
    side: "YES" | "NO";
    timeToCloseSec: number;
  }): { pModel: number; confidence: number; reason: string; modelInputs: Record<string, unknown> } {
    const impliedYesFromAsk = Number.isFinite(input.orderbook.bestAskYes) ? input.orderbook.bestAskYes : NaN;
    const impliedYesFromNo = Number.isFinite(input.orderbook.bestAskNo) ? 1 - input.orderbook.bestAskNo : NaN;
    const impliedYes = Number.isFinite(impliedYesFromAsk)
      ? impliedYesFromAsk
      : Number.isFinite(impliedYesFromNo)
        ? impliedYesFromNo
        : 0.5;
    const mid = Math.max(0.01, Math.min(0.99, impliedYes));
    const hist = this.trackMid(input.market.marketId, mid);

    const levels = input.orderbook.levels;
    const yesDepthBid = levels?.yesBids?.slice(0, 4).reduce((a, b) => a + b.count, 0) ?? 0;
    const noDepthBid = levels?.noBids?.slice(0, 4).reduce((a, b) => a + b.count, 0) ?? 0;
    const totalDepth = yesDepthBid + noDepthBid;
    const depthImbalance = totalDepth > 0 ? (yesDepthBid - noDepthBid) / totalDepth : 0;
    const spread = Math.abs(input.orderbook.spreadHint ?? 0);
    const closeWeight = Math.max(0, Math.min(1, 1 - input.timeToCloseSec / 3600));
    const volPenalty = Math.max(0, Math.min(1, hist.volatility / 0.03));
    const momentumBoost = Math.max(-0.04, Math.min(0.04, hist.momentum * 0.6));
    const microAdjust = 0.08 * depthImbalance * closeWeight + momentumBoost - 0.03 * volPenalty;
    const pYes = Math.max(0.01, Math.min(0.99, impliedYes + microAdjust));
    const pModel = input.side === "YES" ? pYes : 1 - pYes;
    const confidence = Math.max(
      0.2,
      Math.min(
        0.75,
        0.25 +
          0.25 * Math.min(1, hist.samples / 20) +
          0.2 * Math.min(1, totalDepth / 800) +
          0.15 * (1 - Math.min(1, spread / 0.08))
      )
    );

    return {
      pModel,
      confidence,
      reason: "generic binary microstructure model",
      modelInputs: {
        impliedYes,
        depthImbalance,
        spread,
        totalDepth,
        momentum: hist.momentum,
        volatility: hist.volatility
      }
    };
  }

  async evaluate(input: {
    market: NormalizedMarket;
    orderbook: OrderbookState;
    rules: ParsedRules;
    side: "YES" | "NO";
    sizeUsd: number;
    targetPrice: number;
    timeToCloseSec: number;
    recentFillRate: number;
    feeRate: number;
    minEdge: number;
    minFillProb: number;
    minQualityScore: number;
  }): Promise<IntelEvaluation> {
    const parsed = classifyMarket(input.market.question, input.market.expiryTs);
    const impliedYesFromAsk = Number.isFinite(input.orderbook.bestAskYes) ? input.orderbook.bestAskYes : NaN;
    const impliedYesFromNo = Number.isFinite(input.orderbook.bestAskNo) ? 1 - input.orderbook.bestAskNo : NaN;
    const impliedYesMid = Number.isFinite(impliedYesFromAsk)
      ? impliedYesFromAsk
      : Number.isFinite(impliedYesFromNo)
        ? impliedYesFromNo
        : 0.5;
    this.trackMid(input.market.marketId, Math.max(0.01, Math.min(0.99, impliedYesMid)));

    const spread = Math.abs(input.orderbook.spreadHint ?? 0);
    const impliedPrice = input.side === "YES" ? input.orderbook.bestAskYes : input.orderbook.bestAskNo;
    const requiredContracts = input.sizeUsd / Math.max(input.targetPrice, 1e-6);
    const depthNearTarget = input.side === "YES" ? input.orderbook.liquidityYesShares : input.orderbook.liquidityNoShares;

    const q = qualityScore({
      parsed,
      spread,
      depthNearTarget,
      requiredDepth: requiredContracts,
      volume: Number(input.market.volume ?? 0),
      timeToCloseSec: input.timeToCloseSec,
      question: input.market.question
    });

    let pModel: number | null = null;
    let confidence = 0;
    let modelReason = "";
    let weatherSnapshot: unknown;
    let modelInputs: Record<string, unknown> | undefined;

    if (parsed.marketType === "CRYPTO_THRESHOLD" || parsed.marketType === "CRYPTO_TOUCH") {
      const r = this.crypto.evaluateMarket({ parsed, timeToCloseSec: input.timeToCloseSec });
      pModel = r.pModel;
      confidence = r.confidence;
      modelReason = r.reason;
      if (parsed.underlying) {
        modelInputs = {
          spot: this.crypto.getCryptoSpot(parsed.underlying),
          vol: this.crypto.getVolEstimate(parsed.underlying),
          threshold: parsed.threshold,
          timeToCloseSec: input.timeToCloseSec
        };
      }
    } else if (parsed.marketType.startsWith("WEATHER")) {
      const wr = await this.weather.evaluate(parsed, Date.now());
      pModel = wr.pModel;
      confidence = wr.confidence;
      modelReason = wr.reason;
      weatherSnapshot = wr.snapshot;
      modelInputs = {
        threshold: parsed.threshold,
        location: parsed.location,
        windowStartTs: parsed.windowStartTs,
        windowEndTs: parsed.windowEndTs
      };
    }

    if (!parsed.tradeable) {
      modelReason = `skip: ${parsed.reasons.join("; ")}`;
    }

    const mids = (this.midHistory.get(input.market.marketId) ?? []).slice(-30);
    const extKind = inferMarketKind(
      input.market.category,
      `${input.market.question} ${input.market.eventTitle ?? ""} ${input.market.marketTitle ?? ""} ${input.market.ticker ?? ""}`
    );
    if ((extKind === "weather" || extKind === "sports") && parsed.tradeable) {
      try {
        const extRules =
          extKind === "weather"
            ? {
                ...input.rules,
                threshold: Number.isFinite(parsed.threshold as number) ? parsed.threshold : input.rules.threshold,
                relation: parsed.relation ?? input.rules.relation,
                reliableThreshold: Number.isFinite(parsed.threshold as number) || input.rules.reliableThreshold
              }
            : input.rules;
        const ext = await computeProbabilityEstimate({
          kind: extKind,
          side: input.side,
          impliedPrice,
          rules: extRules,
          referenceValue: null,
          timeToCloseSec: input.timeToCloseSec,
          mids,
          weatherProvider: this.weatherProvider,
          sportsProvider: this.sportsProvider,
          marketQuestion: input.market.question,
          marketCategory: input.market.category
        });
        const shouldUseExt =
          Number.isFinite(ext.pModel) &&
          !(extKind === "weather" && ext.reasons.some((r) => /weather provider unavailable/i.test(r)));
        if (shouldUseExt) {
          pModel = ext.pModel;
          confidence = Math.max(confidence, ext.confidence);
          modelReason = ext.reasons.join("; ");
          modelInputs = {
            ...(modelInputs ?? {}),
            externalKind: ext.kind,
            providerWeather: this.weatherProvider.id,
            providerSports: this.sportsProvider.id
          };
        }
      } catch {
        // External provider failures must not break trading loop.
      }
    }

    if (pModel == null && parsed.tradeable) {
      const generic = this.genericProbability({
        market: input.market,
        orderbook: input.orderbook,
        side: input.side,
        timeToCloseSec: input.timeToCloseSec
      });
      pModel = generic.pModel;
      confidence = Math.max(confidence, generic.confidence);
      modelReason = generic.reason;
      modelInputs = { ...(modelInputs ?? {}), ...generic.modelInputs };
    }

    const exec = executionModel({
      depthAtTarget: depthNearTarget,
      requiredContracts,
      spread,
      recentFillRate: input.recentFillRate,
      feeRate: input.feeRate
    });

    const pEffective = Number.isFinite(pModel as number) ? (pModel as number) : impliedPrice;
    const gate = edgeGate({
      pModel: pEffective,
      impliedPrice,
      expectedCost: exec.expectedCost,
      minEdge: input.minEdge,
      fillProb: exec.fillProb,
      minFillProb: input.minFillProb,
      qualityScore: q.score,
      minQualityScore: input.minQualityScore
    });

    const reasons = [
      ...parsed.reasons,
      modelReason,
      ...q.reasons,
      ...exec.reasons,
      ...gate.reasons
    ];

    return {
      tradeable: gate.allowed && parsed.tradeable && Number.isFinite(pEffective),
      parsed,
      quality: q,
      pModel,
      confidence,
      impliedPrice,
      fillProb: exec.fillProb,
      expectedCost: exec.expectedCost,
      edge: gate.edge,
      reasons,
      weatherSnapshot,
      modelInputs
    };
  }
}
