import type { TypingPlanWord } from "@english-lab/contracts";

/**
 * Pure Words-game logic: no DOM, no Date.now. The host feeds `tick(dtMs)` from requestAnimationFrame and `key()` from a keyboard
 * handler. State is plain data; events are queued and drained by the host. The engine lives in a module (not a React ref) so
 * returning to the tab can find it again (D80).
 */

export interface WordsWord {
  planIndex: number;
  lemma: string;
  source: "general" | "vocabulary";
  /** 0..1 fall progress toward the defence line */
  y: number;
  /** lane index (host assigns a lane from the pool) */
  lane: number;
  /** typed correct characters so far */
  progress: number;
  /** wrong keys pressed while this word was locked (reported to the server for per-word statistics) */
  mistakes: number;
  /** whether the meteor is currently animating a destruction */
  destroying: boolean;
}

export type WordsEvent =
  | { type: "appeared"; word: WordsWord }
  /** a correct letter: one shot at the word */
  | { type: "hit"; word: WordsWord }
  /** a wrong key; `word` is the locked target (null when no word was locked) */
  | { type: "miss"; word: WordsWord | null }
  | { type: "destroyed"; word: WordsWord }
  | { type: "failed" }
  | { type: "won" };

export interface WordsEngineState {
  words: WordsWord[];
  /** all planned words in engine order */
  plan: TypingPlanWord[];
  /** indices not yet spawned */
  remainingPlan: number[];
  /** currently locked target (index into words) or null */
  target: number | null;
  destroyedCount: number;
  activeMs: number;
  charsTyped: number;
  errors: number;
  /** indices destroyed (order of destruction) */
  destroyedPlanIndexes: number[];
  /** appearance events already sent */
  appearances: Array<{ planIndex: number; order: number }>;
  won: boolean;
  failed: boolean;
  paused: boolean;
  /** time until the next spawn (<= 0 means ready to spawn) */
  spawnTimerMs: number;
  /** for the "no target on screen" fast-spawn rule */
  nextAppearanceOrder: number;
  /** counts wrong keys; the host restarts its shake animation whenever it changes */
  errorSeq: number;
  /** planIndex of the word that was locked at the last wrong key (null: no lock, shake every label) */
  errorPlanIndex: number | null;
}

export interface WordsEngineConfig {
  plan: TypingPlanWord[];
  fallMs: (len: number) => number;
  spawnGapMs: (prevLen: number) => number;
  /** number of concurrently active meteors the host allows (based on screen space) */
  maxActive: number;
}

export function createWordsEngine(config: WordsEngineConfig): WordsEngineState {
  return {
    words: [],
    plan: config.plan,
    remainingPlan: config.plan.map((_, i) => i),
    target: null,
    destroyedCount: 0,
    activeMs: 0,
    charsTyped: 0,
    errors: 0,
    destroyedPlanIndexes: [],
    appearances: [],
    won: false,
    failed: false,
    paused: false,
    spawnTimerMs: 0,
    nextAppearanceOrder: 0,
    errorSeq: 0,
    errorPlanIndex: null,
  };
}

const ACTIVE_MS_ONLY_WITH_TARGET = true;

/** letter used to lock a target: the first letter of its lemma (case-insensitive) */
const firstLetter = (w: string): string => w[0]!.toLowerCase();

/** Spawn the next word if the spawn timer elapsed and there is room. Returns the spawned word or null. */
function trySpawn(s: WordsEngineState, config: WordsEngineConfig): WordsWord | null {
  if (s.paused || s.failed || s.won) return null;
  if (s.remainingPlan.length === 0) return null;
  const active = s.words.filter((w) => !w.destroying).length;
  if (active >= config.maxActive) return null;
  if (active === 0) {
    // no target on screen: spawn immediately (<= 300ms)
  } else if (s.spawnTimerMs > 0) {
    return null;
  }
  const planIndex = s.remainingPlan.shift()!;
  const planWord = config.plan[planIndex]!;
  const word: WordsWord = {
    planIndex,
    lemma: planWord.lemma,
    source: planWord.source,
    y: 0,
    lane: 0, // host assigns a real lane when rendering
    progress: 0,
    mistakes: 0,
    destroying: false,
  };
  s.words.push(word);
  s.appearances.push({ planIndex, order: s.nextAppearanceOrder++ });
  s.spawnTimerMs = config.spawnGapMs(planWord.lemma.length);
  return word;
}

