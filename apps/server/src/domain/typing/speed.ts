import { TYPING_SPEED_VERSION, type TypingSpeed } from "@english-lab/contracts";

export interface SpeedHistoryPoint {
  status: "completed" | "failed";
  charsCorrect: number;
  activeMs: number;
}

export interface SpeedConfig {
  multiplier: number;
  /** previous estimate from the last Words session's plan (null when there is no history) */
  previousEstimate?: number | null;
}

const round = (n: number): number => Math.round(n * 10) / 10;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Drop 20% from each end (winsorised), so a single outlier cannot move the estimate. */
function trim(sorted: number[]): number[] {
  const drop = Math.floor(sorted.length * 0.2);
  if (drop * 2 >= sorted.length) return sorted;
  return sorted.slice(drop, sorted.length - drop);
}

/** How many `failed` rows sit at the very end (interrupted skipped, completed breaks the streak). */
function consecutiveFails(history: SpeedHistoryPoint[]): number {
  let n = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i]!;
    if (h.status === "failed") n++;
    else if (h.status === "completed") break;
    // interrupted does not count and does not break the streak
  }
  return n;
}

/** absolute thresholds, so the learner can change the number of words per level without making levels "uninformative" */
const INFORMATIVE_MIN_CHARS = 40;
const INFORMATIVE_MIN_MS = 15_000;

/**
 * Adaptive speed (typing-speed-v2: informative attempt = 40+ correct characters in 15+ s, was 60 and 20 s in v1). The real difficulty lever is the spawn tempo, not just fall speed; the estimate is a
 * trimmed median of the last informative attempts, clamped to ±8% of the previous estimate so one record cannot jump it.
 * Repeated losses temporarily lower the pressure. The measured WPM is never altered.
 */
export function computeSpeed(history: SpeedHistoryPoint[], cfg: SpeedConfig): TypingSpeed {
  const informative = history
    .filter((h) => (h.status === "completed" || h.status === "failed") && h.charsCorrect >= INFORMATIVE_MIN_CHARS && h.activeMs >= INFORMATIVE_MIN_MS)
    .slice(-10);

  let estimateWpm: number;
  if (informative.length === 0) {
    estimateWpm = 25;
  } else {
    const wpm = informative.map((h) => h.charsCorrect / 5 / (h.activeMs / 60000)).sort((a, b) => a - b);
    const raw = median(trim(wpm));
    estimateWpm = cfg.previousEstimate ? clamp(raw, cfg.previousEstimate * 0.92, cfg.previousEstimate * 1.08) : raw;
  }

  const pressure = 1 - 0.1 * Math.min(consecutiveFails(history), 3);
  const effectiveWpm = estimateWpm * cfg.multiplier * pressure;
  const msPerChar = 12_000 / effectiveWpm;
  return {
    ruleVersion: TYPING_SPEED_VERSION,
    estimateWpm: round(estimateWpm),
    multiplier: round(cfg.multiplier),
    pressure: round(pressure),
    effectiveWpm: round(effectiveWpm),
    msPerChar: round(msPerChar),
  };
}

/** Time for one word to fall to the defence line: longer words get proportionally more, bounded so nothing is impossible or endless. */
export function fallMs(len: number, msPerChar: number): number {
  return Math.round(clamp(3 * len * msPerChar + 2500, 5000, 22000));
}

/** Gap before the next meteor may spawn (client-side), scaled to the length of the previous word. */
export function spawnGapMs(prevWordLen: number, msPerChar: number): number {
  return Math.round(1.6 * prevWordLen * msPerChar + 600);
}
