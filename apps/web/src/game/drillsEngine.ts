import type { TypingDrillWord } from "@english-lab/contracts";

/**
 * Pure Finger Drills logic (TASK_033): no DOM, no Date.now. Words stand in lines like a page; each one is typed and closed with a
 * space. Nothing hurries the learner: a wrong key is never accepted (the right one is typed instead) but costs one life, and the level
 * is lost when no lives are left. Layout is in even units: a letter takes one unit and the gap after a word SPACE_UNITS (room for the
 * meteors).
 */

/** width of a line in units */
export const LINE_UNITS = 48;
/** the gap after every word, in units (typed as one space) */
export const SPACE_UNITS = 3;
/** from this many lives left the game warns that they are running out */
export const LOW_LIVES = 3;
const MAX_PAIR_INTERVAL_MS = 2000;
/** after a wrong key costs a life, further wrong keys within this time still count as mistakes but cost no life (a burst of slips is one loss) */
export const LIFE_GRACE_MS = 1000;

export interface DrillsLineWord {
  index: number;
  /** units of the line before this word */
  unitStart: number;
}

export interface DrillsLine {
  words: DrillsLineWord[];
  /** typed characters in the line: every word plus its space */
  chars: number;
  /** layout units of the line: every word plus its gap */
  units: number;
}

export interface DrillsWord {
  planIndex: number;
  lemma: string;
  /** letters typed; lemma.length means only the space is left */
  progress: number;
  mistakes: number;
  firstKeyAt: number | null;
  lastHitAt: number | null;
  typeMs: number | null;
  done: boolean;
  revealed: boolean;
}

export type DrillsEvent =
  | { type: "hit"; word: DrillsWord }
  | { type: "miss"; word: DrillsWord }
  | { type: "done"; word: DrillsWord; speak: boolean }
  | { type: "life"; left: number }
  | { type: "failed" }
  | { type: "won" };

export interface DrillsConfig {
  plan: TypingDrillWord[];
  lives: number;
}

export interface DrillsEngineState {
  plan: TypingDrillWord[];
  words: DrillsWord[];
  lines: DrillsLine[];
  /** line of each word */
  lineOf: number[];
  current: number;
  line: number;
  /** active time runs from the first key */
  started: boolean;
  lives: number;
  activeMs: number;
  charsTyped: number;
  errors: number;
  errorSeq: number;
  /** when the last life was lost (nowMs), to apply the grace time */
  lastLifeAt: number | null;
  streak: number;
  bestStreak: number;
  charStreak: number;
  bestCharStreak: number;
  won: boolean;
  failed: boolean;
  paused: boolean;
  keyStats: Map<string, { count: number; totalMs: number; errors: number }>;
}

export function buildLines(plan: readonly { lemma: string }[], unitsPerLine = LINE_UNITS): DrillsLine[] {
  const lines: DrillsLine[] = [];
  let cur: DrillsLine = { words: [], chars: 0, units: 0 };
  plan.forEach((w, index) => {
    const units = w.lemma.length + SPACE_UNITS;
    // the last gap of a line may run past the edge: only the letters must fit
    if (cur.words.length > 0 && cur.units + w.lemma.length > unitsPerLine) {
      lines.push(cur);
      cur = { words: [], chars: 0, units: 0 };
    }
    cur.words.push({ index, unitStart: cur.units });
    cur.chars += w.lemma.length + 1;
    cur.units += units;
  });
  if (cur.words.length > 0) lines.push(cur);
  return lines;
}

export function createDrillsEngine(config: DrillsConfig): DrillsEngineState {
  const lines = buildLines(config.plan);
  const lineOf: number[] = [];
  lines.forEach((l, i) => l.words.forEach((w) => (lineOf[w.index] = i)));
  return {
    plan: config.plan,
    words: config.plan.map((p) => ({ planIndex: p.planIndex, lemma: p.lemma, progress: 0, mistakes: 0, firstKeyAt: null, lastHitAt: null, typeMs: null, done: false, revealed: false })),
    lines,
    lineOf,
    current: 0,
    line: 0,
    started: false,
    lives: config.lives,
    activeMs: 0,
    charsTyped: 0,
    errors: 0,
    errorSeq: 0,
    lastLifeAt: null,
    streak: 0,
    bestStreak: 0,
    charStreak: 0,
    bestCharStreak: 0,
    won: false,
    failed: false,
    paused: false,
    keyStats: new Map(),
  };
}

const over = (s: DrillsEngineState): boolean => s.paused || s.won || s.failed;

