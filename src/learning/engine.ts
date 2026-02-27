import { bindDecisionExecution, insertDecisionLog, insertPromotionEvent, insertStrategyVersionSnapshot, resolveDecisionOutcomeByPosition } from "../db/db";
import { getLearningProfileMetrics, getTopAttributionCauses } from "../db/queries";
import type { RuntimeBotConfig } from "../settings/runtimeConfig";

export type ProfileParams = {
  timeWindowSec: number;
  minQualityScore: number;
  minEdge: number;
  minFillProb: number;
};

export type ProfileName = "champion" | "cautious" | "opportunistic";

export class LearningEngine {
  private activeProfile: ProfileName = "champion";
  private lastPromotionEvalTs = 0;
  private readonly minResolvedForPromotion = 30;
  private readonly minScoreLift = 0.5;
  private readonly promotionCooldownMs = 15 * 60 * 1000;

  constructor(initialProfile?: string) {
    if (initialProfile === "champion" || initialProfile === "cautious" || initialProfile === "opportunistic") {
      this.activeProfile = initialProfile;
    }
  }

  getActiveProfile(): ProfileName {
    return this.activeProfile;
  }

  getProfileSet(base: RuntimeBotConfig): Array<{ name: ProfileName; params: ProfileParams; champion: boolean }> {
    const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
    const champion: ProfileParams = {
      timeWindowSec: base.timeWindowSec,
      minQualityScore: base.minQualityScore,
      minEdge: base.minEdge,
      minFillProb: base.minFillProb
    };
    const cautious: ProfileParams = {
      timeWindowSec: clamp(Math.round(base.timeWindowSec * 0.75), 5, 90),
      minQualityScore: clamp(base.minQualityScore + 10, 0, 100),
      minEdge: clamp(base.minEdge + 0.01, 0, 1),
      minFillProb: clamp(base.minFillProb + 0.1, 0, 1)
    };
    const opportunistic: ProfileParams = {
      timeWindowSec: clamp(Math.round(base.timeWindowSec * 1.5), 5, 120),
      minQualityScore: clamp(base.minQualityScore - 10, 0, 100),
      minEdge: clamp(base.minEdge - 0.01, 0, 1),
      minFillProb: clamp(base.minFillProb - 0.1, 0, 1)
    };
    return [
      { name: "champion", params: champion, champion: this.activeProfile === "champion" },
      { name: "cautious", params: cautious, champion: this.activeProfile === "cautious" },
      { name: "opportunistic", params: opportunistic, champion: this.activeProfile === "opportunistic" }
    ];
  }

  getEffectiveRuntime(base: RuntimeBotConfig): RuntimeBotConfig {
    const active = this.getProfileSet(base).find((x) => x.name === this.activeProfile)!;
    return {
      ...base,
      timeWindowSec: active.params.timeWindowSec,
      minQualityScore: active.params.minQualityScore,
      minEdge: active.params.minEdge,
      minFillProb: active.params.minFillProb
    };
  }

  logDecision(input: {
    profile: string;
    isChampion: boolean;
    marketId: string;
    side: "YES" | "NO" | null;
    action: "BUY" | "NOOP";
    reason: string;
    tteSec: number;
    price?: number | null;
    sizeUsd?: number | null;
    qualityScore?: number;
    edge?: number;
    fillProb?: number;
    expectedCost?: number;
    impliedPrice?: number;
    pModel?: number | null;
    config?: unknown;
    raw?: unknown;
  }): number {
    return insertDecisionLog({
      profile: input.profile,
      isChampion: input.isChampion,
      marketId: input.marketId,
      side: input.side,
      action: input.action,
      reason: input.reason,
      tteSec: input.tteSec,
      price: input.price,
      sizeUsd: input.sizeUsd,
      qualityScore: input.qualityScore,
      edge: input.edge,
      fillProb: input.fillProb,
      expectedCost: input.expectedCost,
      impliedPrice: input.impliedPrice,
      pModel: input.pModel,
      config: input.config,
      raw: input.raw
    });
  }

  bindExecution(decisionId: number, orderId: number, positionId?: number): void {
    bindDecisionExecution(decisionId, { orderId, positionId });
  }

