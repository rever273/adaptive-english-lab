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
  cohort: string | null;
}

/** a vocabulary repeat slot (D64) carries `repeat: true` in cohort_json; it reserves only the units never exposed before (the rest of its sentences are already in the ledger) */
export function repeatOf(cohortJson: string | null): { reason: "missed" | "assisted" | "review"; repeatOfSlotId: string | null } | null {
  if (!cohortJson) return null;
  try {
    const c = JSON.parse(cohortJson) as { repeat?: unknown; reason?: string; repeatOfSlotId?: string };
    if (c.repeat !== true) return null;
    return { reason: c.reason === "missed" || c.reason === "assisted" ? c.reason : "review", repeatOfSlotId: c.repeatOfSlotId ?? null };
  } catch {
    return null;
  }
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
              ss.reading_group_id AS readingGroupId, ss.question_id AS questionId, ss.cohort_json AS cohort
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
    const { cohort, ...rest } = slot;
    const rep = repeatOf(cohort);
    return { ...rest, state, attempts: att?.n ?? 0, latest, ...(rep ? { repeat: { reason: rep.reason } } : {}) };
  });
  return { sessionId: s.id, status: s.status, purpose: s.purpose, taskCount: slots.length, timezone: s.timezone, createdAt: s.createdAt, endedAt: s.endedAt, progress: { closed, total: slots.length }, slots: out, category: sessionCategory(db, s.id) };
}

export type SessionCategory = "grammar" | "vocabulary";
/** every session without a vocabulary_sessions row is a grammar session (older sessions included) */
export const sessionCategory = (db: Db, sessionId: string): SessionCategory => (db.prepare("SELECT 1 FROM vocabulary_sessions WHERE session_id = ?").get(sessionId) ? "vocabulary" : "grammar");

const CATEGORY_SQL = "(CASE WHEN EXISTS (SELECT 1 FROM vocabulary_sessions v WHERE v.session_id = sessions.id) THEN 'vocabulary' ELSE 'grammar' END)";

/** the active session; with a category, only one of that kind (Grammar Practice never resumes a vocabulary session, and back) */
export function currentSessionId(db: Db, category?: SessionCategory): string | null {
  const r = (category
    ? db.prepare(`SELECT id FROM sessions WHERE status = 'active' AND ${CATEGORY_SQL} = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(category)
    : db.prepare("SELECT id FROM sessions WHERE status = 'active' ORDER BY created_at DESC, rowid DESC LIMIT 1").get()) as { id: string } | undefined;
  return r?.id ?? null;
}

/** the last finished session of a category */
export function recentSessionId(db: Db, category: SessionCategory): { id: string; status: "completed" | "ended_early" } | null {
  return (db.prepare(`SELECT id, status FROM sessions WHERE status IN ('completed','ended_early') AND ${CATEGORY_SQL} = ? ORDER BY ended_at DESC, rowid DESC LIMIT 1`).get(category) as { id: string; status: "completed" | "ended_early" } | undefined) ?? null;
}
