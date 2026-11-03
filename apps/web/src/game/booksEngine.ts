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
  /** required keys still to type, in order (offset relative to the level slice) */
  remaining: Array<{ offset: number; key: string }>;
  /** incorrect characters pending deletion (red) */
  errors: string[];
  activeMs: number;
  charsTyped: number;
  errorCount: number;
  /** time since the last keypress (capped when a key is pressed) */
  sinceLastKeyMs: number;
  finished: boolean;
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
  const remaining = allKeys.filter((k) => k.offset >= localStart);
  const offset = remaining.length ? remaining[0]!.offset : config.text.length;
  return {
    text: config.text,
    offset,
    remaining,
    errors: [],
    activeMs: config.initialActiveMs,
    charsTyped: config.initialCharsTyped,
    errorCount: config.initialErrors,
    sinceLastKeyMs: 0,
    finished: remaining.length === 0,
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

export function handleBookKey(s: BooksEngineState, key: string): { finished: boolean; tokenComplete: boolean } {
  if (s.finished) return { finished: true, tokenComplete: false };

  if (key === "Backspace") {
    recordGap(s);
    s.charsTyped += 1;
    if (s.errors.length > 0) {
      s.errors.pop();
      return { finished: false, tokenComplete: false };
    }
    const all = keysForRange(s.text, 0, s.text.length);
    if (s.remaining.length > 0) {
      const front = s.remaining[0]!;
      const idx = all.findIndex((k) => k.offset === front.offset);
      if (idx > 0) s.remaining.unshift(all[idx - 1]!);
    } else if (all.length > 0) {
      s.remaining.unshift(all[all.length - 1]!);
    }
    s.offset = s.remaining.length ? s.remaining[0]!.offset : s.text.length;
    return { finished: false, tokenComplete: false };
  }

  const expected = nextKey(s);
  if (expected === null) return { finished: true, tokenComplete: false };

  recordGap(s);
  s.charsTyped += 1;
  const k = key.length === 1 ? key.toLowerCase() : key;

  if (k === expected) {
    if (s.errors.length > 0) {
      if (s.errors.length < 3) s.errors.push(k);
      s.errorCount += 1;
      return { finished: false, tokenComplete: false };
    }
    s.remaining.shift();
    s.offset = s.remaining.length ? s.remaining[0]!.offset : s.text.length;
    const finished = s.remaining.length === 0;
    if (finished) s.finished = true;
    return { finished, tokenComplete: tokenBoundary(s) };
  }

  if (s.errors.length < 3) s.errors.push(k);
  s.errorCount += 1;
  return { finished: false, tokenComplete: false };
}

function tokenBoundary(s: BooksEngineState): boolean {
  const cursor = s.offset;
  const tokens = splitSentences(s.text).flatMap((sent) => tokensOf(s.text, sent));
  return tokens.some((t) => t.endOffset === cursor);
}

export function currentToken(s: BooksEngineState): TypingToken | null {
  const cursor = s.offset;
  for (const sent of splitSentences(s.text)) {
    if (cursor < sent.start || cursor > sent.end) continue;
    for (const tok of tokensOf(s.text, sent)) {
      if (cursor >= tok.startOffset && cursor <= tok.endOffset) return tok;
    }
  }
  return null;
}
