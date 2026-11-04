import { TYPING_METRICS_VERSION } from "@english-lab/contracts";

/** Version stamped onto finished sessions so the formulas are recomputable and can be changed without rewriting history. */
export const METRICS_VERSION = TYPING_METRICS_VERSION;

export interface MetricsInput {
  mode: "words" | "books";
  activeMs: number;
  charsTyped: number;
  errors: number;
  /** words: sum of destroyed word lengths; books: countRequired(text, start, end). Computed by the server. */
  charsCorrect: number;
  level: number;
  completed: boolean;
  /** words: number of words in the level's plan, so the score does not depend on the "words per level" setting */
  plannedWords?: number;
}

export interface Metrics {
  wpm: number;
  cpm: number;
  accuracy: number | null;
  errors: number;
  score: number;
  activeMs: number;
  charsCorrect: number;
  charsTyped: number;
}

/** a level of this many words is the score's reference size (the default setting) */
const REFERENCE_WORDS = 30;

const round1 = (n: number): number => Math.round(n * 10) / 10;

export function computeMetrics(input: MetricsInput): Metrics {
  const minutes = input.activeMs / 60000;
  const wpm = minutes > 0 ? input.charsCorrect / 5 / minutes : 0;
  const cpm = minutes > 0 ? input.charsCorrect / minutes : 0;
  // accuracy is null (not 100) when nothing was typed
  const accuracy = input.charsTyped > 0 ? ((input.charsTyped - input.errors) / input.charsTyped) * 100 : null;
  const accF = Math.pow((accuracy ?? 0) / 100, 2);
  const score =
    input.mode === "words"
      ? Math.round(input.charsCorrect * (REFERENCE_WORDS / Math.max(1, input.plannedWords ?? REFERENCE_WORDS)) * (wpm / 40) * accF * (1 + Math.min(input.level, 50) * 0.02)) + (input.completed ? 100 : 0)
      : Math.round(wpm * accF * 10);
  return {
    wpm: round1(wpm),
    cpm: round1(cpm),
    accuracy: accuracy === null ? null : round1(accuracy),
    errors: input.errors,
    score,
    activeMs: input.activeMs,
    charsCorrect: input.charsCorrect,
    charsTyped: input.charsTyped,
  };
}

/** Skill tiers (internal heuristic, not an official standard). First matching row from the top wins. */
const SKILL_ROWS = [
  { skill: "Excellent", words: 80, books: 90, accuracy: 96 },
  { skill: "Very Fast", words: 60, books: 70, accuracy: 94 },
  { skill: "Fast", words: 40, books: 50, accuracy: 92 },
  { skill: "Comfortable", words: 25, books: 30, accuracy: 90 },
] as const;

export function skillOf(mode: "words" | "books", wpm: number, accuracy: number | null): "Developing" | "Comfortable" | "Fast" | "Very Fast" | "Excellent" {
  const acc = accuracy ?? 0;
  for (const row of SKILL_ROWS) {
    if (wpm >= row[mode] && acc >= row.accuracy) return row.skill;
  }
  return "Developing";
}
