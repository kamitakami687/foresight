import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { getMarketBySlug, type AssetKey, type GammaEvent } from "./polymarket.js";
import {
  BINANCE_SYMBOLS,
  fetchBinanceKlines,
  getUpClobTokenId,
  klinesToPricePoints,
} from "./analyst-agent.js";

const REPUTATION_REGISTRY_ADDRESS = "0x8004B663056A597Dffe9eCcC1965A193B7388713";
const BLOCKCHAIN = "ARC-TESTNET";
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;

// A closed market's outcomePrices should already be exactly ["1","0"] or
// ["0","1"] once fully settled. A price still sitting near 0.5 despite
// being closed means resolution hasn't actually landed yet (still
// mid-settlement, or a data glitch) — distinct from "pending" (not
// closed yet at all).
const AMBIGUOUS_BAND = 0.05;

// --- Gamma-lag fallback (Binance klines + CLOB midpoint) ---
//
// Polymarket's Gamma API can lag flipping `closed` to true for 2-10
// minutes after a market's endDate passes (observed live on the 5m/15m
// Up-or-Down markets). The CLOB order book, by contrast, prices the
// outcome immediately, and Binance klines give ground truth. So once a
// market is past its endDate, we stop waiting for Gamma: if the CLOB
// midpoint is decisively away from 0.5 and Binance klines for the window
// agree on direction, we treat the market as resolved.
const RESOLUTION_GRACE_MS = 60_000; // 60s after endDate before trusting the fallback
const MIDPOINT_CONFIDENT_BAND = 0.30; // mid <= 0.30 => Down, >= 0.70 => Up

const CLOB_API_BASE = "https://clob.polymarket.com";

// Slug format: "btc-updown-5m-1785560400" — trailing number is the
// window start (unix seconds). endDate is the window end.
function marketWindow(market: GammaEvent): { startMs: number; endMs: number } | null {
  const endMs = new Date(market.endDate).getTime();
  if (Number.isNaN(endMs)) return null;
  const match = market.slug.match(/-(\d{10})$/);
  if (!match) return null;
  return { startMs: Number(match[1]) * 1000, endMs };
}

function assetKeyFromSlug(slug: string): AssetKey | null {
  const lower = slug.toLowerCase();
  if (lower.startsWith("btc") || lower.includes("bitcoin")) return "bitcoin";
  if (lower.startsWith("eth") || lower.includes("ethereum")) return "ethereum";
  return null;
}

// Binance 1m klines covering the market window — direction is
// close-of-last-candle vs close-of-first-candle inside the window.
async function binanceWindowDirection(market: GammaEvent): Promise<"up" | "down" | null> {
  const assetKey = assetKeyFromSlug(market.slug);
  if (!assetKey) return null;
  const window = marketWindow(market);
  if (!window) return null;

  const minutes = Math.ceil((window.endMs - window.startMs) / 60_000) + 2;
  try {
    const klines = await fetchBinanceKlines(BINANCE_SYMBOLS[assetKey], "1m", minutes);
    const prices = klinesToPricePoints(klines);
    const inWindow = prices.filter(([ts]) => ts >= window.startMs && ts <= window.endMs + 60_000);
    if (inWindow.length < 2) return null;

    const firstClose = inWindow[0][1];
    const lastClose = inWindow[inWindow.length - 1][1];
    if (lastClose > firstClose) return "up";
    if (lastClose < firstClose) return "down";
    return null;
  } catch {
    return null;
  }
}

// Percentage move of the underlying across the market window — used to
// reject flat windows as noise. Returns null when ground truth is
// unavailable.
async function binanceWindowMovePct(market: GammaEvent): Promise<number | null> {
  const assetKey = assetKeyFromSlug(market.slug);
  if (!assetKey) return null;
  const window = marketWindow(market);
  if (!window) return null;

  const minutes = Math.ceil((window.endMs - window.startMs) / 60_000) + 2;
  try {
    const klines = await fetchBinanceKlines(BINANCE_SYMBOLS[assetKey], "1m", minutes);
    const prices = klinesToPricePoints(klines);
    const inWindow = prices.filter(([ts]) => ts >= window.startMs && ts <= window.endMs + 60_000);
    if (inWindow.length < 2) return null;

    const firstClose = inWindow[0][1];
    const lastClose = inWindow[inWindow.length - 1][1];
    if (firstClose === 0) return null;
    return ((lastClose - firstClose) / firstClose) * 100;
  } catch {
    return null;
  }
}

