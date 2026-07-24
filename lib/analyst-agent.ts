import {
  ASSET_ALIASES,
  ASSETS,
  type AssetKey,
  type DurationKey,
  type GammaEvent,
} from "./polymarket.js";

// Word-boundary match (not plain substring) so short tickers like "sol" or
// "eth" don't false-positive inside unrelated words ("solution", "ethics").
// Hyphens in real slugs ("btc-updown-5m-...") count as boundaries, so this
// still matches ticker-style slugs correctly.
const ALIAS_PATTERNS: { key: AssetKey; pattern: RegExp }[] = (
  Object.entries(ASSET_ALIASES) as [AssetKey, string[]][]
).flatMap(([key, aliases]) =>
  aliases.map((alias) => ({ key, pattern: new RegExp(`\\b${alias}\\b`, "i") }))
);

export function detectAsset(text: string): AssetKey | null {
  const match = ALIAS_PATTERNS.find(({ pattern }) => pattern.test(text));
  return match?.key ?? null;
}

const COINGECKO_API_BASE = "https://api.coingecko.com/api/v3";

type PricePoint = [timestampMs: number, price: number];

interface CoinGeckoMarketChart {
  prices: PricePoint[];
}

// days=1 with no interval param returns CoinGecko's finest free-tier
// granularity (~5-minutely) — the closest available stand-in for "minutely".
async function fetchMarketChart(
  coingeckoId: string,
  days: number,
  interval?: "hourly"
): Promise<PricePoint[]> {
  const url = new URL(`${COINGECKO_API_BASE}/coins/${coingeckoId}/market_chart`);
  url.searchParams.set("vs_currency", "usd");
  url.searchParams.set("days", String(days));
  if (interval) url.searchParams.set("interval", interval);

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`CoinGecko request failed: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as CoinGeckoMarketChart;
  if (!data.prices || data.prices.length < 2) {
    throw new Error(`CoinGecko returned insufficient price data for ${coingeckoId}`);
  }
  return data.prices;
}

interface DaySignals {
  priceChange15m: number;
  dayAveragePrice: number;
  trendDirection: "up" | "down";
  percentAboveOrBelowAverage: number;
}

function computeDaySignals(prices: PricePoint[]): DaySignals {
  const [latestTime, latestPrice] = prices[prices.length - 1];

  const fifteenMinAgoTarget = latestTime - 15 * 60 * 1000;
  const [, priceFifteenMinAgo] = prices.reduce((closest, point) =>
    Math.abs(point[0] - fifteenMinAgoTarget) < Math.abs(closest[0] - fifteenMinAgoTarget)
      ? point
      : closest
  );

  const priceChange15m = ((latestPrice - priceFifteenMinAgo) / priceFifteenMinAgo) * 100;

  const dayAveragePrice =
    prices.reduce((sum, [, price]) => sum + price, 0) / prices.length;
  const percentAboveOrBelowAverage =
    ((latestPrice - dayAveragePrice) / dayAveragePrice) * 100;
  const trendDirection: "up" | "down" = latestPrice >= dayAveragePrice ? "up" : "down";

  return { priceChange15m, dayAveragePrice, trendDirection, percentAboveOrBelowAverage };
}

// Average absolute hour-over-hour percentage swing across the past 7 days.
function computeHourlyVolatility(prices: PricePoint[]): number {
  let totalSwing = 0;
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1][1];
    const curr = prices[i][1];
    totalSwing += Math.abs((curr - prev) / prev) * 100;
  }
  return totalSwing / (prices.length - 1);
}

const BINANCE_API_BASE = "https://api.binance.com/api/v3";
const BINANCE_SYMBOLS: Record<AssetKey, string> = {
  bitcoin: "BTCUSDT",
  ethereum: "ETHUSDT",
};

// [openTime, open, high, low, close, volume, closeTime, quoteVolume,
// numTrades, takerBuyBase, takerBuyQuote, ignore] — all price/volume
// fields come back as strings.
type BinanceKline = [
  number,
  string,
  string,
  string,
  string,
  string,
  number,
  string,
  number,
  string,
  string,
  string
];

async function fetchBinanceKlines(
  symbol: string,
  interval: string,
  limit: number
): Promise<BinanceKline[]> {
  const url = new URL(`${BINANCE_API_BASE}/klines`);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("limit", String(limit));

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Binance request failed: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as BinanceKline[];
  if (!Array.isArray(data) || data.length < 2) {
    throw new Error(`Binance returned insufficient kline data for ${symbol}`);
  }
  return data;
}

export function klinesToPricePoints(klines: BinanceKline[]): PricePoint[] {
  return klines.map((k) => [k[0], Number(k[4])]);
}

// Momentum needs fine (1-minute) granularity — the same "closest point to
// 15 minutes ago" logic as the old CoinGecko-fed computeDaySignals, just
// fed by a minute-resolution array instead of a day-resolution one.
export function computeMomentumSignal(prices: PricePoint[]): { priceChange15m: number } {
  const [latestTime, latestPrice] = prices[prices.length - 1];

  const fifteenMinAgoTarget = latestTime - 15 * 60 * 1000;
  const [, priceFifteenMinAgo] = prices.reduce((closest, point) =>
    Math.abs(point[0] - fifteenMinAgoTarget) < Math.abs(closest[0] - fifteenMinAgoTarget)
      ? point
      : closest
  );

  const priceChange15m = ((latestPrice - priceFifteenMinAgo) / priceFifteenMinAgo) * 100;
  return { priceChange15m };
}

// Trend needs a day-scale window (hourly candles) — separate from the
// minute-resolution momentum array above.
export function computeTrendSignal(prices: PricePoint[]): {
  dayAveragePrice: number;
  trendDirection: "up" | "down";
  percentAboveOrBelowAverage: number;
} {
  const [, latestPrice] = prices[prices.length - 1];

  const dayAveragePrice = prices.reduce((sum, [, price]) => sum + price, 0) / prices.length;
  const percentAboveOrBelowAverage = ((latestPrice - dayAveragePrice) / dayAveragePrice) * 100;
  const trendDirection: "up" | "down" = latestPrice >= dayAveragePrice ? "up" : "down";

  return { dayAveragePrice, trendDirection, percentAboveOrBelowAverage };
}

interface AssetSignals {
  priceChange15m: number;
  dayAveragePrice: number;
  trendDirection: "up" | "down";
  percentAboveOrBelowAverage: number;
  recentHourlyVolatility: number;
}

async function fetchSignalsFromBinance(assetKey: AssetKey): Promise<AssetSignals> {
  const symbol = BINANCE_SYMBOLS[assetKey];

  const [minuteKlines, hourlyKlines] = await Promise.all([
    fetchBinanceKlines(symbol, "1m", 30),
    fetchBinanceKlines(symbol, "1h", 168), // 7 days
  ]);

  const minutePrices = klinesToPricePoints(minuteKlines);
  const hourlyPrices = klinesToPricePoints(hourlyKlines);
  const last24hPrices = hourlyPrices.slice(-24);

  const { priceChange15m } = computeMomentumSignal(minutePrices);
  const { dayAveragePrice, trendDirection, percentAboveOrBelowAverage } =
    computeTrendSignal(last24hPrices);
  const recentHourlyVolatility = computeHourlyVolatility(hourlyPrices);

  return {
    priceChange15m,
    dayAveragePrice,
    trendDirection,
    percentAboveOrBelowAverage,
    recentHourlyVolatility,
  };
}

async function fetchSignalsFromCoinGecko(assetKey: AssetKey): Promise<AssetSignals> {
  const coingeckoId = ASSETS[assetKey].coingeckoId;

  const [dayPrices, weekHourlyPrices] = await Promise.all([
    fetchMarketChart(coingeckoId, 1),
    fetchMarketChart(coingeckoId, 7, "hourly"),
  ]);

  const { priceChange15m, dayAveragePrice, trendDirection, percentAboveOrBelowAverage } =
    computeDaySignals(dayPrices);
  const recentHourlyVolatility = computeHourlyVolatility(weekHourlyPrices);

  return {
    priceChange15m,
    dayAveragePrice,
    trendDirection,
    percentAboveOrBelowAverage,
    recentHourlyVolatility,
  };
}

// Binance is primary (no key, generous rate limits, real trading data).
// CoinGecko is a fallback only, kept for when Binance is unreachable.
async function fetchAssetSignals(assetKey: AssetKey): Promise<AssetSignals> {
  try {
    return await fetchSignalsFromBinance(assetKey);
  } catch (err) {
    console.error(
      `Binance signal fetch failed for ${assetKey}, falling back to CoinGecko: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return await fetchSignalsFromCoinGecko(assetKey);
  }
}

