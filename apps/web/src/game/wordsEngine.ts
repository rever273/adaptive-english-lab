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
  /** incorrect characters pending deletion (red) */
  errors: string[];
  /** whether the meteor is currently animating a destruction */
  destroying: boolean;
}

export type WordsEvent =
  | { type: "appeared"; word: WordsWord }
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
  /** flashes: wrong letter without a target */
  flash: number;
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
    flash: 0,
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
    errors: [],
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
  // flash decay
  if (s.flash > 0) s.flash = Math.max(0, s.flash - dtMs);
  return { spawned: null, events };
}

export function handleWordKey(s: WordsEngineState, config: WordsEngineConfig, key: string): WordsEvent[] {
  const events: WordsEvent[] = [];
  if (s.paused || s.failed || s.won) return events;

  if (key === "Backspace") {
    s.charsTyped += 1;
    if (s.target === null) return events;
    const w = s.words[s.target]!;
    if (w.errors.length > 0) {
      w.errors.pop();
      return events;
    }
    if (w.progress > 0) {
      w.progress--;
      if (w.progress === 0) s.target = null; // clear lock when everything is deleted
    }
    return events;
  }

  const k = key.toLowerCase();
  if (!/^[a-z]$/.test(k)) return events;

  // no target: find the most dangerous available word whose first letter matches
  if (s.target === null || (s.words[s.target]?.destroying ?? true)) {
    const candidates = s.words
      .filter((w) => !w.destroying && firstLetter(w.lemma) === k)
      .sort((a, b) => (1 - b.y) * config.fallMs(b.lemma.length) - (1 - a.y) * config.fallMs(a.lemma.length));
    if (candidates.length === 0) {
      // wrong letter with no matching target: counts as an error, brief flash, nothing to delete
      s.errors += 1;
      s.charsTyped += 1;
      s.flash = 250;
      return events;
    }
    s.target = s.words.indexOf(candidates[0]!);
  }

  const w = s.words[s.target]!;
  const expected = w.lemma[w.progress + w.errors.length]?.toLowerCase();
  if (k === expected) {
    // correct: advance only when there are no pending red errors
    if (w.errors.length > 0) {
      w.errors.push(k);
      s.errors += 1;
      s.charsTyped += 1;
      return events;
    }
    w.progress++;
    s.charsTyped += 1;
    if (w.progress >= w.lemma.length) {
      destroyWord(s, w, events);
    }
    return events;
  }
  // wrong letter against the locked target
  if (w.errors.length < 3) w.errors.push(k);
  s.errors += 1;
  s.charsTyped += 1;
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
