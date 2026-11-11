import type { Db } from "../../db/open.js";
import { ApiError } from "../../errors.js";
import type { RunDeps } from "./runs.js";

export interface LessonInterval {
  id: string;
  tabId: string;
  startMs: number;
  endMs: number;
}

/**
 * Visible time of a lesson, for the daily plan and the Journey. Same rules as practice time: short intervals, appended once, and never overlapping any
 * other recorded activity (practice, typing, another lesson), so one moment is counted once.
 */
export function recordLessonActivity(db: Db, deps: RunDeps, runId: string, b: LessonInterval): { recorded: boolean } {
  return db
    .transaction(() => {
      const prev = db.prepare("SELECT run_id AS runId, tab_id AS tabId, start_ms AS startMs, end_ms AS endMs FROM word_lesson_activity_intervals WHERE id = ?").get(b.id) as { runId: string; tabId: string; startMs: number; endMs: number } | undefined;
      if (prev) {
        if (prev.runId !== runId || prev.tabId !== b.tabId || prev.startMs !== b.startMs || prev.endMs !== b.endMs) throw new ApiError(409, "ACTIVITY_ID_CONFLICT", "Activity interval id already used");
        return { recorded: false };
      }
      const run = db.prepare("SELECT status, tab_id AS tabId, started_at AS startedAt, completed_at AS completedAt FROM word_lesson_runs WHERE id = ?").get(runId) as { status: string; tabId: string; startedAt: string; completedAt: string | null } | undefined;
      if (!run) throw new ApiError(404, "WORD_LESSON_RUN_NOT_FOUND", "Unknown lesson run");
      const now = deps.now().getTime();
      if (b.endMs <= b.startMs || b.endMs - b.startMs > 15000 || b.startMs < Date.parse(run.startedAt) || b.endMs > now + 2000 || (run.completedAt && b.endMs > Date.parse(run.completedAt) + 2000)) throw new ApiError(400, "ACTIVITY_INVALID", "Invalid activity interval");
      if (run.status === "active" && run.tabId !== b.tabId) throw new ApiError(409, "LEASE_REQUIRED", "This tab is not the one practising this lesson");
      const overlap = (table: string) => db.prepare(`SELECT 1 FROM ${table} WHERE start_ms < ? AND end_ms > ? LIMIT 1`).get(b.endMs, b.startMs);
      if (overlap("word_lesson_activity_intervals") || overlap("practice_activity_intervals") || overlap("journey_typing_intervals") || overlap("conversation_activity_intervals") || overlap("grammar_cloze_activity_intervals")) throw new ApiError(409, "ACTIVITY_OVERLAP", "Activity interval overlaps a recorded interval");
      db.prepare("INSERT INTO word_lesson_activity_intervals(id, run_id, tab_id, start_ms, end_ms, recorded_at) VALUES (?,?,?,?,?,?)").run(b.id, runId, b.tabId, b.startMs, b.endMs, deps.now().toISOString());
      return { recorded: true };
    })
    .immediate();
}
