import type { SportsProbabilityProvider } from "./sports";
import { detectMatchupTeams, parseSportsMarket, type ParsedSportsLeg, type SportsStatType } from "../parsing/sportsEntityParser";

type CacheRow<T> = { value: T; expiresAt: number };

type LegEstimate = {
  p: number;
  confidence: number;
  reason: string;
  entityKey?: string;
  eventKey?: string;
};

type EspnEventView = {
  id: string;
  league: string;
  teams: Array<{ name: string; norm: string; isHome: boolean; winPct?: number }>;
  homeMoneyline?: number;
  awayMoneyline?: number;
};

const TEAM_STOPWORDS = new Set(["yes", "no", "the", "fc", "cf", "sc", "ac"]);
const TEAM_ALIAS_MAP: Record<string, string> = {
  "la lakers": "los angeles lakers",
  "los angeles l": "los angeles lakers",
  "la clippers": "los angeles clippers",
  "los angeles c": "los angeles clippers",
  "ny knicks": "new york knicks",
  "ny nets": "brooklyn nets",
  "gsw": "golden state warriors",
  "okc": "oklahoma city thunder",
  "phx": "phoenix suns",
  "nop": "new orleans pelicans",
  "sa": "san antonio spurs"
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function normalizeText(s: string): string {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeTeam(s: string): string[] {
  const n = TEAM_ALIAS_MAP[normalizeText(s)] ?? normalizeText(s);
  return n
    .split(" ")
    .filter((t) => t && !TEAM_STOPWORDS.has(t));
}

function overlapScore(a: string, b: string): number {
  const ta = tokenizeTeam(a);
  const tb = tokenizeTeam(b);
  if (!ta.length || !tb.length) return 0;
  const sb = new Set(tb);
  const shared = ta.filter((t) => sb.has(t)).length;
  const base = shared / Math.max(ta.length, tb.length);
  if (base <= 0) return 0;
  // Boost when one side is near-prefix of the other token list.
  const joinedA = ta.join(" ");
  const joinedB = tb.join(" ");
  const prefixBoost = joinedA.startsWith(joinedB) || joinedB.startsWith(joinedA) ? 0.12 : 0;
  return clamp(base + prefixBoost, 0, 1);
}

function americanToProb(odds: number): number {
  if (!Number.isFinite(odds) || odds === 0) return 0.5;
  if (odds > 0) return 100 / (odds + 100);
  return Math.abs(odds) / (Math.abs(odds) + 100);
}

function readWinPct(raw: any): number | undefined {
  const records: any[] = Array.isArray(raw?.records) ? raw.records : [];
  for (const r of records) {
    const p = Number(r?.summary?.split("-")?.[0] ?? NaN);
    const q = Number(r?.summary?.split("-")?.[1] ?? NaN);
    if (Number.isFinite(p) && Number.isFinite(q) && p + q > 0) return p / (p + q);
  }
  return undefined;
}

function logisticOver(x: number, center: number, steepness: number): number {
  return 1 / (1 + Math.exp((x - center) / steepness));
}

function inferLeagueProfiles(question: string): Array<readonly [string, string]> {
  const q = normalizeText(question);
  const profiles: Array<readonly [string, string]> = [];
  if (/\bnba\b|points|rebounds|assists|threes|knicks|lakers|celtics|warriors|spurs|thunder/.test(q)) {
    profiles.push(["basketball", "nba"]);
    profiles.push(["basketball", "mens-college-basketball"]);
  }
  if (/\bnfl\b|touchdown|passing|rushing|receiving|yard/.test(q)) profiles.push(["football", "nfl"]);
  if (/\bmlb\b|strikeouts|innings|runs|hits/.test(q)) profiles.push(["baseball", "mlb"]);
  if (/\bnhl\b|hockey|goals scored/.test(q)) profiles.push(["hockey", "nhl"]);
  if (/\bsoccer\b|both teams to score|goals/.test(q)) profiles.push(["soccer", "usa.1"]);
  if (!profiles.length) {
    profiles.push(["basketball", "nba"]);
    profiles.push(["football", "nfl"]);
    profiles.push(["baseball", "mlb"]);
    profiles.push(["hockey", "nhl"]);
    profiles.push(["soccer", "usa.1"]);
  }
  return profiles;
}

async function fetchJson(url: string): Promise<any> {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "openclaw-kalshi-bot/2.0",
      Accept: "application/json"
    }
  });
  if (!resp.ok) return null;
  return resp.json();
}

function playerPropBaseProbability(stat: SportsStatType | undefined, threshold: number): number {
  const t = Number(threshold);
  if (!Number.isFinite(t)) return 0.5;
  if (stat === "POINTS") return clamp(logisticOver(t, 19, 4.8), 0.03, 0.97);
  if (stat === "REBOUNDS") return clamp(logisticOver(t, 6.5, 2.1), 0.03, 0.97);
  if (stat === "ASSISTS") return clamp(logisticOver(t, 5.5, 1.9), 0.03, 0.97);
  if (stat === "THREES") return clamp(logisticOver(t, 2.5, 1.2), 0.03, 0.97);
  if (stat === "PASS_YDS") return clamp(logisticOver(t, 235, 55), 0.03, 0.97);
  if (stat === "RUSH_YDS") return clamp(logisticOver(t, 68, 22), 0.03, 0.97);
  if (stat === "REC_YDS") return clamp(logisticOver(t, 62, 25), 0.03, 0.97);
  return clamp(logisticOver(t, 15, 5), 0.03, 0.97);
}