/** only the active time runs: nothing moves on its own */
export function tickDrills(s: DrillsEngineState, dtMs: number): void {
  if (!over(s) && s.started) s.activeMs += dtMs;
}

export function handleDrillKey(s: DrillsEngineState, key: string, nowMs: number): DrillsEvent[] {
  const events: DrillsEvent[] = [];
  if (over(s)) return events;
  const k = key === " " ? " " : key.toLowerCase();
  if (!/^[a-z ]$/.test(k)) return events;
  const w = s.words[s.current];
  if (!w) return events;
  s.started = true;
  const expected = w.progress < w.lemma.length ? w.lemma[w.progress]! : " ";
  const facts = (pair: string) => s.keyStats.get(pair) ?? s.keyStats.set(pair, { count: 0, totalMs: 0, errors: 0 }).get(pair)!;
  s.charsTyped += 1;

  if (k !== expected) {
    s.errors += 1;
    s.errorSeq += 1;
    s.streak = 0;
    s.charStreak = 0;
    w.mistakes += 1;
    if (expected !== " " && w.progress >= 1) facts(w.lemma.slice(w.progress - 1, w.progress + 1)).errors++;
    events.push({ type: "miss", word: w });
    if (s.lastLifeAt !== null && nowMs - s.lastLifeAt < LIFE_GRACE_MS) return events;
    s.lastLifeAt = nowMs;
    s.lives = Math.max(0, s.lives - 1);
    events.push({ type: "life", left: s.lives });
    if (s.lives === 0) {
      s.failed = true;
      events.push({ type: "failed" });
    }
    return events;
  }

  s.charStreak += 1;
  s.bestCharStreak = Math.max(s.bestCharStreak, s.charStreak);
  if (expected !== " ") {
    if (w.progress === 0) w.firstKeyAt = nowMs;
    else if (w.lastHitAt !== null) {
      const dt = nowMs - w.lastHitAt;
      if (dt > 0 && dt <= MAX_PAIR_INTERVAL_MS) {
        const f = facts(w.lemma.slice(w.progress - 1, w.progress + 1));
        f.count++;
        f.totalMs += Math.round(dt);
      }
    }
    w.lastHitAt = nowMs;
    w.progress += 1;
    events.push({ type: "hit", word: w });
    // the very last word needs no space: its last letter ends the level
    if (w.progress === w.lemma.length && s.current === s.words.length - 1) finishWord(s, w, nowMs, events);
    return events;
  }

  // the space closes the word
  finishWord(s, w, nowMs, events);
  return events;
}

function finishWord(s: DrillsEngineState, w: DrillsWord, nowMs: number, events: DrillsEvent[]): void {
  w.done = true;
  w.typeMs = w.firstKeyAt === null ? null : Math.max(0, Math.round(nowMs - w.firstKeyAt));
  s.streak = w.mistakes === 0 ? s.streak + 1 : 0;
  s.bestStreak = Math.max(s.bestStreak, s.streak);
  events.push({ type: "done", word: w, speak: s.plan[w.planIndex]?.speak ?? false });
  s.current += 1;
  if (s.current >= s.words.length) {
    s.won = true;
    events.push({ type: "won" });
  } else if (s.lineOf[s.current] !== s.line) {
    s.line = s.lineOf[s.current]!;
  }
}

/** F3: the translation of the word being typed */
export function revealDrillTranslation(s: DrillsEngineState): void {
  const w = s.words[s.current];
  if (w && !over(s)) w.revealed = true;
}

export function setDrillsPaused(s: DrillsEngineState, paused: boolean): void {
  s.paused = paused;
}

/** the words reached so far, in order, as the completion request wants them */
export function exportDrillWords(s: DrillsEngineState): Array<{ planIndex: number; errors: number; completed: boolean; typeMs: number | null }> {
  const out = s.words.slice(0, s.current).map((w) => ({ planIndex: w.planIndex, errors: w.mistakes, completed: true, typeMs: w.typeMs }));
  const cur = s.words[s.current];
  if (cur && (cur.progress > 0 || cur.mistakes > 0)) out.push({ planIndex: cur.planIndex, errors: cur.mistakes, completed: false, typeMs: null });
  return out;
}

export function exportDrillKeyStats(s: DrillsEngineState): Array<{ pair: string; count: number; totalMs: number; errors: number }> {
  return [...s.keyStats].map(([pair, f]) => ({ pair, ...f })).filter((f) => /^[a-z-]{2}$/.test(f.pair) && (f.count > 0 || f.errors > 0));
}
