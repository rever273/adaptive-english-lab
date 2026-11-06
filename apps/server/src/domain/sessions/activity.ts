import type { Db } from "../../db/open.js";
import { ApiError } from "../../errors.js";
import type { SessionDeps } from "./policy.js";
import { assertLease } from "./lease.js";

export interface ActivityInterval { id: string; tabId: string; startMs: number; endMs: number }
/** Append once; time intervals cannot overlap, including across tabs or categories. */
export function recordPracticeActivity(db: Db, deps: SessionDeps, sessionId: string, b: ActivityInterval): { recorded: boolean } {
  return db.transaction(() => {
    const prev = db.prepare("SELECT session_id AS sessionId, tab_id AS tabId, start_ms AS startMs, end_ms AS endMs FROM practice_activity_intervals WHERE id = ?").get(b.id) as (ActivityInterval & { sessionId: string }) | undefined;
    if (prev) {
      if (prev.sessionId !== sessionId || prev.tabId !== b.tabId || prev.startMs !== b.startMs || prev.endMs !== b.endMs) throw new ApiError(409, "ACTIVITY_ID_CONFLICT", "Activity interval id already used");
      return { recorded: false };
    }
    const session = db.prepare("SELECT status, purpose, created_at AS createdAt, ended_at AS endedAt, timezone FROM sessions WHERE id = ?").get(sessionId) as { status: string; purpose: string; createdAt: string; endedAt: string | null; timezone: string } | undefined;
    if (!session) throw new ApiError(404, "SESSION_NOT_FOUND", "Unknown session");
    if (session.purpose !== "practice") throw new ApiError(409, "ACTIVITY_NOT_PRACTICE", "Only practice sessions are counted");
    const now = deps.now().getTime();
    if (b.startMs < Date.parse(session.createdAt) || b.endMs > now + 2000 || b.endMs <= b.startMs || b.endMs - b.startMs > 15000 || (session.endedAt && b.endMs > Date.parse(session.endedAt) + 2000)) throw new ApiError(400, "ACTIVITY_INVALID", "Invalid activity interval");
    if (session.status === "active") assertLease(db, deps, sessionId, b.tabId);
    else if (!session.endedAt) throw new ApiError(409, "SESSION_NOT_ACTIVE", "Session is not active");
    const overlap = db.prepare("SELECT 1 FROM practice_activity_intervals WHERE start_ms < ? AND end_ms > ? LIMIT 1").get(b.endMs, b.startMs);
    if (overlap || db.prepare("SELECT 1 FROM journey_typing_intervals WHERE start_ms < ? AND end_ms > ?").get(b.endMs, b.startMs)) throw new ApiError(409, "ACTIVITY_OVERLAP", "Activity interval overlaps a recorded interval");
    db.prepare("INSERT INTO practice_activity_intervals(id,session_id,tab_id,start_ms,end_ms,timezone,method,recorded_at) VALUES (?,?,?,?,?,?,?,?)").run(b.id, sessionId, b.tabId, b.startMs, b.endMs, session.timezone, "visible-recent-v1", deps.now().toISOString());
    return { recorded: true };
  }).immediate();
}