  recordResolved(input: {
    positionId: number;
    marketId: string;
    outcome: "WIN" | "LOSS";
    pnlUsd: number;
    edge?: number;
    fillProb?: number;
    qualityScore?: number;
    driftMsEstimate?: number | null;
  }): void {
    const causes: string[] = [];
    if (input.outcome === "LOSS") {
      if ((input.edge ?? 0) <= 0) causes.push("negative_or_zero_edge");
      if ((input.fillProb ?? 1) < 0.5) causes.push("low_fill_probability");
      if ((input.qualityScore ?? 100) < 60) causes.push("low_market_quality");
      if (Math.abs(input.driftMsEstimate ?? 0) > 500) causes.push("clock_drift_timing_risk");
    } else {
      causes.push("edge_and_execution_positive");
    }
    const rootCause = causes[0] ?? "unknown";
    resolveDecisionOutcomeByPosition(input.positionId, input.outcome, input.pnlUsd, input.marketId, rootCause, {
      causes,
      edge: input.edge ?? null,
      fillProb: input.fillProb ?? null,
      qualityScore: input.qualityScore ?? null,
      driftMsEstimate: input.driftMsEstimate ?? null
    });
  }

  maybePromote(base: RuntimeBotConfig): { changed: boolean; profile: ProfileName; reason?: string } {
    const now = Date.now();
    if (now - this.lastPromotionEvalTs < this.promotionCooldownMs) {
      return { changed: false, profile: this.activeProfile };
    }
    this.lastPromotionEvalTs = now;

    const metrics = getLearningProfileMetrics(7 * 24);
    if (!metrics.length) return { changed: false, profile: this.activeProfile };
    const byProfile = new Map(metrics.map((m) => [m.profile, m]));

    const current = byProfile.get(this.activeProfile);
    const challengerCandidates = metrics.filter((m) => m.profile !== this.activeProfile && m.resolved >= this.minResolvedForPromotion);
    const bestChallenger = challengerCandidates.sort((a, b) => b.score - a.score)[0];

    // Rollback trigger: active profile under water with meaningful sample.
    if (current && current.resolved >= this.minResolvedForPromotion && current.pnlUsd < -5 && current.maxDrawdownUsd > 10) {
      const fallback: ProfileName = "cautious";
      if (fallback !== this.activeProfile) {
        const prev = this.activeProfile;
        this.activeProfile = fallback;
        insertPromotionEvent({
          fromProfile: prev,
          toProfile: fallback,
          reason: "auto_rollback_drawdown",
          metrics: { current }
        });
        return { changed: true, profile: fallback, reason: "auto rollback on drawdown" };
      }
    }

    if (current && bestChallenger && bestChallenger.score >= current.score + this.minScoreLift) {
      const next = bestChallenger.profile as ProfileName;
      const prev = this.activeProfile;
      this.activeProfile = next;
      insertPromotionEvent({
        fromProfile: prev,
        toProfile: next,
        reason: "challenger_outperformed",
        metrics: { current, challenger: bestChallenger }
      });
      return { changed: true, profile: next, reason: "challenger outperformed champion" };
    }

    // Snapshot metrics for observability even when no promotion occurs.
    const profileSet = this.getProfileSet(base);
    for (const p of profileSet) {
      const m = byProfile.get(p.name) ?? {
        profile: p.name,
        decisions: 0,
        trades: 0,
        resolved: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        pnlUsd: 0,
        maxDrawdownUsd: 0,
        score: 0
      };
      insertStrategyVersionSnapshot({
        profile: p.name,
        role: p.name === this.activeProfile ? "champion" : "challenger",
        params: p.params,
        sampleSize: m.resolved,
        wins: m.wins,
        losses: m.losses,
        pnlUsd: m.pnlUsd,
        maxDrawdownUsd: m.maxDrawdownUsd,
        score: m.score,
        promoted: false
      });
    }

    return { changed: false, profile: this.activeProfile };
  }

  getStatus(hours = 24): Record<string, unknown> {
    return {
      activeProfile: this.activeProfile,
      metrics: getLearningProfileMetrics(hours),
      topAttributionCauses: getTopAttributionCauses(10)
    };
  }
}