/** Advance all meteors toward the line; a meteor reaching y >= 1 while not destroying ends the game. */
function advance(s: WordsEngineState, dtMs: number, config: WordsEngineConfig): void {
  if (s.paused || s.failed || s.won) return;
  // active time runs only while the scene runs and there is at least one available (non-destroying) target
  const available = s.words.some((w) => !w.destroying);
  if (ACTIVE_MS_ONLY_WITH_TARGET && available) s.activeMs += dtMs;
  for (const w of s.words) {
    if (w.destroying) continue;
    const fallMs = config.fallMs(w.lemma.length);
    w.y += dtMs / fallMs;
    if (w.y >= 1) {
      s.failed = true;
      return;
    }
  }
}

export interface WordsTickResult {
  spawned: WordsWord | null;
  events: WordsEvent[];
}

export function tickWords(s: WordsEngineState, config: WordsEngineConfig, dtMs: number): WordsTickResult {
  const events: WordsEvent[] = [];
  if (!s.paused && !s.failed && !s.won) {
    s.spawnTimerMs -= dtMs;
    if (s.spawnTimerMs < 0) s.spawnTimerMs = 0;
    const spawned = trySpawn(s, config);
    if (spawned) events.push({ type: "appeared", word: spawned });
    advance(s, dtMs, config);
    if (s.failed) events.push({ type: "failed" });
  }
  return { spawned: null, events };
}

/**
 * A wrong key never changes the word (nothing is shown or to be deleted): it is counted, reported as a `miss` and the host
 * shakes the text. A correct letter is one shot; the word is destroyed on its last letter. Backspace does nothing here.
 */
export function handleWordKey(s: WordsEngineState, config: WordsEngineConfig, key: string): WordsEvent[] {
  const events: WordsEvent[] = [];
  if (s.paused || s.failed || s.won) return events;

  const k = key.toLowerCase();
  if (!/^[a-z-]$/.test(k)) return events;

  const miss = (word: WordsWord | null) => {
    s.errors += 1;
    s.charsTyped += 1;
    s.errorSeq += 1;
    s.errorPlanIndex = word ? word.planIndex : null;
    if (word) word.mistakes += 1;
    events.push({ type: "miss", word });
  };

  // no target: lock the matching word that is closest to the defence line (the one that will reach the ship first)
  if (s.target === null || (s.words[s.target]?.destroying ?? true)) {
    const candidates = s.words
      .filter((w) => !w.destroying && firstLetter(w.lemma) === k)
      .sort((a, b) => b.y - a.y);
    if (candidates.length === 0) {
      miss(null);
      return events;
    }
    s.target = s.words.indexOf(candidates[0]!);
  }

  const w = s.words[s.target]!;
  if (k !== w.lemma[w.progress]?.toLowerCase()) {
    miss(w);
    return events;
  }
  w.progress++;
  s.charsTyped += 1;
  events.push({ type: "hit", word: w });
  if (w.progress >= w.lemma.length) destroyWord(s, w, events);
  return events;
}

function destroyWord(s: WordsEngineState, w: WordsWord, events: WordsEvent[]): void {
  w.destroying = true;
  s.destroyedCount++;
  s.destroyedPlanIndexes.push(w.planIndex);
  events.push({ type: "destroyed", word: w });
  if (s.destroyedCount >= s.plan.length) {
    s.won = true;
    events.push({ type: "won" });
  }
}

export function setWordsPaused(s: WordsEngineState, paused: boolean): void {
  s.paused = paused;
}
