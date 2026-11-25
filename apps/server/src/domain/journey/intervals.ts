import type { Db } from "../../db/open.js";

/**
 * Every table of measured practice time. One moment is counted once: a new interval of any mode must not overlap a recorded interval of any
 * table (D150, D157). A new practice mode adds its table here, and every writer checks the whole list.
 */
export const ACTIVITY_INTERVAL_TABLES = [
  "practice_activity_intervals",
  "journey_typing_intervals",
  "word_lesson_activity_intervals",
  "grammar_cloze_activity_intervals",
  "conversation_activity_intervals",
  "context_loop_activity_intervals",
  "vocab_typing_activity_intervals",
] as const;

export function overlapsRecordedActivity(db: Db, startMs: number, endMs: number, tables: readonly string[] = ACTIVITY_INTERVAL_TABLES): boolean {
  return tables.some((t) => db.prepare(`SELECT 1 FROM ${t} WHERE start_ms < ? AND end_ms > ? LIMIT 1`).get(endMs, startMs) !== undefined);
}
