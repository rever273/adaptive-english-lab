import { reviewNoticeThreshold } from "@english-lab/contracts";
import type { Db } from "../../db/open.js";
import { loadSettings } from "./policy.js";

/** job states in which the local AI check of an answer is still to come */
export const AI_CHECK_ACTIVE: ReadonlySet<string> = new Set(["queued", "waiting_for_gpu", "running", "paused"]);
const ACTIVE_JOB = `(${[...AI_CHECK_ACTIVE].map((x) => `'${x}'`).join(",")})`;

/** the shared rule in code form: given the state of an answer's analysis job (undefined = none was ever queued) */
export const isUnresolved = (verdict: string, jobState: string | undefined): boolean =>
  (verdict === "pending" || verdict === "ambiguous") && !AI_CHECK_ACTIVE.has(jobState ?? "") && (verdict === "ambiguous" || jobState !== undefined);

/**
 * D65: UNRESOLVED answers = the latest assessment of an attempt is still pending/ambiguous and its local AI check is no longer running
 * (the model abstained, called it ambiguous, produced invalid output or the job failed). Read-only; nothing here changes an attempt.
 * An answer whose AI check is still queued or running is not unresolved yet. A decided model verdict (correct / incorrect_candidate) is not
 * unresolved either when it is "correct": it counts provisionally (mastery-v2) until an agent confirms or overrides it. A decided model "incorrect"
 * is shown to the learner at once but does NOT count until an agent confirms it, so it waits in this queue (asymmetry, D65).
 * ONE definition for the dashboard notice, the finish summary and the agent task: FIRST attempts only (only those can become evidence).
 */
export function unresolvedAttempts(db: Db): Array<{ attemptId: string; sessionId: string }> {
  return db
    .prepare(
      `SELECT t.id AS attemptId, ss.session_id AS sessionId
         FROM latest_assessments la
         JOIN attempts t ON t.id = la.attempt_id
         JOIN session_slots ss ON ss.id = t.slot_id
        WHERE t.attempt_no = 1 AND t.hints_before = 0 AND t.answer_seen_before = 0 AND (
                (la.verdict IN ('pending','ambiguous')
                  AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.idempotency_key = 'free_text_analysis:' || t.id AND j.state IN ${ACTIVE_JOB})
                  AND (la.verdict = 'ambiguous' OR EXISTS (SELECT 1 FROM jobs j WHERE j.idempotency_key = 'free_text_analysis:' || t.id)))
                OR (la.source = 'model' AND la.confirmation = 'tentative' AND la.verdict = 'incorrect')
              )
        ORDER BY t.submitted_at, t.id`,
    )
    .all() as Array<{ attemptId: string; sessionId: string }>;
}

/** The one non-blocking notice on the Practice start page: shown only once the queue reaches the threshold (setting `reviewNoticeThreshold`). */
export function reviewStatus(db: Db): { unresolved: number; threshold: number; notice: boolean } {
  const unresolved = unresolvedAttempts(db).length;
  let threshold = reviewNoticeThreshold({});
  try {
    threshold = reviewNoticeThreshold(loadSettings(db).values);
  } catch {
    /* no settings revision yet: the default stands */
  }
  return { unresolved, threshold, notice: unresolved >= threshold };
}