const CLOB_API_BASE = "https://clob.polymarket.com";

// outcomes/clobTokenIds are JSON-encoded strings on the Gamma API, in
// matching positional order — find "Up"'s index in outcomes, return the
// clobTokenIds entry at that same index.
export function getUpClobTokenId(market: GammaEvent): string | null {
  const submarket = market.markets?.[0];
  if (!submarket) return null;

  try {
    const outcomes = JSON.parse(submarket.outcomes) as string[];
    const tokenIds = JSON.parse(submarket.clobTokenIds) as string[];
    const upIndex = outcomes.findIndex((o) => o.toLowerCase() === "up");
    return upIndex !== -1 && tokenIds[upIndex] ? tokenIds[upIndex] : null;
  } catch {
    return null;
  }
}

// A supplementary comparison signal, not a required input to
// combineSignals — best-effort. If it's unavailable, the rest of the
// prediction still proceeds with marketImpliedProbability set to null.
async function fetchMarketImpliedProbability(market: GammaEvent): Promise<number | null> {
  const tokenId = getUpClobTokenId(market);
  if (!tokenId) return null;

  try {
    const url = new URL(`${CLOB_API_BASE}/midpoint`);
    url.searchParams.set("token_id", tokenId);
    const res = await fetch(url.toString());
    if (!res.ok) return null;

    const data = (await res.json()) as { mid: string };
    const mid = Number(data.mid);
    return Number.isFinite(mid) ? mid : null;
  } catch {
    return null;
  }
}

