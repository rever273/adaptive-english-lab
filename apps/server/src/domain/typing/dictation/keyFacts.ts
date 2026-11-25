import { alignWords, tokenize } from "./check.js";

export interface LetterFact {
  hits: number;
  misses: number;
}

const letters = (s: string): string => s.toLowerCase().replace(/[^a-z]/g, "");

/**
 * Per-letter facts of one answer, from the sentence and what was typed (no timing; that comes from the page). A word typed right counts a hit for each of its
 * letters. In a wrong word the letters are aligned (edit distance): a matched letter is a hit, a letter of the sentence that was typed wrong or left out is a
 * miss, an extra typed letter is ignored. Words never typed at all, and extra words, say nothing about a key.
 */
export function answerLetterFacts(expectedText: string, typedText: string): Map<string, LetterFact> {
  const out = new Map<string, LetterFact>();
  const add = (letter: string, hit: boolean): void => {
    const f = out.get(letter) ?? { hits: 0, misses: 0 };
    if (hit) f.hits++; else f.misses++;
    out.set(letter, f);
  };
  for (const op of alignWords(tokenize(expectedText), tokenize(typedText)).ops) {
    if (op.expected === null) continue;
    const e = letters(op.expected);
    if (op.op === "same") { for (const ch of e) add(ch, true); continue; }
    if (op.op !== "wrong" || op.typed === null) continue;
    const t = letters(op.typed);
    const n = e.length;
    const m = t.length;
    const d: number[][] = Array.from({ length: n + 1 }, (_, i) => [i, ...Array<number>(m).fill(0)]);
    for (let j = 1; j <= m; j++) d[0]![j] = j;
    for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (e[i - 1] === t[j - 1] ? 0 : 1));
    let i = n;
    let j = m;
    while (i > 0) {
      if (i > 0 && j > 0 && d[i]![j] === d[i - 1]![j - 1]! + (e[i - 1] === t[j - 1] ? 0 : 1)) { add(e[i - 1]!, e[i - 1] === t[j - 1]); i--; j--; }
      else if (i > 0 && d[i]![j] === d[i - 1]![j]! + 1) { add(e[i - 1]!, false); i--; }
      else j--;
    }
  }
  return out;
}
