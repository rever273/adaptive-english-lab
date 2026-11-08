import { mergeContractions, rawTokens, sameWord } from "./check.js";

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
