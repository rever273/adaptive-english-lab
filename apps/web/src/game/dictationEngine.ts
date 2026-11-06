import type { DictationAnswerResponse, DictationExerciseState, DictationState, DictationWord } from "@english-lab/contracts";

/** DOM-free logic of Audio Dictation. The server is the source of truth: after a reload `DictationState` rebuilds everything. */
export type DictationPhase = "listening" | "checking" | "confirmed" | "complete";

export interface DictationEngine {
  lessonId: string;
  exercises: DictationExerciseState[];
  /** index into `exercises` of the current sentence, null when the lesson is complete */
  current: number | null;
  phase: DictationPhase;
  text: string;
  attemptId: string;
  /** a message after a wrong answer (neutral, no sound) */
  notice: string | null;
  activeMs: number;
}

const CYRILLIC = /[Ѐ-ӿ]/;
export const IDLE_LIMIT_MS = 30_000;

export function createDictationEngine(state: DictationState, newId: () => string = () => crypto.randomUUID()): DictationEngine {
  const current = state.currentOrdinal === null ? null : state.exercises.findIndex((e) => e.ordinal === state.currentOrdinal);
  return { lessonId: state.lessonId, exercises: state.exercises.map((e) => ({ ...e })), current: current === null || current < 0 ? null : current, phase: current === null ? "complete" : "listening", text: "", attemptId: newId(), notice: null, activeMs: state.activeMs };
}

export const currentExercise = (e: DictationEngine): DictationExerciseState | null => (e.current === null ? null : e.exercises[e.current]!);

/** a changed text is a different attempt: a new idempotency id */
export function setText(e: DictationEngine, text: string, newId: () => string = () => crypto.randomUUID()): void {
  if (text === e.text) return;
  e.text = text;
  e.attemptId = newId();
  e.notice = null;
}

export type SubmitCheck = "ok" | "empty" | "layout" | "busy";
export function submitCheck(e: DictationEngine): SubmitCheck {
  if (e.phase !== "listening") return "busy";
  if (e.text.trim().length === 0) return "empty";
  // a Russian layout is only a reminder: no attempt and no hint are spent
  if (CYRILLIC.test(e.text)) return "layout";
  return "ok";
}

export function markChecking(e: DictationEngine): void {
  e.phase = "checking";
}

export function setWords(e: DictationEngine, words: DictationWord[], hintLevel: number): void {
  const ex = currentExercise(e);
  if (ex) {
    ex.words = words;
    ex.hintLevel = hintLevel;
  }
}

/** applies the server's verdict; returns what the interface should do next */
export function applyAnswer(e: DictationEngine, r: DictationAnswerResponse): "confirmed" | "wrong" {
  const ex = currentExercise(e);
  if (!ex) return "wrong";
  ex.attempts += 1;
  setWords(e, r.words, r.hintLevel);
  if (!r.correct) {
    e.phase = "listening";
    e.notice = "Not quite. Listen again and fix the highlighted part.";
    return "wrong";
  }
  ex.done = true;
  e.phase = "confirmed";
  e.notice = null;
  return "confirmed";
}

/** after the explosion: the next sentence or the end of the lesson */
export function advance(e: DictationEngine, nextOrdinal: number | null, newId: () => string = () => crypto.randomUUID()): void {
  const next = nextOrdinal === null ? -1 : e.exercises.findIndex((x) => x.ordinal === nextOrdinal);
  e.current = next < 0 ? null : next;
  e.phase = next < 0 ? "complete" : "listening";
  e.text = "";
  e.attemptId = newId();
  e.notice = null;
}

/**
 * Active time on a monotonic clock: it runs while the page is visible and either audio is playing or a key was pressed in the last 30 s.
 * Call `tick` often (for example every 250 ms); it adds the elapsed time only when the conditions hold.
 */
export class ActiveClock {
  private last: number | null = null;
  private lastInput = Number.NEGATIVE_INFINITY;
  ms: number;
  constructor(initialMs = 0) {
    this.ms = initialMs;
  }
  input(now: number): void {
    this.lastInput = now;
  }
  tick(now: number, o: { visible: boolean; playing: boolean }): void {
    if (this.last !== null && o.visible && (o.playing || now - this.lastInput <= IDLE_LIMIT_MS)) this.ms += Math.max(0, now - this.last);
    this.last = now;
  }
}
