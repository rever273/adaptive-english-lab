import type { Db } from "../../db/open.js";
import { modeXpTotal } from "./modeXp.js";

export const XP_RULE_VERSION = "activity-xp-v1";
export const XP_PER_COMPLETION = 10;
/** soft-linear-v1: level 1 costs 100 XP and every next level 25 XP more (Lv 2 = 125 … Lv 10 = 325); the level is derived from the ledger total, nothing is stored */
export const LEVEL_RULE_VERSION = "soft-linear-v1";
export const XP_FIRST_LEVEL = 100;
export const XP_LEVEL_STEP = 25;
export const xpForLevel = (level: number): number => XP_FIRST_LEVEL + XP_LEVEL_STEP * (level - 1);

export function levelFromTotal(total: number): { level: number; withinLevel: number; threshold: number } {
  let level = 1, rest = total;
  while (rest >= xpForLevel(level)) rest -= xpForLevel(level++);
  return { level, withinLevel: rest, threshold: xpForLevel(level) };
}
export type ActivityTrack = "grammar" | "vocabulary";
export type ProgressTrack = ActivityTrack | "conversation";

/** Called in the same transaction as the continue event. */
export function awardCompletionXp(db: Db, input: { id: string; slotId: string; eventId: string; track: ActivityTrack; at: string }): void {
  db.prepare("INSERT INTO activity_xp_events(id, slot_id, event_id, track, amount, rule_version, created_at) VALUES (?,?,?,?,?,?,?)")
    .run(input.id, input.slotId, input.eventId, input.track, XP_PER_COMPLETION, XP_RULE_VERSION, input.at);
}

/** practice-task XP plus the XP of the newer modes of the same track (Grammar Cloze -> grammar, One Word lessons -> vocabulary); Conversation has its own ledger only */
/**
 * XP for a practice task is earned by a RIGHT first try: the first attempt's latest assessment says `correct` (confirmed, or provisional from the
 * local AI) and the learner has moved on (`continue`). A mistake, "I don't know", a skip or a task whose verdict is still pending earns nothing.
 * It is called when the learner continues AND whenever an assessment is appended, so an AI verdict that arrives later still pays - once (UNIQUE slot).
 */
export function awardXpIfEarned(db: Db, deps: { newId: () => string }, slotId: string): boolean {
  if (db.prepare("SELECT 1 FROM activity_xp_events WHERE slot_id = ?").get(slotId)) return false;
  const row = db.prepare(
    `SELECT e.id AS eventId, e.server_at AS at, s.id AS sessionId
       FROM session_events e JOIN session_slots ss ON ss.id = e.slot_id JOIN sessions s ON s.id = ss.session_id
      WHERE e.slot_id = ? AND e.event_type = 'continue' AND s.purpose = 'practice'
      ORDER BY e.server_at LIMIT 1`,
  ).get(slotId) as { eventId: string; at: string; sessionId: string } | undefined;
  if (!row) return false;
  const first = db.prepare("SELECT id FROM attempts WHERE slot_id = ? AND attempt_no = 1").get(slotId) as { id: string } | undefined;
  if (!first) return false;
  const verdict = db.prepare("SELECT verdict FROM assessment_revisions WHERE attempt_id = ? ORDER BY sequence DESC LIMIT 1").get(first.id) as { verdict: string } | undefined;
  if (verdict?.verdict !== "correct") return false;
  const vocabulary = db.prepare("SELECT 1 FROM vocabulary_sessions WHERE session_id = ?").get(row.sessionId) !== undefined;
  awardCompletionXp(db, { id: deps.newId(), slotId, eventId: row.eventId, track: vocabulary ? "vocabulary" : "grammar", at: row.at });
  return true;
}

export function activityProgress(db: Db, track: ProgressTrack) {
  const own = track === "conversation" ? 0 : (db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM activity_xp_events WHERE track = ?").get(track) as { total: number }).total;
  const total = own + modeXpTotal(db, track);
  return { track, total, ...levelFromTotal(total), ruleVersion: XP_RULE_VERSION, levelRule: LEVEL_RULE_VERSION };
}
