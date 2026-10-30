import type { SessionSnapshot, SlotState } from "@english-lab/contracts";
import type { Db } from "../../db/open.js";
import { ApiError } from "../../errors.js";

interface SlotRow {
  slotId: string;
  ordinal: number;
  format: string;
  dimension: "recognition" | "correction" | "production";
  inputPreference: "text" | "voice";
  readingGroupId: string | null;
  questionId: string | null;
}

/** Derived per-slot state: what the stored events say, never a UI guess (reload restores exactly this). */
export function getSnapshot(db: Db, sessionId: string): SessionSnapshot {
  const s = db.prepare("SELECT id, status, purpose, created_at AS createdAt, ended_at AS endedAt, timezone FROM sessions WHERE id = ?").get(sessionId) as
    | { id: string; status: SessionSnapshot["status"]; purpose: SessionSnapshot["purpose"]; createdAt: string; endedAt: string | null; timezone: string }
    | undefined;
  if (!s) throw new ApiError(404, "SESSION_NOT_FOUND", "Unknown session");
  const slots = db
    .prepare(
      `SELECT ss.id AS slotId, ss.ordinal AS ordinal, er.type AS format, er.dimension AS dimension, ss.input_preference AS inputPreference,
              ss.reading_group_id AS readingGroupId, ss.question_id AS questionId
         FROM session_slots ss JOIN exercise_revisions er ON er.id = ss.exercise_revision_id
        WHERE ss.session_id = ? ORDER BY ss.ordinal`,
    )
    .all(sessionId) as SlotRow[];
  const events = db.prepare("SELECT slot_id AS slotId, event_type AS t FROM session_events WHERE session_id = ? AND slot_id IS NOT NULL").all(sessionId) as Array<{ slotId: string; t: string }>;
  const evBySlot = new Map<string, Set<string>>();
  for (const e of events) (evBySlot.get(e.slotId) ?? evBySlot.set(e.slotId, new Set()).get(e.slotId)!).add(e.t);
  const attempts = db
    .prepare(
      `SELECT t.slot_id AS slotId, COUNT(*) AS n, MAX(t.attempt_no) AS last
         FROM attempts t JOIN session_slots ss ON ss.id = t.slot_id WHERE ss.session_id = ? GROUP BY t.slot_id`,
    )
    .all(sessionId) as Array<{ slotId: string; n: number; last: number }>;
  const attemptBySlot = new Map(attempts.map((a) => [a.slotId, a]));

  let closed = 0;
  const out = slots.map((slot) => {
    const ev = evBySlot.get(slot.slotId) ?? new Set<string>();
    const att = attemptBySlot.get(slot.slotId);
    let state: SlotState = "unrevealed";
    if (ev.has("continue")) state = "continued";
    else if (ev.has("skip")) state = "skipped";
    else if (att) state = "answered";
    else if (ev.has("reveal")) state = "revealed";
    if (state === "continued" || state === "skipped") closed++;
    let latest: { verdict: string; confirmation: string } | null = null;
    if (att) {
      latest =
        (db
          .prepare(
            `SELECT a.verdict AS verdict, a.confirmation AS confirmation
               FROM assessment_revisions a JOIN attempts t ON t.id = a.attempt_id
              WHERE t.slot_id = ? AND t.attempt_no = ? ORDER BY a.sequence DESC LIMIT 1`,
          )
          .get(slot.slotId, att.last) as { verdict: string; confirmation: string } | undefined) ?? null;
    }
    return { ...slot, state, attempts: att?.n ?? 0, latest };
  });
  return { sessionId: s.id, status: s.status, purpose: s.purpose, taskCount: slots.length, timezone: s.timezone, createdAt: s.createdAt, endedAt: s.endedAt, progress: { closed, total: slots.length }, slots: out };
}

export function currentSessionId(db: Db): string | null {
  const r = db.prepare("SELECT id FROM sessions WHERE status = 'active' ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as { id: string } | undefined;
  return r?.id ?? null;
}
