import type { Db } from "../../db/open.js";

/** exercise formats the learner can speak (guided short answer, Russian-to-English short); the web app uses the same two */
export const VOICE_FORMATS = ["guided_short_answer", "russian_to_english_short"] as const;

/**
 * Can the microphone still be used in this session? True while a voice-capable slot (voice or "type or speak") is not yet closed
 * (skipped or continued). Vocabulary sessions never use the microphone. Once this is false the speech model is released and the
 * practice gate no longer holds back the local AI grading (TASK_021 T3a).
 */
/** whether a practice lease still keeps background AI away: yes while the microphone can be used; a lease whose session or slots are unknown is kept as before */
export function leaseHoldsGpu(db: Db, sessionId: string): boolean {
  if (db.prepare("SELECT 1 FROM session_slots WHERE session_id = ? LIMIT 1").get(sessionId) === undefined) return true;
  if (db.prepare("SELECT 1 FROM vocabulary_sessions WHERE session_id = ?").get(sessionId) !== undefined) return true; // vocabulary practice keeps the card, as before
  return microphoneStillNeeded(db, sessionId);
}

export function microphoneStillNeeded(db: Db, sessionId: string): boolean {
  const r = db
    .prepare(
      `SELECT 1 FROM sessions s
        WHERE s.id = ? AND s.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM vocabulary_sessions v WHERE v.session_id = s.id)
          AND EXISTS (
            SELECT 1 FROM session_slots ss JOIN exercise_revisions er ON er.id = ss.exercise_revision_id
             WHERE ss.session_id = s.id AND ss.input_preference = 'voice' AND er.type IN (${VOICE_FORMATS.map(() => "?").join(",")})
               AND NOT EXISTS (SELECT 1 FROM session_events e WHERE e.slot_id = ss.id AND e.event_type IN ('skip','continue')))`,
    )
    .get(sessionId, ...VOICE_FORMATS);
  return r !== undefined;
}
