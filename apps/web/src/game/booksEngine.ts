import { buildKeys, splitSentences, tokensOf, type TypingToken } from "@english-lab/contracts";

/**
 * Pure Books-game logic: no DOM, no Date.now. The host feeds `tick(dtMs)` (to accumulate inter-key gaps) and `key()`. The text
 * and its required keys come from `@english-lab/contracts`, so the client and server agree on offsets and char counts.
 * Active time is the sum of gaps between keypresses, each capped at 5 seconds, so reading pauses never inflate WPM.
 */

export interface BooksEngineState {
  /** full level text (from startOffset to endOffset), indexed as offset - startOffset */
  text: string;
  /** current position, as an index into `text` (0-based, relative to the level slice) */
  offset: number;
  /** words of the level (with their trailing punctuation), in order; each one is a meteor */
  tokens: TypingToken[];
  /** end offsets of the tokens, to know when a word is finished */
  tokenEnds: Set<number>;
  /** every required key of the level, in order */
  allKeys: Array<{ offset: number; key: string }>;
  /** required keys still to type, in order (offset relative to the level slice) */
  remaining: Array<{ offset: number; key: string }>;
  /** incorrect characters pending deletion (shown red) */
  errors: string[];
  /** text offsets where a wrong key was pressed before the right one (their typed letter is shown in the "had errors" colour) */
  slipped: Set<number>;
  /** capital letters typed in lower case: accepted, but flagged as a visual reminder, never an error */
  capsMissed: Set<number>;
  activeMs: number;
  charsTyped: number;
  errorCount: number;
  /** time since the last keypress (capped when a key is pressed) */
  sinceLastKeyMs: number;
  finished: boolean;
  /** letter-pair facts of the level (see wordsEngine): correct presses with the gap since the previous key, and wrong keys */
  keyStats: Map<string, { count: number; totalMs: number; errors: number }>;
  /** Precision Combo: characters in a row typed correctly the first time. A wrong key resets it; Backspace, pauses and speed do not matter, and a character that was
   *  corrected after a mistake is never counted. */
  combo: number;
  bestCombo: number;
  /** game score: one point per combo character times the tier multiplier. Display only. */
  comboScore: number;
  /** counts the milestones reached (the scene flashes when it changes) */
  milestoneSeq: number;
}

/** the combo milestones, in characters */
export const COMBO_MILESTONES = [10, 25, 50, 100, 200] as const;
const TIER_MULTIPLIER = [1, 1.1, 1.2, 1.3, 1.5, 2] as const;

/** 0 below the first milestone, up to 5 from 200 characters */
export const comboTier = (n: number): number => COMBO_MILESTONES.filter((m) => n >= m).length;
export const comboMultiplier = (n: number): number => TIER_MULTIPLIER[comboTier(n)]!;
/** the next milestone above `n`, or null after the last one */
export const nextMilestone = (n: number): number | null => COMBO_MILESTONES.find((m) => m > n) ?? null;

/** what one key press did: `ignored` presses (a stray space, an unknown key) change and count nothing */
export type BookKeyKind = "ok" | "error" | "capital" | "ignored" | "back";
export interface BookKeyResult {
  finished: boolean;
  tokenComplete: boolean;
  kind: BookKeyKind;
}

export interface BooksEngineConfig {
  text: string;
  startOffset: number;
  initialOffset: number;
  initialActiveMs: number;
  initialCharsTyped: number;
  initialErrors: number;
}

/** All required keys of `[start, end)` in the level text, in order. */
export function keysForRange(text: string, start: number, end: number): Array<{ offset: number; key: string }> {
  const out: Array<{ offset: number; key: string }> = [];
  for (const s of splitSentences(text)) {
    if (s.end <= start) continue;
    if (s.start >= end) break;
    for (const k of buildKeys(text, Math.max(s.start, start), Math.min(s.end, end))) out.push(k);
  }
  return out;
}

const MAX_GAP_MS = 5000;

export function createBooksEngine(config: BooksEngineConfig): BooksEngineState {
  const localStart = Math.max(0, config.initialOffset - config.startOffset);
  const allKeys = keysForRange(config.text, 0, config.text.length);
  const tokens = splitSentences(config.text).flatMap((sent) => tokensOf(config.text, sent));
  const remaining = allKeys.filter((k) => k.offset >= localStart);
  const offset = remaining.length ? remaining[0]!.offset : config.text.length;
  return {
    text: config.text,
    offset,
    tokens,
    tokenEnds: new Set(tokens.map((t) => t.endOffset)),
    allKeys,
    remaining,
    errors: [],
    slipped: new Set(),
    capsMissed: new Set(),
    activeMs: config.initialActiveMs,
    charsTyped: config.initialCharsTyped,
    errorCount: config.initialErrors,
    sinceLastKeyMs: 0,
    finished: remaining.length === 0,
    keyStats: new Map(),
    combo: 0,
    bestCombo: 0,
    comboScore: 0,
    milestoneSeq: 0,
  };
}

