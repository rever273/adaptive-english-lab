import type { SessionSummary } from "@english-lab/contracts";
import type { Db } from "../../db/open.js";
import { ApiError } from "../../errors.js";
import { localDateIn } from "../attempts/canonical.js";
import { nearMatchOfFirst } from "./feedback.js";
import type { SessionDeps } from "./policy.js";
import { AI_CHECK_ACTIVE, unresolvedAttempts } from "./reviewQueue.js";


/**
 * Counts for the finish screen. First attempts only; assisted first attempts (hint / answer seen before) are their own bucket and
 * are never mixed into accuracy; pending answers are NOT counted as wrong; a skip is not an attempt.
 */
export function summarize(db: Db, sessionId: string, status: "completed" | "ended_early"): SessionSummary {
  const slots = db.prepare("SELECT id FROM session_slots WHERE session_id = ?").all(sessionId) as Array<{ id: string }>;
  const counts = { correct: 0, incorrect: 0, idk: 0, assisted: 0, pending: 0, skipped: 0, unanswered: 0 };
  let pendingAnalysis = 0;
  let aiWaiting = 0;
  let detailDiffers = 0;
  // D65: first attempts decided by the local AI (provisional) and those it could not settle
  const aiChecked = { correct: 0, incorrect: 0 };
  for (const { id } of slots) {
    const first = db.prepare("SELECT id, hints_before AS hints, answer_seen_before AS seen FROM attempts WHERE slot_id = ? AND attempt_no = 1").get(id) as { id: string; hints: number; seen: number } | undefined;
    if (!first) {
      const skipped = db.prepare("SELECT 1 FROM session_events WHERE slot_id = ? AND event_type = 'skip'").get(id);
      if (skipped) counts.skipped++;
      else counts.unanswered++;
      continue;
    }
    const latestAttempt = db.prepare("SELECT id FROM attempts WHERE slot_id = ? ORDER BY attempt_no DESC LIMIT 1").get(id) as { id: string };
    const latest = db.prepare("SELECT verdict FROM assessment_revisions WHERE attempt_id = ? ORDER BY sequence DESC LIMIT 1").get(latestAttempt.id) as { verdict: string };
    if (latest.verdict === "pending" || latest.verdict === "ambiguous") pendingAnalysis++;
    // the local AI check of this answer is still queued/running: nothing has been produced for it yet (a failed or finished job is not waiting)
    if ((latest.verdict === "pending" || latest.verdict === "ambiguous") && AI_CHECK_ACTIVE.has((db.prepare("SELECT state FROM jobs WHERE idempotency_key = ?").get(`free_text_analysis:${latestAttempt.id}`) as { state: string } | undefined)?.state ?? "")) aiWaiting++;
    const firstAssessment = db.prepare("SELECT verdict, confirmation, source FROM assessment_revisions WHERE attempt_id = ? ORDER BY sequence DESC LIMIT 1").get(first.id) as { verdict: string; confirmation: string; source: string };
    if (first.hints > 0 || first.seen > 0) counts.assisted++;
    else if (firstAssessment.verdict === "correct" && firstAssessment.confirmation === "confirmed") {
      counts.correct++;
      if (nearMatchOfFirst(db, id)) detailDiffers++;
    }
    else if (firstAssessment.verdict === "incorrect" && firstAssessment.confirmation === "confirmed") counts.incorrect++;
    else if (firstAssessment.verdict === "idk") counts.idk++;
    else if (firstAssessment.source === "model" && firstAssessment.confirmation === "tentative" && (firstAssessment.verdict === "correct" || firstAssessment.verdict === "incorrect")) aiChecked[firstAssessment.verdict]++;
    else {
      counts.pending++;
    }
  }
  // the same queue the dashboard notice counts: unresolved pending/ambiguous answers AND model-"incorrect" ones waiting for an agent to confirm them
  const unresolved = unresolvedAttempts(db).filter((q) => q.sessionId === sessionId).length;
  const notes: string[] = [];
  if (status === "ended_early") notes.push("Ended early: this does not count as a completed lesson.");
  if (pendingAnalysis > 0) notes.push(`${pendingAnalysis} written answer(s) remain unconfirmed. AI suggestions may appear below.`);
  if (counts.assisted > 0) notes.push("Assisted answers (hint or answer shown first) are listed separately and are not unaided evidence.");
  const vocabulary = db.prepare("SELECT 1 FROM vocabulary_sessions WHERE session_id = ?").get(sessionId) !== undefined;
  const xpEarned = (db.prepare("SELECT COALESCE(SUM(x.amount), 0) AS n FROM activity_xp_events x JOIN session_slots ss ON ss.id = x.slot_id WHERE ss.session_id = ?").get(sessionId) as { n: number }).n;
  let practiseAgain: string[] = [];
  if (vocabulary) {
    // the tested words whose FIRST try was wrong or "I don't know" (a later correct retry does not erase that)
    const rows = db
      .prepare(
        `SELECT DISTINCT json_extract(er.content_json, '$.vocabulary.target.lemma') AS lemma
           FROM session_slots ss JOIN exercise_revisions er ON er.id = ss.exercise_revision_id
           JOIN attempts t ON t.slot_id = ss.id AND t.attempt_no = 1
          WHERE ss.session_id = ? AND (t.idk = 1 OR (SELECT a.verdict FROM assessment_revisions a WHERE a.attempt_id = t.id ORDER BY a.sequence DESC LIMIT 1) = 'incorrect')`,
      )
      .all(sessionId) as Array<{ lemma: string | null }>;
    practiseAgain = rows.map((r) => r.lemma).filter((l): l is string => Boolean(l));
  }
  if (aiChecked.correct > 0) notes.push(`${aiChecked.correct} answer(s) were judged correct by the local AI: they count in your progress with a lower weight until they are confirmed.`);
  if (aiChecked.incorrect > 0) notes.push(`${aiChecked.incorrect} answer(s) were judged incorrect by the local AI: they will count in your progress only after review, so a wrong AI verdict cannot lower your results.`);
  const repeats = (db.prepare("SELECT COUNT(*) AS n FROM session_slots WHERE session_id = ? AND json_extract(cohort_json, '$.repeat') = 1").get(sessionId) as { n: number }).n;
  if (repeats > 0 && !vocabulary) notes.push(`${repeats} task(s) were repeats of sentences you had seen. They are extra practice and do not change your skill levels.`);
  if (detailDiffers > 0) notes.push(`${detailDiffers} answer(s) used the right construction with a different name or number: counted for the construction, the different word is marked in red below.`);
  return { sessionId, status, total: slots.length, counts, pendingAnalysis, aiWaiting, ...(aiChecked.correct + aiChecked.incorrect > 0 ? { aiChecked } : {}), ...(unresolved > 0 ? { unresolved } : {}), ...(detailDiffers > 0 ? { detailDiffers } : {}), ...(repeats > 0 && !vocabulary ? { repeats } : {}), category: vocabulary ? "vocabulary" : "grammar", xpEarned, ...(vocabulary ? { practiseAgain } : {}), notes };
}

