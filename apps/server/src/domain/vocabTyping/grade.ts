import type { VtCheckOutcome } from "@english-lab/contracts";
import { normalizeWord } from "../vocabulary/forms.js";

/**
 * Grading of a cloze check by code only (D169; the checks of Context Loop, D159, are the model). Case, outer spaces and outer punctuation are ignored.
 * The exact form of the sentence is `correct`; another form of the same lemma is `form_match` (right, but marked); one slip (an insertion, a deletion,
 * a substitution or two swapped letters) in a word of 5+ letters is a `typo` (right, with a flag); anything else is `incorrect`. A revealed answer
 * ("I don't know") is `revealed`. Right answers are `good` for the scheduler, wrong or revealed ones `again`; nothing here ever produces `skipped`.
 */
export interface Grade {
  outcome: Exclude<VtCheckOutcome, "skipped">;
  rating: "good" | "again";
}

/** Optimal-string-alignment distance: a swap of two neighbouring letters counts as one edit */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  }
  return d[a.length]![b.length]!;
}

/** `answer` null = "I don't know"; `forms` are the spellings of the lemma (lower case) */
export function gradeCloze(answer: string | null, expected: string, forms: readonly string[]): Grade {
  if (answer === null) return { outcome: "revealed", rating: "again" };
  const a = normalizeWord(answer);
  const e = normalizeWord(expected);
  if (a === "") return { outcome: "incorrect", rating: "again" };
  if (a === e) return { outcome: "correct", rating: "good" };
  if (forms.includes(a)) return { outcome: "form_match", rating: "good" };
  if (e.length >= 5 && editDistance(a, e) === 1) return { outcome: "typo", rating: "good" };
  return { outcome: "incorrect", rating: "again" };
}

/** the sentence with the target replaced by a gap (offsets come from the stored match, not from the page) */
export function gapSentence(text: string, start: number, length: number): string {
  return `${text.slice(0, start)}____${text.slice(start + length)}`;
}