// How much each signal matters at a given time horizon. momentum + trend
// is the "directional vote budget" (determines outcome); volatility isn't
// directional but scales how hard a high-volatility reading dents
// confidence. Weights are per-duration, not required to sum to 1.
const DURATION_WEIGHTS: Record<
  DurationKey,
  { momentum: number; trend: number; volatility: number }
> = {
  // 5m: this IS the momentum window — it dominates. Trend/volatility are
  // light context.
  "5m": { momentum: 0.7, trend: 0.2, volatility: 0.1 },
  // 15m: momentum and trend roughly equally informative.
  "15m": { momentum: 0.4, trend: 0.4, volatility: 0.2 },
  // 1h: trend leads, momentum is a minor tiebreaker.
  "1h": { momentum: 0.2, trend: 0.55, volatility: 0.25 },
  // 4h: trend + volatility dominate; 15-minute momentum is mostly noise
  // at this timescale.
  "4h": { momentum: 0.05, trend: 0.5, volatility: 0.45 },
};

// Scale constants for mapping raw percentage magnitudes to a signed
// [-1, 1] "strength" via tanh: saturates gracefully for extreme moves
// instead of clamping hard, and stays close to linear (so confidence
// tracks magnitude smoothly) across the ranges these signals actually
// take in practice. Picked from live-observed ranges this session
// (priceChange15m typically 0.05-0.5%, percentAboveOrBelowAverage
// typically 0.3-1.5%) so realistic values land well short of saturation.
const MOMENTUM_MAGNITUDE_SCALE = 0.3; // %
const TREND_MAGNITUDE_SCALE = 1.0; // %
const VOLATILITY_DAMPENING_SCALE = 0.5; // % — matches the old fixed threshold, now a continuous knee
const MARKET_DIVERGENCE_SENSITIVITY = 2; // how hard disagreeing with the market dents confidence

export function combineSignals(
  duration: DurationKey,
  priceChange15m: number,
  trendDirection: "up" | "down",
  percentAboveOrBelowAverage: number,
  recentHourlyVolatility: number,
  marketImpliedProbability: number | null = null
): { outcome: "up" | "down"; confidence: number } {
  const weights = DURATION_WEIGHTS[duration];

  // Signed, magnitude-aware directional strength in (-1, 1) — replaces
  // the old ±1 sign-only vote, so bigger moves push confidence further
  // from 0.5 continuously rather than in fixed steps.
  const momentumStrength = Math.tanh(priceChange15m / MOMENTUM_MAGNITUDE_SCALE);
  const trendStrength = Math.tanh(percentAboveOrBelowAverage / TREND_MAGNITUDE_SCALE);

  // Weighted vote between the two directional signals, same weighting
  // scheme as before — only the inputs are now magnitude-aware instead
  // of sign-only.
  const directionalScore = weights.momentum * momentumStrength + weights.trend * trendStrength;
  const outcome: "up" | "down" =
    directionalScore > 0 ? "up" : directionalScore < 0 ? "down" : trendDirection;

  // Volatility dampens conviction continuously: higher recent volatility
  // shrinks the directional score toward zero, scaled by how much this
  // duration cares about volatility (weights.volatility) — replaces the
  // old fixed threshold cutoff.
  const volatilityFactor =
    1 / (1 + weights.volatility * (recentHourlyVolatility / VOLATILITY_DAMPENING_SCALE));

  // Disagreeing strongly with what the market is already pricing in is a
  // reason for humility, not something to ignore — dampens conviction
  // proportionally to the size of the disagreement between our own
  // directional read (mapped to an implied P(up)) and the market's.
  let marketDivergenceFactor = 1;
  if (marketImpliedProbability !== null) {
    const ourImpliedProbabilityUp = 0.5 + 0.5 * directionalScore;
    const divergence = Math.abs(ourImpliedProbabilityUp - marketImpliedProbability);
    marketDivergenceFactor = 1 / (1 + MARKET_DIVERGENCE_SENSITIVITY * divergence);
  }

  const dampedScore = directionalScore * volatilityFactor * marketDivergenceFactor;

  let confidence = 0.5 + 0.45 * Math.abs(dampedScore);
  confidence = Math.min(0.95, Math.max(0.05, confidence));

  return { outcome, confidence };
}

