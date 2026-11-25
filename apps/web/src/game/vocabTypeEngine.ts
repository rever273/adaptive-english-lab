/**
 * Pure typing logic of Vocabulary Typing (a word in stage 1, a sentence in stage 2): no DOM, no clock of its own. A wrong key is counted and shown but
 * does not move the cursor and nothing is erased (as in Qwerty Learner). A capital letter may be typed in lower case. Active time is the sum of the gaps
 * between key presses, each capped at 5 s, so time spent thinking before the decision never inflates the speed.
 */
export interface KeyPair {
  count: number;
  totalMs: number;
  errors: number;
}

export interface TyperState {
  /** what has to be typed (typographic quotes straightened) */
  target: string;
  pos: number;
  /** the last key was wrong and the cursor has not moved since */
  wrong: boolean;
  /** correct keys */
  chars: number;
  errors: number;
  activeMs: number;
  lastKeyAt: number | null;
  done: boolean;
  pairs: Record<string, KeyPair>;
  /** positions where a wrong key was pressed before the right one (shown red once typed, as in Key Builder) */
  missed: number[];
}

export const GAP_CAP_MS = 5000;

export const typingTarget = (text: string): string => text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();

export function createTyper(text: string): TyperState {
  const target = typingTarget(text);
  return { target, pos: 0, wrong: false, chars: 0, errors: 0, activeMs: 0, lastKeyAt: null, done: target.length === 0, pairs: {}, missed: [] };
}

const isLetter = (c: string | undefined): c is string => c !== undefined && /^[A-Za-z-]$/.test(c);

function bump(s: TyperState, pair: string, ms: number, error: boolean): void {
  const p = (s.pairs[pair] ??= { count: 0, totalMs: 0, errors: 0 });
  if (error) p.errors++;
  else {
    p.count++;
    p.totalMs += ms;
  }
}

/** one key press at time `now` (ms); returns a new state and what the press did. Keys that are not a single character (Shift, F4, Tab...) are ignored. */
export function typeKey(s: TyperState, key: string, now: number): { state: TyperState; result: "ok" | "error" | "ignored" } {
  if (s.done || key.length !== 1) return { state: s, result: "ignored" };
  const expected = s.target[s.pos]!;
  const gap = s.lastKeyAt === null ? 0 : Math.min(GAP_CAP_MS, Math.max(0, now - s.lastKeyAt));
  const next: TyperState = { ...s, pairs: { ...s.pairs }, lastKeyAt: now, activeMs: s.activeMs + gap };
  const prev = s.pos > 0 ? s.target[s.pos - 1] : undefined;
  const lower = expected.toLowerCase();
  const matches = key === expected || (expected !== lower && key === lower);
  if (!matches) {
    next.errors++;
    next.wrong = true;
    if (!s.missed.includes(s.pos)) next.missed = [...s.missed, s.pos];
    if (isLetter(prev) && isLetter(expected)) bump(next, `${prev}${expected}`.toLowerCase(), gap, true);
    return { state: next, result: "error" };
  }
  next.pos = s.pos + 1;
  next.chars++;
  next.wrong = false;
  next.done = next.pos >= s.target.length;
  if (isLetter(prev) && isLetter(expected) && s.lastKeyAt !== null) bump(next, `${prev}${expected}`.toLowerCase(), gap, false);
  return { state: next, result: "ok" };
}

/** the typing facts a decision carries to the server */
export const typingFacts = (s: TyperState): { activeMs: number; chars: number; errors: number } => ({ activeMs: Math.round(s.activeMs), chars: s.chars, errors: s.errors });

/** letter-pair facts for the session's key statistics (only valid pairs, as the server accepts) */
export function keyStatsOf(pairs: Record<string, KeyPair>): Array<{ pair: string; count: number; totalMs: number; errors: number }> {
  return Object.entries(pairs)
    .filter(([pair, p]) => /^[a-z-]{2}$/.test(pair) && (p.count > 0 || p.errors > 0))
    .map(([pair, p]) => ({ pair, count: p.count, totalMs: Math.round(p.totalMs), errors: p.errors }))
    .slice(0, 400);
}

/** merges the pair facts of several texts */
export function mergePairs(a: Record<string, KeyPair>, b: Record<string, KeyPair>): Record<string, KeyPair> {
  const out: Record<string, KeyPair> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const o = out[k] ?? { count: 0, totalMs: 0, errors: 0 };
    out[k] = { count: o.count + v.count, totalMs: o.totalMs + v.totalMs, errors: o.errors + v.errors };
  }
  return out;
}
