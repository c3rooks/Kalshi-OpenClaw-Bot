export type SportsLegType =
  | "TEAM_WIN"
  | "TEAM_MARGIN"
  | "TEAM_SPREAD"
  | "TOTAL_OVER"
  | "TOTAL_UNDER"
  | "PLAYER_PROP"
  | "BTTS"
  | "UNKNOWN";

export type SportsStatType =
  | "POINTS"
  | "REBOUNDS"
  | "ASSISTS"
  | "THREES"
  | "PASS_YDS"
  | "RUSH_YDS"
  | "REC_YDS"
  | "GOALS"
  | "HITS"
  | "STRIKEOUTS"
  | "UNKNOWN";

export type ParsedSportsLeg = {
  raw: string;
  polarity: "YES" | "NO";
  type: SportsLegType;
  team?: string;
  player?: string;
  stat?: SportsStatType;
  threshold?: number;
  confidence: number;
};

function normalizeText(s: string): string {
  return String(s || "")
    .toLowerCase()
    .replace(/[^\w\s.+\-:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseNumber(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function detectStat(s: string): SportsStatType {
  const x = normalizeText(s);
  if (/\brebound/.test(x)) return "REBOUNDS";
  if (/\bassist/.test(x)) return "ASSISTS";
  if (/\b3\b|\bthree\b|\b3pt\b|\bthrees\b/.test(x)) return "THREES";
  if (/\bpassing\b|\bpass yds?\b|\bpass yards?\b/.test(x)) return "PASS_YDS";
  if (/\brushing\b|\brush yds?\b|\brush yards?\b/.test(x)) return "RUSH_YDS";
  if (/\breceiving\b|\brec yds?\b|\brec yards?\b/.test(x)) return "REC_YDS";
  if (/\bgoal/.test(x)) return "GOALS";
  if (/\bhits?\b/.test(x)) return "HITS";
  if (/\bstrikeouts?\b|\bks?\b/.test(x)) return "STRIKEOUTS";
  if (/\bpoints?\b/.test(x)) return "POINTS";
  return "UNKNOWN";
}

function cleanEntity(s: string): string {
  return String(s || "")
    .replace(/^yes\s+/i, "")
    .replace(/^no\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitLegs(question: string): string[] {
  const q = String(question || "").trim();
  if (!q) return [];
  if (/,(?=\s*(?:yes|no)\b)/i.test(q)) {
    return q.split(/,(?=\s*(?:yes|no)\b)/i).map((x) => x.trim()).filter(Boolean);
  }
  const byComma = q.split(/\s*,\s*/g).map((x) => x.trim()).filter(Boolean);
  if (byComma.length > 1) return byComma;
  if (/\sand\s/i.test(q) && /\byes\b|\bno\b/i.test(q)) {
    return q.split(/\s+and\s+/i).map((x) => x.trim()).filter(Boolean);
  }
  return [q];
}

function parseLeg(rawLeg: string): ParsedSportsLeg {
  let leg = String(rawLeg || "").trim();
  let polarity: "YES" | "NO" = "YES";
  if (/^yes\s+/i.test(leg)) {
    polarity = "YES";
    leg = leg.replace(/^yes\s+/i, "");
  } else if (/^no\s+/i.test(leg)) {
    polarity = "NO";
    leg = leg.replace(/^no\s+/i, "");
  }

  if (/both teams to score/i.test(leg)) {
    return { raw: rawLeg, polarity, type: "BTTS", confidence: 0.95 };
  }

  const total = leg.match(/^(over|under)\s+([0-9]+(?:\.[0-9]+)?)\s*(points?|goals?|runs?)?\s*(?:scored)?/i);
  if (total) {
    const stat = detectStat(total[3] ?? "points");
    return {
      raw: rawLeg,
      polarity,
      type: total[1].toLowerCase() === "over" ? "TOTAL_OVER" : "TOTAL_UNDER",
      threshold: parseNumber(total[2]),
      stat,
      confidence: 0.95
    };
  }

  const margin = leg.match(/^(.+?)\s+wins?\s+by\s+over\s+([0-9]+(?:\.[0-9]+)?)/i);
  if (margin) {
    return {
      raw: rawLeg,
      polarity,
      type: "TEAM_MARGIN",
      team: cleanEntity(margin[1]),
      threshold: parseNumber(margin[2]),
      confidence: 0.92
    };
  }

  const spread = leg.match(/^(.+?)\s*(?:[-+]\s*([0-9]+(?:\.[0-9]+)?))\s*(?:spread)?$/i);
  if (spread) {
    return {
      raw: rawLeg,
      polarity,
      type: "TEAM_SPREAD",
      team: cleanEntity(spread[1]),
      threshold: parseNumber(spread[2]),
      confidence: 0.65
    };
  }

  const playerA = leg.match(/^(.+?):\s*([0-9]+(?:\.[0-9]+)?)\+\s*(.*)$/i);
  if (playerA) {
    return {
      raw: rawLeg,
      polarity,
      type: "PLAYER_PROP",
      player: cleanEntity(playerA[1]),
      threshold: parseNumber(playerA[2]),
      stat: detectStat(playerA[3]),
      confidence: 0.96
    };
  }

  const playerB = leg.match(/^([A-Za-z][A-Za-z .'\-]{2,})\s+([0-9]+(?:\.[0-9]+)?)\+\s*(points?|rebounds?|assists?|threes?|passing|rushing|receiving|yards?|goals?|hits?|strikeouts?)?/i);
  if (playerB) {
    return {
      raw: rawLeg,
      polarity,
      type: "PLAYER_PROP",
      player: cleanEntity(playerB[1]),
      threshold: parseNumber(playerB[2]),
      stat: detectStat(playerB[3] ?? ""),
      confidence: 0.82
    };
  }

  const teamWin = leg.match(/^([A-Za-z][A-Za-z0-9 .'\-()&]{1,})$/);
  if (teamWin) {
    return {
      raw: rawLeg,
      polarity,
      type: "TEAM_WIN",
      team: cleanEntity(teamWin[1]),
      confidence: 0.62
    };
  }

  return { raw: rawLeg, polarity, type: "UNKNOWN", confidence: 0.1 };
}

export function parseSportsMarket(question: string): ParsedSportsLeg[] {
  const legs = splitLegs(question).map(parseLeg);
  return legs.length ? legs : [{ raw: question, polarity: "YES", type: "UNKNOWN", confidence: 0 }];
}

export function detectMatchupTeams(question: string): { homeOrLeft: string; awayOrRight: string } | null {
  const q = String(question || "");
  let m = q.match(/(.+?)\s+vs\.?\s+(.+?)(?:\?|,|$)/i);
  if (m) return { homeOrLeft: cleanEntity(m[1]), awayOrRight: cleanEntity(m[2]) };
  m = q.match(/(.+?)\s+@\s+(.+?)(?:\?|,|$)/i);
  if (m) return { homeOrLeft: cleanEntity(m[2]), awayOrRight: cleanEntity(m[1]) };
  m = q.match(/will\s+(.+?)\s+beat\s+(.+?)(?:\?|,|$)/i);
  if (m) return { homeOrLeft: cleanEntity(m[1]), awayOrRight: cleanEntity(m[2]) };
  return null;
}