const DURATION_LABELS: Record<DurationKey, string> = {
  "5m": "5-minute",
  "15m": "15-minute",
  "1h": "1-hour",
  "4h": "4-hour",
};

// Told to the LLM so its rationale actually reflects which signal drove
// the call at this horizon, instead of reciting all three signals as if
// they mattered equally regardless of duration.
const DURATION_EMPHASIS: Record<DurationKey, string> = {
  "5m": "This is a 5-minute window, so the 15-minute momentum reading is the dominant signal here — the 24-hour trend and 7-day volatility are light context, not the main driver.",
  "15m": "This is a 15-minute window, so the 15-minute momentum and the 24-hour trend are roughly equally informative — neither should be treated as dominant.",
  "1h": "This is a 1-hour window, so the 24-hour trend should lead the call; the 15-minute momentum is only a minor tiebreaker at this horizon.",
  "4h": "This is a 4-hour window, so the 24-hour trend and 7-day volatility should dominate the call; the 15-minute momentum is mostly noise at this timescale.",
};

async function generateRationale(params: {
  assetKey: AssetKey;
  duration: DurationKey;
  outcome: "up" | "down";
  confidence: number;
  priceChange15m: number;
  dayAveragePrice: number;
  trendDirection: "up" | "down";
  percentAboveOrBelowAverage: number;
  recentHourlyVolatility: number;
}): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY in .env");
  }

  const {
    assetKey,
    duration,
    outcome,
    confidence,
    priceChange15m,
    dayAveragePrice,
    trendDirection,
    percentAboveOrBelowAverage,
    recentHourlyVolatility,
  } = params;

  const prompt = `You are a crypto market analyst. In 2-3 sentences, explain why the ${DURATION_LABELS[duration]} prediction for ${assetKey} is "${outcome}" at ${(confidence * 100).toFixed(0)}% confidence, based on these three signals together:
- 15-minute momentum: ${priceChange15m.toFixed(3)}% change
- 24-hour trend: currently trending ${trendDirection}, price is ${Math.abs(percentAboveOrBelowAverage).toFixed(2)}% ${percentAboveOrBelowAverage >= 0 ? "above" : "below"} the 24h average price of $${dayAveragePrice.toFixed(2)}
- Recent volatility: average hourly swing of ${recentHourlyVolatility.toFixed(3)}% over the past 7 days

${DURATION_EMPHASIS[duration]}

State whether the 15-minute momentum and 24-hour trend agree or conflict, name which signal actually drove this ${DURATION_LABELS[duration]} call, and how the volatility level affected the confidence score. Be concise and concrete, no disclaimers.`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.4,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI request failed: ${res.status} ${body}`);
  }

  const data = (await res.json()) as {
    choices: { message: { content: string } }[];
  };
  return data.choices[0]?.message?.content?.trim() ?? "";
}

export interface PredictionSignalData {
  priceChange15m: number;
  dayAveragePrice: number;
  trendDirection: "up" | "down";
  percentAboveOrBelowAverage: number;
  recentHourlyVolatility: number;
  marketImpliedProbability: number | null;
}

export interface PredictionOutcome {
  outcome: "up" | "down";
  confidence: number;
  rationale: string;
  signalData: PredictionSignalData;
}

export async function predictOutcome(
  assetKey: AssetKey,
  duration: DurationKey,
  market: GammaEvent
): Promise<PredictionOutcome> {
  const [
    { priceChange15m, dayAveragePrice, trendDirection, percentAboveOrBelowAverage, recentHourlyVolatility },
    marketImpliedProbability,
  ] = await Promise.all([fetchAssetSignals(assetKey), fetchMarketImpliedProbability(market)]);

  const { outcome, confidence } = combineSignals(
    duration,
    priceChange15m,
    trendDirection,
    percentAboveOrBelowAverage,
    recentHourlyVolatility,
    marketImpliedProbability
  );

  const rationale = await generateRationale({
    assetKey,
    duration,
    outcome,
    confidence,
    priceChange15m,
    dayAveragePrice,
    trendDirection,
    percentAboveOrBelowAverage,
    recentHourlyVolatility,
  });

  return {
    outcome,
    confidence,
    rationale,
    signalData: {
      priceChange15m,
      dayAveragePrice,
      trendDirection,
      percentAboveOrBelowAverage,
      recentHourlyVolatility,
      marketImpliedProbability,
    },
  };
}
