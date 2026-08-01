/**
 * Foresight unit tests — deterministic, no network calls.
 * Run with: npm test
 *
 * Covers:
 *  - combineSignals: mean-reversion (A) + market-follow (D)
 *  - determineResolution: Gamma-lag handling (pending/ambiguous/resolved)
 *  - history: prediction recording + calibration stats (C)
 */
import { combineSignals } from "../lib/analyst-agent.ts";
import { determineResolution } from "../lib/validator-agent.ts";
import { recordPrediction, recordResolution, computeStats } from "../lib/history.ts";
import { rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { GammaEvent } from "../lib/polymarket.ts";

let failures = 0;
const tests: { name: string; fn: () => void }[] = [];

function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// Clean history file before + after so stats tests are deterministic.
const historyFile = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "predictions.json");

// ---------------------------------------------------------------- A + D ---

test("A: strong 5m momentum mean-reverts to the pullback", () => {
  const r = combineSignals("5m", 0.5, "up", 0.1, 0.05, null);
  assert(r.outcome === "down", `expected down, got ${r.outcome}`);
});

test("A: weak 5m momentum still follows the impulse", () => {
  const r = combineSignals("5m", 0.05, "up", 0.1, 0.05, null);
  assert(r.outcome === "up", `expected up, got ${r.outcome}`);
});

test("A: strong 15m momentum mean-reverts", () => {
  const r = combineSignals("15m", -0.5, "down", -0.1, 0.05, null);
  assert(r.outcome === "up", `expected up (pullback), got ${r.outcome}`);
});

test("A: 1h window does NOT mean-revert (trend-dominant)", () => {
  const r = combineSignals("1h", 0.5, "up", 0.1, 0.05, null);
  assert(r.outcome === "up", `expected up, got ${r.outcome}`);
});

test("A: 4h window does NOT mean-revert", () => {
  const r = combineSignals("4h", 0.5, "up", 0.1, 0.05, null);
  assert(r.outcome === "up", `expected up, got ${r.outcome}`);
});

test("D: decisive CLOB mid (0.65) overrides down-heuristics -> up", () => {
  const r = combineSignals("5m", -0.05, "down", -0.1, 0.05, 0.65);
  assert(r.outcome === "up", `expected up, got ${r.outcome}`);
  assert(r.confidence > 0.5, `confidence should exceed 0.5, got ${r.confidence}`);
});

test("D: decisive CLOB mid (0.30) overrides up-heuristics -> down", () => {
  const r = combineSignals("5m", 0.05, "up", 0.1, 0.05, 0.30);
  assert(r.outcome === "down", `expected down, got ${r.outcome}`);
});

test("D: mid near 0.5 (0.51) is ignored, heuristics decide", () => {
  const r = combineSignals("5m", -0.05, "down", -0.1, 0.05, 0.51);
  assert(r.outcome === "down", `expected down, got ${r.outcome}`);
});

test("D: mid near 0.5 (0.49) is ignored, heuristics decide", () => {
  const r = combineSignals("5m", 0.05, "up", 0.1, 0.05, 0.49);
  assert(r.outcome === "up", `expected up, got ${r.outcome}`);
});

test("confidence stays within [0.05, 0.95]", () => {
  for (const duration of ["5m", "15m", "1h", "4h"] as const) {
    for (const mid of [null, 0.5, 0.62, 0.38]) {
      const r = combineSignals(duration, 0.4, "up", 0.5, 0.5, mid);
      assert(r.confidence >= 0.05 && r.confidence <= 0.95, `conf out of range: ${r.confidence}`);
    }
  }
});

// -------------------------------------------------------- resolution ---

function fakeMarket(
  closed: boolean,
  upPrice: number,
  overrides: Partial<GammaEvent> = {}
): GammaEvent {
  return {
    slug: "btc-updown-5m-1785560400",
    title: "Bitcoin Up or Down",
    active: !closed,
    closed,
    endDate: "2026-08-01T05:05:00Z",
    tags: [],
    markets: [
      {
        outcomes: JSON.stringify(["Up", "Down"]),
        clobTokenIds: JSON.stringify(["token-up", "token-down"]),
        outcomePrices: JSON.stringify([String(upPrice), String(1 - upPrice)]),
      },
    ],
    ...overrides,
  } as unknown as GammaEvent;
}

test("resolution: not closed -> pending", () => {
  const r = determineResolution(fakeMarket(false, 0.5), "up");
  assert(r.status === "pending", `expected pending, got ${r.status}`);
});

test("resolution: closed near 0.5 -> ambiguous (still resolving)", () => {
  const r = determineResolution(fakeMarket(true, 0.505), "up");
  assert(r.status === "ambiguous", `expected ambiguous, got ${r.status}`);
});

test("resolution: closed at 0/1 -> resolved, match/miss correct", () => {
  const win = determineResolution(fakeMarket(true, 1), "up");
  assert(win.status === "resolved" && win.match, "expected resolved+match for up/1");

  const loss = determineResolution(fakeMarket(true, 0), "up");
  assert(
    loss.status === "resolved" && !loss.match && loss.actualOutcome === "down",
    "expected resolved+miss for up/0"
  );
});

// ------------------------------------------------------------- history ---

test("C: record + resolve + stats roundtrip", () => {
  if (existsSync(historyFile)) rmSync(historyFile);

  recordPrediction({ slug: "t-1", assetKey: "bitcoin", duration: "5m", predictedOutcome: "up", confidence: 0.6 });
  recordPrediction({ slug: "t-2", assetKey: "bitcoin", duration: "5m", predictedOutcome: "down", confidence: 0.55 });
  recordResolution("t-1", "up"); // correct
  recordResolution("t-2", "up"); // wrong

  const s = computeStats();
  assert(s.total === 2, `total=${s.total}`);
  assert(s.resolved === 2, `resolved=${s.resolved}`);
  assert(s.overallWinRate === 0.5, `winRate=${s.overallWinRate}`);
  assert(s.byDuration["5m"]?.count === 2, "5m count should be 2");
  assert(
    s.byBucket.some((b) => b.bucket === "55-60%" && b.count === 1),
    "55-60% bucket missing"
  );
  assert(
    s.byBucket.some((b) => b.bucket === "60-65%" && b.count === 1),
    "60-65% bucket missing"
  );
});

test("C: duplicate resolution does not double-count", () => {
  // t-1 already resolved in the previous test; resolving again must not change stats.
  recordResolution("t-1", "down"); // conflicting late resolution ignored
  const s = computeStats();
  assert(s.resolved === 2, `resolved=${s.resolved} (should stay 2)`);
});

// ------------------------------------------------------------------ run ---

if (existsSync(historyFile)) rmSync(historyFile);

for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`[PASS] ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`[FAIL] ${name} — ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (existsSync(historyFile)) rmSync(historyFile);

console.log(failures === 0 ? `\n${tests.length}/${tests.length} tests passed` : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
