import { mergeContractions, rawTokens, sameWord, tokenize } from "@english-lab/contracts";

/**
 * Align what was typed with the BEGINNING of the expected sentence: the words not typed yet cost nothing. Returns, for every typed token,
 * whether it matches (`true`) or is wrong / extra (`false`), and how many expected tokens are used up.
 */
function alignPrefix(expected: readonly string[], typed: readonly string[]): { ok: boolean[]; consumed: number } {
  const n = expected.length;
  const m = typed.length;
  const d: number[][] = Array.from({ length: n + 1 }, (_, i) => [i, ...Array<number>(m).fill(0)]);
  for (let j = 1; j <= m; j++) d[0]![j] = j;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (sameWord(expected[i - 1]!, typed[j - 1]!) ? 0 : 1));
  let end = 0;
  for (let i = 1; i <= n; i++) if (d[i]![m]! <= d[end]![m]!) end = i; // on a tie prefer the longer reading: it keeps the right words that follow a wrong one
  const ok = Array<boolean>(m).fill(false);
  let i = end;
  let j = m;
  while (j > 0) {
    if (i > 0 && d[i]![j] === d[i - 1]![j - 1]! + (sameWord(expected[i - 1]!, typed[j - 1]!) ? 0 : 1)) {
      ok[j - 1] = sameWord(expected[i - 1]!, typed[j - 1]!);
      i--;
      j--;
    } else if (i > 0 && d[i]![j] === d[i - 1]![j]! + 1) i--;
    else j--; // an extra typed word
  }
  return { ok, consumed: end };
}

const CYRILLIC_CHAR = /[Ѐ-ӿ]/;

export interface MarkedSegment {
  text: string;
  /** a wrong word, or Russian-layout letters */
  wrong: boolean;
}

/**
 * Which words of what the learner has typed so far are wrong, so they can be shown in red. A word counts once it is finished (followed by a
 * space); the word still being typed is red only when it cannot become the next expected word. Missing words cannot be marked (they are not in
 * the text); the hint shows them. Uses the same comparison as the server (case, punctuation and regional spelling do not matter).
 */
export function markTyped(typed: string, expected: string, allFinished = false): MarkedSegment[] {
  const expectedTokens = tokenize(expected);
  const words = [...typed.matchAll(/\S+/g)].map((m) => ({ start: m.index!, end: m.index! + m[0].length, tokens: rawTokens(m[0]) }));
  // after Enter or Hint every word counts as finished; while typing the last one is still being written
  const lastIsPartial = !allFinished && words.length > 0 && words[words.length - 1]!.end === typed.length;
  const finished = lastIsPartial ? words.slice(0, -1) : words;
  const merged = mergeContractions(finished.flatMap((w, owner) => w.tokens.map((tok) => ({ tok, owner }))));
  const { ok, consumed } = alignPrefix(expectedTokens, merged.map((x) => x.tok));
  const redWord = new Set<number>();
  ok.forEach((good, k) => {
    if (!good) redWord.add(merged[k]!.owner);
  });
  const partial = lastIsPartial ? words[words.length - 1]! : null;
  const partialRed =
    partial !== null &&
    partial.tokens.length > 0 &&
    (() => {
      // the next expected word, or the one before it (after an inserted word the alignment may have used up the right one)
      const t = partial.tokens[0]!;
      const candidates = [expectedTokens[consumed], expectedTokens[consumed - 1]].filter((x): x is string => x !== undefined);
      return !candidates.some((n) => n.startsWith(t) || sameWord(n, t));
    })();

  const segments: MarkedSegment[] = [];
  let pos = 0;
  const push = (text: string, wrong: boolean) => {
    if (text.length === 0) return;
    const last = segments[segments.length - 1];
    if (last && last.wrong === wrong) last.text += text;
    else segments.push({ text, wrong });
  };
  words.forEach((w, i) => {
    push(typed.slice(pos, w.start), false);
    const isPartial = partial !== null && w === partial;
    const red = isPartial ? partialRed : redWord.has(i);
    // Russian-layout letters are always red, wherever they are
    for (const ch of typed.slice(w.start, w.end)) push(ch, red || CYRILLIC_CHAR.test(ch));
    pos = w.end;
  });
  push(typed.slice(pos), false);
  return segments;
}

/** while typing nothing is judged; only letters typed on the Russian layout are red */
export function cyrillicOnly(typed: string): MarkedSegment[] {
  const out: MarkedSegment[] = [];
  for (const ch of typed) {
    const wrong = CYRILLIC_CHAR.test(ch);
    const last = out[out.length - 1];
    if (last && last.wrong === wrong) last.text += ch;
    else out.push({ text: ch, wrong });
  }
  return out;
}

/** index of the last word of the revealed prefix (the word a hint is about), or null when nothing is shown from the start */
export function hintFocus(words: ReadonlyArray<{ text: string | null }>): number | null {
  let k = -1;
  while (k + 1 < words.length && words[k + 1]!.text !== null) k++;
  return k >= 0 ? k : null;
}
