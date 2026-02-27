export type StrikeParseResult = {
  strike: number | null;
  relation: "ABOVE" | "BELOW" | null;
  reliable: boolean;
  reason: string;
};

function normalizeNumberToken(token: string): number | null {
  const t = token.replace(/[$,]/g, "").trim().toLowerCase();
  if (!t) return null;
  const k = t.endsWith("k");
  const base = Number(k ? t.slice(0, -1) : t);
  if (!Number.isFinite(base)) return null;
  return k ? base * 1000 : base;
}

export function parseStrikeFromQuestion(question: string): StrikeParseResult {
  const q = (question || "").trim();
  if (!q) return { strike: null, relation: null, reliable: false, reason: "empty question" };

  const lower = q.toLowerCase();
  const hasAbove = /(above|over|greater than)/i.test(lower);
  const hasBelow = /(below|under|less than)/i.test(lower);
  let relation: "ABOVE" | "BELOW" | null = null;
  if (hasAbove && !hasBelow) relation = "ABOVE";
  if (hasBelow && !hasAbove) relation = "BELOW";
  if (!relation) return { strike: null, relation: null, reliable: false, reason: "no clear above/below relation" };

  const all = [...q.matchAll(/\$?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+(?:\.[0-9]+)?k?)/gi)]
    .map((m) => normalizeNumberToken(m[1]))
    .filter((n): n is number => n != null && n > 1000);

  if (!all.length) {
    return { strike: null, relation, reliable: false, reason: "no numeric strike found" };
  }

  const strike = all[0];
  return { strike, relation, reliable: true, reason: "ok" };
}

export function isSafeDirectionSatisfied(params: {
  relation: "ABOVE" | "BELOW";
  side: "YES" | "NO";
  spot: number;
  strike: number;
  bufferUsd: number;
}): boolean {
  const { relation, side, spot, strike, bufferUsd } = params;

  if (relation === "ABOVE") {
    if (side === "YES") return spot >= strike + bufferUsd;
    return spot <= strike - bufferUsd;
  }

  if (side === "YES") return spot <= strike - bufferUsd;
  return spot >= strike + bufferUsd;
}