// CLOB midpoint of the "Up" token: how the crowd is pricing the outcome
// right now. Best-effort — null on any failure.
async function clobUpMidpoint(market: GammaEvent): Promise<number | null> {
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

export type ResolutionResult =
  | { status: "pending" }
  | { status: "ambiguous" }
  | { status: "resolved"; match: boolean; actualOutcome: "up" | "down" };

export function determineResolution(
  market: GammaEvent,
  predictedOutcome: "up" | "down"
): ResolutionResult {
  if (!market.closed) {
    return { status: "pending" };
  }

  const submarket = market.markets[0];
  const outcomes = JSON.parse(submarket.outcomes) as string[];
  const outcomePrices = JSON.parse(submarket.outcomePrices) as string[];

  const upIndex = outcomes.findIndex((o) => o.toLowerCase() === "up");
  const upPrice = Number(outcomePrices[upIndex]);

  if (Math.abs(upPrice - 0.5) < AMBIGUOUS_BAND) {
    return { status: "ambiguous" };
  }

  const actualOutcome: "up" | "down" = upPrice > 0.5 ? "up" : "down";
  return { status: "resolved", match: actualOutcome === predictedOutcome, actualOutcome };
}

// Like determineResolution, but once the market is past its endDate it
// falls back to CLOB midpoint + Binance klines so a lagging Gamma
// `closed` flag can't hold resolution hostage for minutes.
//
// Binance is the primary resolution signal (these Up/Down markets
// resolve against exchange price feeds; on 5m windows the CLOB book is
// typically deleted within a minute or two of window close, BEFORE Gamma
// flips `closed` — so CLOB can't be a required input). The CLOB midpoint
// is used only as a caution: if the book is still alive AND decisively
// priced AND contradicts Binance, we hold off rather than force a call.
const BINANCE_MIN_MOVE_PCT = 0.001; // ignore sub-0.001% noise moves

export async function resolveWithFallback(
  market: GammaEvent,
  predictedOutcome: "up" | "down"
): Promise<ResolutionResult> {
  const primary = determineResolution(market, predictedOutcome);
  if (primary.status === "resolved") return primary;

  const endMs = new Date(market.endDate).getTime();
  if (Number.isNaN(endMs) || Date.now() - endMs < RESOLUTION_GRACE_MS) {
    return primary; // window hasn't ended yet (or just ended) — wait
  }

  const [midpoint, binanceDirection, binanceMovePct] = await Promise.all([
    clobUpMidpoint(market),
    binanceWindowDirection(market),
    binanceWindowMovePct(market),
  ]);
  if (binanceDirection === null || binanceMovePct === null) {
    return primary; // no ground truth — stick with Gamma's verdict
  }
  if (Math.abs(binanceMovePct) < BINANCE_MIN_MOVE_PCT) {
    return primary; // flat window — no signal to resolve on
  }

  // If the CLOB book is still alive and decisively priced against
  // Binance, don't force it — let Gamma settle the disagreement.
  if (midpoint !== null) {
    const clobOutcome: "up" | "down" = midpoint >= 1 - MIDPOINT_CONFIDENT_BAND ? "up" : "down";
    const clobDecisive = midpoint <= MIDPOINT_CONFIDENT_BAND || midpoint >= 1 - MIDPOINT_CONFIDENT_BAND;
    if (clobDecisive && clobOutcome !== binanceDirection) {
      return primary;
    }
  }

  return {
    status: "resolved",
    match: binanceDirection === predictedOutcome,
    actualOutcome: binanceDirection,
  };
}

export async function checkOutcome(
  slug: string,
  predictedOutcome: "up" | "down"
): Promise<ResolutionResult> {
  const market = await getMarketBySlug(slug);
  if (!market) {
    throw new Error(`No market found for slug "${slug}"`);
  }
  return resolveWithFallback(market, predictedOutcome);
}

export function feedbackFor(match: boolean): { value: number; tag1: string } {
  return match
    ? { value: 100, tag1: "prediction_correct" }
    : { value: 20, tag1: "prediction_incorrect" };
}

// Submitted by the REPORTER wallet, never the VALIDATOR itself — ERC-8004
// forbids an agent scoring its own performance.
export async function giveFeedback(match: boolean): Promise<{ txHash: string }> {
  const reporterAddress = process.env.REPORTER_WALLET_ADDRESS;
  const agentId = process.env.VALIDATOR_AGENT_ID;
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  if (!reporterAddress) throw new Error("Missing REPORTER_WALLET_ADDRESS in .env");
  if (!agentId) throw new Error("Missing VALIDATOR_AGENT_ID in .env");
  if (!apiKey || !entitySecret) {
    throw new Error("Missing CIRCLE_API_KEY or CIRCLE_ENTITY_SECRET in .env");
  }

  // Loaded lazily via require() (not import()) so it resolves to the SDK's
  // CJS build. Vercel's Node runtime cannot load the package's ESM build
  // (dist/*.es.js has no "type": "module" in the package and .es.js is not
  // a recognized ESM extension there) — it crashed /validate with
  // "Cannot use import statement outside a module". require() uses the
  // "require" exports condition -> dist/*.cjs.js, a clean CommonJS bundle.
  const require = createRequire(import.meta.url);
  const circleWallets = require("@circle-fin/developer-controlled-wallets");
  const client = circleWallets.initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
  const { value, tag1 } = feedbackFor(match);

  const txRes = await client.createContractExecutionTransaction({
    walletAddress: reporterAddress,
    blockchain: BLOCKCHAIN,
    contractAddress: REPUTATION_REGISTRY_ADDRESS,
    abiFunctionSignature: "giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)",
    abiParameters: [agentId, value, 0, tag1, "", "", "", ZERO_BYTES32],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    idempotencyKey: randomUUID(),
  });

  const tx = await client.getTransaction({ id: txRes.data!.id, waitForState: "COMPLETE" });
  const txHash = tx.data?.transaction?.txHash;
  if (!txHash) {
    throw new Error(`Feedback transaction ${txRes.data!.id} reached COMPLETE but no txHash was returned`);
  }

  return { txHash };
}
