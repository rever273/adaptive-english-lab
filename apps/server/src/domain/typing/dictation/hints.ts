import { alignWords, mergeContractions, rawTokens, sameWord, tokenize, type DiffOp } from "./check.js";

/** a word as written in the sentence ("well-known," -> parts ["well", "known"]) */
export interface DisplayWord {
  display: string;
  parts: string[];
}

export function displayWords(text: string): DisplayWord[] {
  return text
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((display) => ({ display, parts: rawTokens(display) }));
}

/**
 * Enter only checks: a word the learner has not reached is never revealed by a wrong answer, even when the alignment pairs the last typed words with
 * the end of the sentence. A word counts as reached up to the last word typed right, plus one more per word typed after it. Words further on are only
 * shown by Hint and Show answer.
 */
function reachedWords(expected: ReadonlyArray<{ owner: number }>, ops: readonly DiffOp[]): number {
  let at = 0;
  let anchor = -1;
  let typedAfter = 0;
  for (const op of ops) {
    if (op.expected !== null) at++;
    if (op.op === "same") { anchor = expected[at - 1]!.owner; typedAfter = 0; } else if (op.typed !== null) typedAfter++;
  }
  return anchor + 1 + typedAfter;
}

/** Display words missing or substituted in an answer, using the same alignment as grading, among the words the learner has reached. */
export function wrongAnswerWords(words: readonly DisplayWord[], typedText: string): number[] {
  const expected = mergeContractions(words.flatMap((w, owner) => w.parts.map((tok) => ({ tok, owner }))));
  const ops = alignWords(expected.map((w) => w.tok), tokenize(typedText)).ops;
  const wrong = new Set<number>();
  let i = 0;
  for (const op of ops) {
    if (op.expected !== null) {
      if (op.op === "missing" || op.op === "wrong") wrong.add(expected[i]!.owner);
      i++;
    }
  }
  const reach = reachedWords(expected, ops);
  return [...wrong].filter((i) => i < reach);
}

/** Show the prefix through the first error, plus other errors in the attempted portion. */
export function attemptedAnswerWords(words: readonly DisplayWord[], typedText: string): number[] {
  const expected = mergeContractions(words.flatMap((w, owner) => w.parts.map((tok) => ({ tok, owner }))));
  const ops = alignWords(expected.map((w) => w.tok), tokenize(typedText)).ops;
  let lastTyped = ops.length - 1;
  while (lastTyped >= 0 && ops[lastTyped]!.typed === null) lastTyped--;
  let expectedIndex = 0;
  let lastOwner = -1;
  const wrong = new Set<number>();
  let firstExtraAfter: number | undefined;
  for (let i = 0; i <= lastTyped; i++) {
    const op = ops[i]!;
    if (op.op === "extra" && firstExtraAfter === undefined) firstExtraAfter = lastOwner;
    if (op.expected !== null) {
      lastOwner = expected[expectedIndex++]!.owner;
      if (op.op === "missing" || op.op === "wrong") wrong.add(lastOwner);
    }
  }
  if (wrong.size === 0 && firstExtraAfter === undefined && lastTyped >= 0 && expectedIndex < expected.length) wrong.add(expected[expectedIndex]!.owner);
  const firstWrong = Math.min(...wrong, firstExtraAfter ?? Infinity);
  if (!Number.isFinite(firstWrong)) return [];
  return [...new Set([...Array.from({ length: firstWrong + 1 }, (_, i) => i), ...wrong])].filter((i) => i < reachedWords(expected, ops)).sort((a, b) => a - b);
}

/** index of the first display word that differs from what was typed; null when everything matches */
export function stuckWord(words: readonly DisplayWord[], typed: readonly string[], typedRaw?: readonly string[]): number | null {
  // the expected words as comparable tokens (a contraction and its long form are the same), each remembering its last display word
  const expected = mergeContractions(words.flatMap((w, owner) => w.parts.map((tok) => ({ tok, owner }))));
  for (let t = 0; t < expected.length; t++) {
    if (t >= typed.length || !sameWord(expected[t]!.tok, typed[t]!)) {
      // A typed pair such as "we would" may be merged into "wed". If its
      // first word matches, point at the following expected word, not "we".
      if (typedRaw) {
        const groups = mergeContractions(typedRaw.map((tok, owner) => ({ tok, owner })));
        const first = t === 0 ? 0 : (groups[t - 1]?.owner ?? -1) + 1;
        const last = groups[t]?.owner;
        if (last !== undefined && last > first && sameWord(expected[t]!.tok, typedRaw[first]!) && expected[t + 1]) return expected[t + 1]!.owner;
      }
      return expected[t]!.owner;
    }
  }
  return expected.length === typed.length ? null : words.length - 1; // extra words typed after the end
}

/** inclusive range of display words a hint of this level reveals, for the stuck word `k` of `n` words */
export function revealFor(level: 1 | 2 | 3, k: number, n: number): [from: number, to: number] {
  return level === 1 ? [k, k] : level === 2 ? [0, k] : [0, n - 1];
}

/** union of the revealed ranges: indexes of the words the learner may see */
export function revealedSet(ranges: ReadonlyArray<readonly [number, number]>): Set<number> {
  const out = new Set<number>();
  for (const [from, to] of ranges) for (let i = from; i <= to; i++) out.add(i);
  return out;
}