/**
 * completed requires every slot to be closed (skip or continue). ended_early is always allowed and releases the reservations of
 * sentences that were never shown; shown sentences stay seen forever. Neither mode deletes anything else.
 */
export function finishSession(db: Db, deps: SessionDeps, sessionId: string, mode: "completed" | "ended_early"): SessionSummary {
  return db
    .transaction((): SessionSummary => {
      const s = db.prepare("SELECT status, timezone FROM sessions WHERE id = ?").get(sessionId) as { status: string; timezone: string } | undefined;
      if (!s) throw new ApiError(404, "SESSION_NOT_FOUND", "Unknown session");
      if (s.status === "completed" || s.status === "ended_early") {
        if (s.status === mode) return summarize(db, sessionId, mode); // idempotent
        throw new ApiError(409, "SESSION_NOT_ACTIVE", `Session is already ${s.status}`);
      }
      if (mode === "completed") {
        const open = db
          .prepare(
            `SELECT COUNT(*) AS n FROM session_slots ss
              WHERE ss.session_id = ? AND NOT EXISTS (SELECT 1 FROM session_events e WHERE e.slot_id = ss.id AND e.event_type IN ('skip','continue'))`,
          )
          .get(sessionId) as { n: number };
        if (open.n > 0) throw new ApiError(409, "SLOTS_OPEN", `${open.n} slot(s) are not finished yet`, { open: open.n });
      }
      const at = deps.now();
      db.prepare("UPDATE sessions SET status = ?, ended_at = ? WHERE id = ?").run(mode, at.toISOString(), sessionId);
      db.prepare("INSERT INTO session_events(id, session_id, slot_id, client_event_id, event_type, payload_json, server_at, local_date, timezone) VALUES (?,?,?,?,?,?,?,?,?)").run(
        deps.newId(),
        sessionId,
        null,
        `finish:${sessionId}`,
        "finish",
        JSON.stringify({ schema_version: 1, mode }),
        at.toISOString(),
        localDateIn(s.timezone, at),
        s.timezone,
      );
      // unshown sentences go back to the bank; exposed ones stay held (the database refuses to release them)
      // A diagnostic / held-out block shows its answers only AFTER it ends, so an answered task keeps its reservation: its answer sentences
      // must still be exposed (and recorded) when the learner reviews the block.
      const purpose = (db.prepare("SELECT purpose FROM sessions WHERE id = ?").get(sessionId) as { purpose: string }).purpose;
      db.prepare(
        `DELETE FROM prompt_reservations
          WHERE slot_id IN (SELECT ss.id FROM session_slots ss WHERE ss.session_id = ? AND NOT (? <> 'practice' AND EXISTS (SELECT 1 FROM attempts a WHERE a.slot_id = ss.id)))
            AND unit_id NOT IN (SELECT unit_id FROM exposures)`,
      ).run(sessionId, purpose);
      db.prepare("DELETE FROM practice_leases WHERE session_id = ?").run(sessionId);
      return summarize(db, sessionId, mode);
    })
    .immediate();
}
