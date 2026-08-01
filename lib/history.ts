import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// --- Prediction history (calibration) ---
// Every prediction and its eventual outcome is appended to
// data/predictions.json. From it we compute honest win-rates per
// confidence bucket, so the app can show its real track record instead
// of just an uncalibrated confidence number.

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const HISTORY_FILE = join(DATA_DIR, "predictions.json");

export interface PredictionRecord {
  slug: string;
  assetKey: string;
  duration: string;
  predictedOutcome: "up" | "down";
  confidence: number; // 0..1 as predicted at prediction time
  predictedAt: string; // ISO
  // Filled in later when the market resolves:
  actualOutcome?: "up" | "down";
  resolvedAt?: string;
  correct?: boolean;
}

interface HistoryFile {
  predictions: PredictionRecord[];
}

function loadHistory(): HistoryFile {
  try {
    if (existsSync(HISTORY_FILE)) {
      return JSON.parse(readFileSync(HISTORY_FILE, "utf8")) as HistoryFile;
    }
  } catch {
    // corrupt file — start fresh rather than crash
  }
  return { predictions: [] };
}

function saveHistory(history: HistoryFile): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

export function recordPrediction(record: Omit<PredictionRecord, "predictedAt">): void {
  const history = loadHistory();
  history.predictions.push({ ...record, predictedAt: new Date().toISOString() });
  // Cap file size at 2000 entries — the oldest are the least relevant
  // to today's calibration anyway.
  if (history.predictions.length > 2000) {
    history.predictions = history.predictions.slice(-2000);
  }
  saveHistory(history);
}

export function recordResolution(slug: string, actualOutcome: "up" | "down"): boolean {
  const history = loadHistory();
  let updated = false;
  for (const p of history.predictions) {
    if (p.slug === slug && p.actualOutcome === undefined) {
      p.actualOutcome = actualOutcome;
      p.resolvedAt = new Date().toISOString();
      p.correct = p.predictedOutcome === actualOutcome;
      updated = true;
    }
  }
  if (updated) saveHistory(history);
  return updated;
}

export interface BucketStat {
  bucket: string; // e.g. "50-55%"
  count: number;
  correct: number;
  winRate: number | null; // null when count === 0
}

export interface PredictionStats {
  total: number;
  resolved: number;
  overallWinRate: number | null;
  byDuration: Record<string, { count: number; correct: number; winRate: number | null }>;
  byBucket: BucketStat[];
}

// Win-rate per 5-point confidence bucket — lets us see whether
// "confident" predictions are actually more accurate than coin flips.
export function computeStats(): PredictionStats {
  const history = loadHistory();
  const predictions = history.predictions;
  const resolved = predictions.filter((p) => p.correct !== undefined);

  const buckets: { low: number; high: number; count: number; correct: number }[] = [];
  for (let low = 50; low < 100; low += 5) {
    buckets.push({ low, high: low + 5, count: 0, correct: 0 });
  }

  const byDuration: Record<string, { count: number; correct: number }> = {};
  for (const p of resolved) {
    const pct = Math.round(p.confidence * 100);
    const bucket = buckets.find((b) => pct >= b.low && pct < b.high) ?? buckets[buckets.length - 1];
    bucket.count += 1;
    if (p.correct) bucket.correct += 1;

    byDuration[p.duration] ??= { count: 0, correct: 0 };
    byDuration[p.duration].count += 1;
    if (p.correct) byDuration[p.duration].correct += 1;
  }

  const overallWinRate =
    resolved.length > 0
      ? resolved.filter((p) => p.correct).length / resolved.length
      : null;

  return {
    total: predictions.length,
    resolved: resolved.length,
    overallWinRate,
    byDuration: Object.fromEntries(
      Object.entries(byDuration).map(([k, v]) => [
        k,
        { ...v, winRate: v.count > 0 ? v.correct / v.count : null },
      ])
    ),
    byBucket: buckets.map((b) => ({
      bucket: `${b.low}-${b.high}%`,
      count: b.count,
      correct: b.correct,
      winRate: b.count > 0 ? b.correct / b.count : null,
    })),
  };
}
