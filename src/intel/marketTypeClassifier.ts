export type MarketType =
  | "CRYPTO_THRESHOLD"
  | "CRYPTO_TOUCH"
  | "WEATHER_SNOW"
  | "WEATHER_RAIN"
  | "WEATHER_TEMP"
  | "GENERIC_BINARY";

export type ParsedMarketFields = {
  marketType: MarketType;
  underlying?: "BTC" | "ETH";
  threshold?: number;
  unit?: "USD" | "INCHES" | "MM" | "F" | "C";
  location?: string;
  relation?: "ABOVE" | "BELOW";
  windowStartTs?: number;
  windowEndTs?: number;
  closeTs?: number;
  tradeable: boolean;
  reasons: string[];
};

function parseNumberLike(s: string): number | undefined {
  const cleaned = s.replace(/[$,]/g, "").trim();
  if (!cleaned) return undefined;
  if (/k$/i.test(cleaned)) {
    const n = Number(cleaned.slice(0, -1));
    return Number.isFinite(n) ? n * 1000 : undefined;
  }
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

function parseThreshold(text: string): number | undefined {
  const m = text.match(/(?:above|below|over|under|reach|touch|at least|at most)\s*\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?k?)/i);
  if (!m) return undefined;
  return parseNumberLike(m[1]);
}

function parseUnit(text: string): ParsedMarketFields["unit"] {
  if (/(\$|usd|dollars?)/i.test(text)) return "USD";
  if (/(inches?|inch|\bin\b)/i.test(text)) return "INCHES";
  if (/\bmm\b/i.test(text)) return "MM";
  if (/(°?f|fahrenheit)/i.test(text)) return "F";
  if (/(°?c|celsius)/i.test(text)) return "C";
  return undefined;
}

function parseLocation(text: string): string | undefined {
  const ofMatch = text.match(/(?:in|at|for)\s+([A-Za-z][A-Za-z\s\-]+,\s*[A-Za-z]{2})/i);
  if (ofMatch) return ofMatch[1].trim();
  const usCity = text.match(/([A-Za-z][A-Za-z\s\-]+,\s*[A-Za-z]{2})/);
  return usCity ? usCity[1].trim() : undefined;
}

function parseTimeWindow(question: string, closeTs?: number): { windowStartTs?: number; windowEndTs?: number } {
  const out: { windowStartTs?: number; windowEndTs?: number } = {};
  const between = question.match(/between\s+([^,]+?)\s+and\s+([^,?.]+)/i);
  if (between) {
    const s = Date.parse(between[1]);
    const e = Date.parse(between[2]);
    if (Number.isFinite(s)) out.windowStartTs = s;
    if (Number.isFinite(e)) out.windowEndTs = e;
  }
  if (!out.windowEndTs && Number.isFinite(closeTs)) out.windowEndTs = closeTs;
  return out;
}

export function classifyMarket(question: string, closeTs?: number): ParsedMarketFields {
  const q = question || "";
  const lower = q.toLowerCase();
  const reasons: string[] = [];
  const hardErrors: string[] = [];

  const underlying = /\beth\b|ethereum/i.test(lower) ? "ETH" : /\bbtc\b|bitcoin/i.test(lower) ? "BTC" : undefined;

  const isWeather = /weather|rain|snow|temperature|temp|precip/i.test(lower);
  const isCrypto = !!underlying;

  let marketType: MarketType = "GENERIC_BINARY";
  if (isCrypto && /touch|reach|hit/i.test(lower)) marketType = "CRYPTO_TOUCH";
  else if (isCrypto && /above|below|over|under/i.test(lower)) marketType = "CRYPTO_THRESHOLD";
  else if (isWeather && /snow/i.test(lower)) marketType = "WEATHER_SNOW";
  else if (isWeather && /rain|precip/i.test(lower)) marketType = "WEATHER_RAIN";
  else if (isWeather && /temp|temperature|high|low/i.test(lower)) marketType = "WEATHER_TEMP";

  const threshold = parseThreshold(q);
  const relation: "ABOVE" | "BELOW" | undefined = /below|under|at most/i.test(q)
    ? "BELOW"
    : /above|over|at least|reach|touch/i.test(q)
      ? "ABOVE"
      : undefined;
  const unit = parseUnit(q);
  const location = parseLocation(q);
  const window = parseTimeWindow(q, closeTs);

  if (marketType === "GENERIC_BINARY") reasons.push("generic market model");
  if (marketType.startsWith("CRYPTO") && !underlying) reasons.push("missing underlying symbol");
  if ((marketType.startsWith("CRYPTO") || marketType.startsWith("WEATHER")) && !Number.isFinite(threshold)) {
    reasons.push("threshold parse failed");
  }
  if (marketType.startsWith("WEATHER") && !location) reasons.push("location parse failed");
  if (!Number.isFinite(closeTs ?? NaN) && !window.windowEndTs) hardErrors.push("missing close/window time");

  const tradeable = hardErrors.length === 0;
  if (tradeable) reasons.push("parsed ok");
  else reasons.push(...hardErrors);

  return {
    marketType,
    underlying,
    threshold,
    unit,
    location,
    relation,
    windowStartTs: window.windowStartTs,
    windowEndTs: window.windowEndTs,
    closeTs,
    tradeable,
    reasons
  };
}