export function nextKey(s: BooksEngineState): string | null {
  return s.remaining[0]?.key ?? null;
}

export function tickBooks(s: BooksEngineState, dtMs: number): void {
  if (s.finished) return;
  s.sinceLastKeyMs += dtMs;
}

function recordGap(s: BooksEngineState): void {
  s.activeMs += Math.min(s.sinceLastKeyMs, MAX_GAP_MS);
  s.sinceLastKeyMs = 0;
}

const isUpper = (ch: string): boolean => ch !== ch.toLowerCase() && ch === ch.toUpperCase();

export function handleBookKey(s: BooksEngineState, key: string): BookKeyResult {
  if (s.finished) return { finished: true, tokenComplete: false, kind: "ignored" };

  if (key === "Backspace") {
    // deleting is not a typed character: counting it would dilute the error rate
    recordGap(s);
    if (s.errors.length > 0) {
      s.errors.pop();
      return { finished: false, tokenComplete: false, kind: "back" };
    }
    const all = s.allKeys;
    if (s.remaining.length > 0) {
      const front = s.remaining[0]!;
      const idx = all.findIndex((k) => k.offset === front.offset);
      if (idx > 0) s.remaining.unshift(all[idx - 1]!);
    } else if (all.length > 0) {
      s.remaining.unshift(all[all.length - 1]!);
    }
    s.offset = s.remaining.length ? s.remaining[0]!.offset : s.text.length;
    s.finished = false;
    return { finished: false, tokenComplete: false, kind: "back" };
  }

  const expected = nextKey(s);
  if (expected === null) return { finished: true, tokenComplete: false, kind: "ignored" };
  // a space where none is expected is not a wrong letter: nothing is shown, counted or required to delete
  if (key === " " && expected !== " ") return { finished: false, tokenComplete: false, kind: "ignored" };

  const gap = s.sinceLastKeyMs;
  recordGap(s);
  s.charsTyped += 1;
  const k = key.length === 1 ? key.toLowerCase() : key;
  const pairAt = (at: number): string | null => {
    const pair = (s.text.charAt(at - 1) + s.text.charAt(at)).toLowerCase();
    return at >= 1 && /^[a-z-]{2}$/.test(pair) ? pair : null;
  };
  const facts = (pair: string) => s.keyStats.get(pair) ?? s.keyStats.set(pair, { count: 0, totalMs: 0, errors: 0 }).get(pair)!;
  const wrong = (): BookKeyResult => {
    s.combo = 0;
    const wp = pairAt(s.offset);
    if (wp && s.errors.length === 0) facts(wp).errors++; // the first wrong key of an expected letter counts against its pair

    if (s.errors.length < 3) s.errors.push(key.length === 1 ? key : k);
    s.slipped.add(s.offset);
    s.errorCount += 1;
    return { finished: false, tokenComplete: false, kind: "error" };
  };

  if (k === expected) {
    if (s.errors.length > 0) return wrong(); // the right key while a red mistake is pending still counts as a mistake
    const at = s.offset;
    const cp = pairAt(at);
    if (cp && !s.slipped.has(at) && gap > 0 && gap <= 2000) {
      const f = facts(cp);
      f.count++;
      f.totalMs += Math.round(gap);
    }
    // a character that was corrected after a mistake does not count again; every other one extends the combo
    if (!s.slipped.has(at)) {
      s.combo++;
      s.bestCombo = Math.max(s.bestCombo, s.combo);
      s.comboScore += comboMultiplier(s.combo);
      if ((COMBO_MILESTONES as readonly number[]).includes(s.combo)) s.milestoneSeq++;
    }
    const shown = s.text.charAt(at);
    // a capital letter typed in lower case moves on, with a visual reminder (names, first word of a sentence)
    const capital = key.length === 1 && /[A-Za-z]/.test(key) && isUpper(shown) && key === key.toLowerCase();
    if (capital) s.capsMissed.add(at);
    else s.capsMissed.delete(at);
    s.remaining.shift();
    s.offset = s.remaining.length ? s.remaining[0]!.offset : s.text.length;
    const finished = s.remaining.length === 0;
    if (finished) s.finished = true;
    return { finished, tokenComplete: tokenBoundary(s), kind: capital ? "capital" : "ok" };
  }
  return wrong();
}

function tokenBoundary(s: BooksEngineState): boolean {
  return s.tokenEnds.has(s.offset);
}

export function currentToken(s: BooksEngineState): TypingToken | null {
  const cursor = s.offset;
  return s.tokens.find((t) => cursor >= t.startOffset && cursor <= t.endOffset) ?? null;
}
