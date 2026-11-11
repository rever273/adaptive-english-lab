import type { TypingResult } from "./api";

/** Per-word observations are optional in older results; missing evidence is never a clean word. */
export function wordAccuracy(result: TypingResult) {
  if (result.mode !== "words" || !result.words) return null;
  const words = result.words, completed = words.filter(w => w.destroyed);
  const clean = completed.filter(w => w.errors === 0).length;
  const withErrors = words.filter(w => w.errors !== null && w.errors > 0).length;
  const unknown = words.filter(w => w.errors === null).length;
  const unknownCompleted = completed.some(w => w.errors === null);
  const recordedErrors = words.reduce((sum, w) => sum + (w.errors ?? 0), 0);
  return {
    shown: words.length, completed: completed.length, clean, withErrors, unknown,
    unfinished: words.length - completed.length,
    accuracy: completed.length > 0 && !unknownCompleted ? clean / completed.length * 100 : null,
    unassigned: unknown === 0 && recordedErrors <= result.metrics.errors ? result.metrics.errors - recordedErrors : null,
  };
}
