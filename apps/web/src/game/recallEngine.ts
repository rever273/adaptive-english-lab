/**
 * The memory check after a Words level: up to three saved words, each shown only by its Russian translation (on a star). The learner types
 * any of them; the first letter picks the word, then it is typed to the end. Wrong keys cost nothing but are counted; F4 fills the next
 * letter, F5 shows the whole word (no points). Pure logic, no DOM.
 */
export interface RecallWordState {
  entryId: string;
  lemma: string;
  translationRu: string;
  /** an example sentence with the word blanked out, shown to help remember it (null when there is none) */
  sentence: string | null;
  /** letters filled so far (typed, hinted or revealed) */
  filled: number;
  /** how each filled letter got there: typed from memory, or given by F4 / F5 */
  kinds: Array<"typed" | "hinted">;
  /** letters typed correctly by the learner */
  typedLetters: number;
  wrongKeys: number;
  hints: number;
  revealed: boolean;
  done: boolean;
}

export interface RecallState {
  words: RecallWordState[];
  /** the word being typed (index), null while none is chosen */
  active: number | null;
  /** keys that matched no word at all (before one was chosen) */
  looseWrongKeys: number;
}

export function createRecall(words: ReadonlyArray<{ entryId: string; lemma: string; translationRu: string; sentence?: string | null }>): RecallState {
  return { words: words.map((w) => ({ ...w, sentence: w.sentence ?? null, filled: 0, kinds: [], typedLetters: 0, wrongKeys: 0, hints: 0, revealed: false, done: false })), active: null, looseWrongKeys: 0 };
}

export type RecallKeyResult = { kind: "ok" | "wrong" | "ignored"; word: number | null; finishedWord: boolean };

const ignored: RecallKeyResult = { kind: "ignored", word: null, finishedWord: false };

function complete(s: RecallState, i: number): boolean {
  const w = s.words[i]!;
  if (w.filled >= w.lemma.length) {
    w.done = true;
    if (s.active === i) s.active = null;
    return true;
  }
  return false;
}

export function recallKey(s: RecallState, key: string): RecallKeyResult {
  const k = key.toLowerCase();
  if (!/^[a-z]$/.test(k) || isFinished(s)) return ignored;
  if (s.active === null) {
    const i = s.words.findIndex((w) => !w.done && w.filled === 0 && w.lemma[0] === k);
    if (i < 0) {
      s.looseWrongKeys++;
      return { kind: "wrong", word: null, finishedWord: false };
    }
    s.active = i;
  }
  const i = s.active!;
  const w = s.words[i]!;
  if (w.lemma[w.filled] !== k) {
    w.wrongKeys++;
    return { kind: "wrong", word: i, finishedWord: false };
  }
  w.filled++;
  w.kinds.push("typed");
  w.typedLetters++;
  return { kind: "ok", word: i, finishedWord: complete(s, i) };
}

const target = (s: RecallState): number | null => s.active ?? (s.words.findIndex((w) => !w.done) >= 0 ? s.words.findIndex((w) => !w.done) : null);

/** F4: the next letter of the word being typed (or of the first unsolved word) appears by itself; it costs points */
export function recallHint(s: RecallState): RecallKeyResult {
  const i = target(s);
  if (i === null) return ignored;
  const w = s.words[i]!;
  s.active = i;
  w.hints++;
  w.kinds.push("hinted");
  w.filled++;
  return { kind: "ok", word: i, finishedWord: complete(s, i) };
}

/** F5: the whole word; no points for it */
export function recallReveal(s: RecallState): RecallKeyResult {
  const i = target(s);
  if (i === null) return ignored;
  const w = s.words[i]!;
  w.revealed = true;
  while (w.kinds.length < w.lemma.length) w.kinds.push("hinted");
  w.filled = w.lemma.length;
  w.done = true;
  if (s.active === i) s.active = null;
  return { kind: "ok", word: i, finishedWord: true };
}

export const isFinished = (s: RecallState): boolean => s.words.every((w) => w.done);

/** what the server wants: the raw counts per word */
export function recallResults(s: RecallState): Array<{ entryId: string; correctKeys: number; wrongKeys: number; hints: number; revealed: boolean }> {
  return s.words.map((w) => ({ entryId: w.entryId, correctKeys: w.typedLetters, wrongKeys: w.wrongKeys, hints: w.hints, revealed: w.revealed }));
}

/** the same rule as the server's (display only: the server computes the stored points) */
export const wordPoints = (w: Pick<RecallWordState, "wrongKeys" | "hints" | "revealed">): number => (w.revealed ? 0 : Math.max(0, Math.round(10 - 3 * w.hints - 0.5 * w.wrongKeys)));