export class EspnSportsProvider implements SportsProbabilityProvider {
  id = "espn";
  private readonly cache = new Map<string, CacheRow<any>>();

  private getCached<T>(key: string): T | null {
    const row = this.cache.get(key);
    if (!row) return null;
    if (Date.now() > row.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return row.value as T;
  }

  private setCached(key: string, value: unknown, ttlMs: number): void {
    this.cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  private async loadEvents(question: string): Promise<EspnEventView[]> {
    const profiles = inferLeagueProfiles(question);
    const rows = await Promise.all(
      profiles.map(async ([sport, league]) => {
        const key = `${sport}/${league}`;
        const cached = this.getCached<any>(key);
        const json = cached ?? (await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/scoreboard`));
        if (!json) return [] as EspnEventView[];
        if (!cached) this.setCached(key, json, 60_000);
        const events: any[] = Array.isArray(json?.events) ? json.events : [];
        return events
          .map((ev): EspnEventView | null => {
            const comp = ev?.competitions?.[0];
            const competitors: any[] = Array.isArray(comp?.competitors) ? comp.competitors : [];
            if (competitors.length < 2) return null;
            const teams = competitors.map((c: any) => ({
              name: String(c?.team?.displayName ?? c?.team?.name ?? ""),
              norm: normalizeText(c?.team?.displayName ?? c?.team?.name ?? ""),
              isHome: String(c?.homeAway ?? "").toLowerCase() === "home",
              winPct: readWinPct(c)
            }));
            const odds = comp?.odds?.[0] ?? {};
            const homeMl = Number(odds?.homeTeamOdds?.moneyLine ?? NaN);
            const awayMl = Number(odds?.awayTeamOdds?.moneyLine ?? NaN);
            return {
              id: String(ev?.id ?? ""),
              league: `${sport}/${league}`,
              teams,
              homeMoneyline: Number.isFinite(homeMl) ? homeMl : undefined,
              awayMoneyline: Number.isFinite(awayMl) ? awayMl : undefined
            };
          })
          .filter((x: EspnEventView | null): x is EspnEventView => x != null);
      })
    );
    return rows.flat();
  }

  private findEventForTeam(team: string, events: EspnEventView[]): { ev: EspnEventView; teamIdx: number } | null {
    let best: { score: number; ev: EspnEventView; idx: number } | null = null;
    for (const ev of events) {
      for (let i = 0; i < ev.teams.length; i += 1) {
        const score = overlapScore(team, ev.teams[i].name);
        if (score <= 0.45) continue;
        if (!best || score > best.score) best = { score, ev, idx: i };
      }
    }
    return best ? { ev: best.ev, teamIdx: best.idx } : null;
  }

  private findEventFromMatchup(question: string, events: EspnEventView[]): EspnEventView | null {
    const pair = detectMatchupTeams(question);
    if (!pair) return null;
    let best: { score: number; ev: EspnEventView } | null = null;
    for (const ev of events) {
      if (ev.teams.length < 2) continue;
      const s1 = overlapScore(pair.homeOrLeft, ev.teams[0].name) + overlapScore(pair.awayOrRight, ev.teams[1].name);
      const s2 = overlapScore(pair.homeOrLeft, ev.teams[1].name) + overlapScore(pair.awayOrRight, ev.teams[0].name);
      const score = Math.max(s1, s2) / 2;
      if (score < 0.35) continue;
      if (!best || score > best.score) best = { score, ev };
    }
    return best?.ev ?? null;
  }

  private estimateTeamWin(leg: ParsedSportsLeg, events: EspnEventView[]): LegEstimate {
    if (!leg.team) return { p: 0.5, confidence: 0.25, reason: "missing team parse" };
    const found = this.findEventForTeam(leg.team, events);
    if (!found) return { p: 0.5, confidence: 0.28, reason: "team not matched in ESPN scoreboard", entityKey: normalizeText(leg.team) };
    const home = found.ev.teams.find((t) => t.isHome);
    const away = found.ev.teams.find((t) => !t.isHome);
    const team = found.ev.teams[found.teamIdx];
    let p = 0.5;
    let conf = 0.45;
    let reason = "ESPN record baseline";
    if (Number.isFinite(found.ev.homeMoneyline) || Number.isFinite(found.ev.awayMoneyline)) {
      const pHome = Number.isFinite(found.ev.homeMoneyline) ? americanToProb(found.ev.homeMoneyline as number) : 0.5;
      const pAway = Number.isFinite(found.ev.awayMoneyline) ? americanToProb(found.ev.awayMoneyline as number) : 0.5;
      const z = pHome + pAway;
      const homeNorm = z > 0 ? pHome / z : 0.5;
      p = team.isHome ? homeNorm : 1 - homeNorm;
      conf = 0.68;
      reason = "ESPN moneyline model";
    } else if (Number.isFinite(team.winPct) && Number.isFinite(home?.winPct) && Number.isFinite(away?.winPct)) {
      const tw = team.winPct as number;
      const ow = team.isHome ? (away?.winPct as number) : (home?.winPct as number);
      p = clamp(0.5 + (tw - ow) * 0.9 + (team.isHome ? 0.03 : -0.03), 0.1, 0.9);
      conf = 0.56;
    }
    return { p, confidence: conf, reason, entityKey: normalizeText(leg.team), eventKey: found.ev.id };
  }

  private estimateLeg(leg: ParsedSportsLeg, events: EspnEventView[], question: string): LegEstimate {
    if (leg.type === "TEAM_WIN") return this.estimateTeamWin(leg, events);
    if (leg.type === "TEAM_MARGIN" || leg.type === "TEAM_SPREAD") {
      const base = this.estimateTeamWin({ ...leg, type: "TEAM_WIN" }, events);
      const line = Number(leg.threshold ?? 0);
      const marginMult = clamp(Math.exp(-Math.max(0, line) / 7.5), 0.2, 1);
      return {
        ...base,
        p: clamp(base.p * marginMult, 0.01, 0.99),
        confidence: clamp(base.confidence - 0.05, 0.2, 0.9),
        reason: `${base.reason}; margin adjustment`
      };
    }
    if (leg.type === "TOTAL_OVER" || leg.type === "TOTAL_UNDER") {
      const th = Number(leg.threshold ?? NaN);
      if (!Number.isFinite(th)) return { p: 0.5, confidence: 0.25, reason: "missing total threshold" };
      const ev = this.findEventFromMatchup(question, events);
      const mean = ev?.league.includes("basketball") ? 226 : ev?.league.includes("soccer") ? 2.6 : 5.5;
      const spread = ev?.league.includes("basketball") ? 18 : ev?.league.includes("soccer") ? 1.1 : 1.8;
      const over = clamp(logisticOver(th, mean, spread), 0.03, 0.97);
      const p = leg.type === "TOTAL_OVER" ? over : 1 - over;
      return { p, confidence: 0.42, reason: "league/event total model" };
    }
    if (leg.type === "BTTS") {
      return { p: 0.56, confidence: 0.4, reason: "soccer BTTS baseline model" };
    }
    if (leg.type === "PLAYER_PROP") {
      const p = playerPropBaseProbability(leg.stat ?? "UNKNOWN", Number(leg.threshold ?? NaN));
      const key = `${normalizeText(leg.player ?? "")}:${leg.stat ?? "UNKNOWN"}`;
      const confBoost = clamp(Number(leg.confidence ?? 0), 0, 1) * 0.15;
      return { p, confidence: clamp(0.35 + confBoost, 0.2, 0.7), reason: "player prop semantic prior model", entityKey: key };
    }
    return { p: 0.5, confidence: 0.2, reason: "unknown leg type" };
  }

  async getProbability(input: {
    market: { question: string };
    side: "YES" | "NO";
    horizonSec: number;
  }): Promise<{ p: number; confidence: number; reason: string } | null> {
    const legs = parseSportsMarket(input.market.question);
    if (!legs.length) return null;
    const events = await this.loadEvents(input.market.question);
    const legEstimates = legs.map((leg) => {
      const est = this.estimateLeg(leg, events, input.market.question);
      const pLeg = leg.polarity === "NO" ? 1 - est.p : est.p;
      return { ...est, p: clamp(pLeg, 0.01, 0.99), leg };
    });
    const rawProduct = legEstimates.reduce((acc, e) => acc * e.p, 1);
    const uniqueEntities = new Set(legEstimates.map((e) => e.entityKey).filter(Boolean)).size;
    const dupEntityPenalty = Math.max(0, legEstimates.length - uniqueEntities);
    const uniqueEvents = new Set(legEstimates.map((e) => e.eventKey).filter(Boolean)).size;
    const sameEventPenalty = uniqueEvents > 0 ? Math.max(0, legEstimates.length - uniqueEvents) : 0;
    const correlationPenalty = clamp(1 - 0.04 * dupEntityPenalty - 0.03 * sameEventPenalty, 0.72, 1);
    const pYes = clamp(rawProduct * correlationPenalty, 0.001, 0.999);
    const avgConf = legEstimates.reduce((a, b) => a + b.confidence, 0) / Math.max(1, legEstimates.length);
    const confidence = clamp(avgConf * clamp(1 - 0.03 * Math.max(0, legs.length - 1), 0.65, 1), 0.15, 0.9);
    const p = input.side === "YES" ? pYes : 1 - pYes;
    const sampled = legEstimates.slice(0, 3).map((e) => `${e.leg.type}:${e.reason}`);
    return {
      p: clamp(p, 0, 1),
      confidence,
      reason: `ESPN parlay model legs=${legs.length}; corrAdj=${correlationPenalty.toFixed(2)}; ${sampled.join(" | ")}`
    };
  }
}
