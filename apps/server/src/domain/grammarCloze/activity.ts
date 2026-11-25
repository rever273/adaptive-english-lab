import type { Db } from "../../db/open.js";
import { ApiError } from "../../errors.js";
import type { Deps } from "./repository.js";
import { overlapsRecordedActivity } from "../journey/intervals.js";

export interface ClozeInterval {
  id: string;
  tabId: string;
  startMs: number;
  endMs: number;
}

/**
 * Visible time of a Grammar Cloze session for the Journey and the daily plan. Same rules as practice time: short intervals, appended once, never
 * overlapping any other recorded activity, so one moment is counted once.
 */
export function recordClozeActivity(db: Db, deps: Deps, sessionId: string, b: ClozeInterval): { recorded: boolean } {
  return db
    .transaction(() => {
      const prev = db.prepare("SELECT session_id AS sessionId, tab_id AS tabId, start_ms AS startMs, end_ms AS endMs FROM grammar_cloze_activity_intervals WHERE id = ?").get(b.id) as { sessionId: string; tabId: string; startMs: number; endMs: number } | undefined;
      if (prev) {
        if (prev.sessionId !== sessionId || prev.tabId !== b.tabId || prev.startMs !== b.startMs || prev.endMs !== b.endMs) throw new ApiError(409, "ACTIVITY_ID_CONFLICT", "Activity interval id already used");
        return { recorded: false };
      }
      const s = db.prepare("SELECT status, tab_id AS tabId, started_at AS startedAt, completed_at AS completedAt FROM grammar_cloze_sessions WHERE id = ?").get(sessionId) as { status: string; tabId: string; startedAt: string; completedAt: string | null } | undefined;
      if (!s) throw new ApiError(404, "CLOZE_SESSION_NOT_FOUND", "Unknown Grammar Cloze session");
      const now = deps.now().getTime();
      if (b.endMs <= b.startMs || b.endMs - b.startMs > 15000 || b.startMs < Date.parse(s.startedAt) || b.endMs > now + 2000 || (s.completedAt && b.endMs > Date.parse(s.completedAt) + 2000)) throw new ApiError(400, "ACTIVITY_INVALID", "Invalid activity interval");
      if (s.status === "active" && s.tabId !== b.tabId) throw new ApiError(409, "LEASE_REQUIRED", "This tab is not the one practising this session");
      if (overlapsRecordedActivity(db, b.startMs, b.endMs)) throw new ApiError(409, "ACTIVITY_OVERLAP", "Activity overlaps time already recorded");
      db.prepare("INSERT INTO grammar_cloze_activity_intervals(id, session_id, tab_id, start_ms, end_ms, recorded_at) VALUES (?,?,?,?,?,?)").run(b.id, sessionId, b.tabId, b.startMs, b.endMs, deps.now().toISOString());
      return { recorded: true };
    })
    .immediate();
}
