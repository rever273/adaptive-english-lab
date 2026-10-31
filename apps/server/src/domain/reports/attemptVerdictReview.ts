import { ReviewerSchema } from "@english-lab/contracts";
import { z } from "zod";
import type { Db } from "../../db/open.js";
import { ApiError } from "../../errors.js";
import { appendAssessmentRevision, latestAssessment } from "../attempts/assessments.js";
import type { AttemptDeps } from "../attempts/ports.js";
import { unresolvedAttempts } from "../sessions/reviewQueue.js";

/** first, unaided attempts the local AI called correct: they count at half weight (mastery-v2); the agent may confirm or overturn them too */
export function aiCorrectAttempts(db: Db): Array<{ attemptId: string; sessionId: string }> {
  return db
    .prepare(
      `SELECT t.id AS attemptId, ss.session_id AS sessionId
         FROM latest_assessments la
         JOIN attempts t ON t.id = la.attempt_id
         JOIN session_slots ss ON ss.id = t.slot_id
        WHERE t.attempt_no = 1 AND t.hints_before = 0 AND t.answer_seen_before = 0
          AND la.source = 'model' AND la.confirmation = 'tentative' AND la.verdict = 'correct'
        ORDER BY t.submitted_at, t.id`,
    )
    .all() as Array<{ attemptId: string; sessionId: string }>;
}

/**
 * D65: the agent settles the answers the local AI could not (pending / ambiguous) or called incorrect (shown at once, counted only after review).
 * `attempt-verdict-review-v1` is applied by APPENDING a new human/confirmed assessment revision (never editing a row), with the sequence the
 * agent saw echoed back. All or nothing: a stale sequence or an attempt outside the queue refuses the whole manifest. Applying the same manifest
 * again is a no-op. A model can never confirm (MODEL_CANNOT_CONFIRM); the reviewer is an agent/human id and the revision says so.
 */
export const AttemptVerdictManifestSchema = z
  .object({
    schema_version: z.literal("attempt-verdict-review-v1"),
    reviewer: z.string().min(1).max(200),
    review_version: z.string().min(1).max(120),
    items: z
      .array(
        z
          .object({
            attempt_id: z.string().min(1).max(64),
            expected_sequence: z.number().int().min(1),
            verdict: z.enum(["correct", "incorrect"]),
            rationale: z.string().trim().min(1).max(600),
            /** an answer the agent found acceptable and proposes to add as an approved variant (a new exercise revision is a separate, reviewed step) */
            proposed_variant: z.string().trim().min(1).max(300).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();
export type AttemptVerdictManifest = z.infer<typeof AttemptVerdictManifestSchema>;

export interface AttemptForVerdictReview {
  attempt_id: string;
  session_id: string;
  expected_sequence: number;
  /** what the app currently says: pending | ambiguous | incorrect (the local AI's verdict, not counted yet) | correct (AI-checked, counted at half weight; only with --include-ai-correct) */
  current: { verdict: string; source: string; confirmation: string };
  prompt: string | null;
  /** the learner's answer: printed only by the local export, never put in the copied agent task */
  answer: unknown;
  accepted_answers: string[] | null;
}

/** For `lab:export verdicts`: the queue with exactly the values a manifest must echo back. */
export function attemptsForVerdictReview(db: Db, o: { limit?: number; includeAiCorrect?: boolean } = {}): AttemptForVerdictReview[] {
  return [...unresolvedAttempts(db), ...(o.includeAiCorrect ? aiCorrectAttempts(db) : [])]
    .slice(0, o.limit ?? 100)
    .map((q) => {
      const a = latestAssessment(db, q.attemptId)!;
      const row = db
        .prepare("SELECT t.raw_answer_json AS raw, er.content_json AS content FROM attempts t JOIN session_slots ss ON ss.id = t.slot_id JOIN exercise_revisions er ON er.id = ss.exercise_revision_id WHERE t.id = ?")
        .get(q.attemptId) as { raw: string; content: string };
      const content = JSON.parse(row.content) as { prompt_en?: string; payload?: { accepted_answers?: string[] } };
      return {
        attempt_id: q.attemptId,
        session_id: q.sessionId,
        expected_sequence: a.sequence,
        current: { verdict: a.verdict, source: a.source, confirmation: a.confirmation },
        prompt: content.prompt_en ?? null,
        answer: JSON.parse(row.raw) as unknown,
        accepted_answers: content.payload?.accepted_answers ?? null,
      };
    });
}

export interface AttemptVerdictResult {
  reviewer: string;
  reviewVersion: string;
  applied: number;
  alreadyApplied: number;
  byVerdict: Record<string, number>;
  proposedVariants: number;
}

const tag = (reviewVersion: string) => `[${reviewVersion}]`;

export function applyAttemptVerdicts(db: Db, deps: Pick<AttemptDeps, "now" | "newId">, input: unknown): AttemptVerdictResult {
  const parsed = AttemptVerdictManifestSchema.safeParse(input);
  if (!parsed.success) throw new ApiError(400, "VALIDATION_ERROR", "Verdict manifest is invalid", parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const m = parsed.data;
  const reviewer = ReviewerSchema.safeParse(m.reviewer);
  if (!reviewer.success) throw new ApiError(422, "REVIEWER_INVALID", reviewer.error.issues[0]?.message ?? "invalid reviewer");
  return db
    .transaction((): AttemptVerdictResult => {
      const queued = new Set([...unresolvedAttempts(db), ...aiCorrectAttempts(db)].map((q) => q.attemptId));
      const problems: Array<{ attemptId: string; code: string; message: string }> = [];
      const seen = new Set<string>();
      const already = new Set<string>();
      for (const it of m.items) {
        const add = (code: string, message: string) => problems.push({ attemptId: it.attempt_id, code, message });
        if (seen.has(it.attempt_id)) {
          add("DUPLICATE_ITEM", "the attempt appears twice in the manifest");
          continue;
        }
        seen.add(it.attempt_id);
        const latest = latestAssessment(db, it.attempt_id);
        if (!latest) {
          add("ATTEMPT_NOT_FOUND", "unknown attempt");
          continue;
        }
        // re-apply of the same manifest: the very next revision is ours, human, confirmed, with the same verdict
        if (latest.sequence === it.expected_sequence + 1 && latest.source === "human" && latest.confirmation === "confirmed" && latest.verdict === it.verdict) {
          const r = db.prepare("SELECT rationale FROM assessment_revisions WHERE id = ?").get(latest.id) as { rationale: string | null };
          if ((r.rationale ?? "").startsWith(tag(m.review_version))) {
            already.add(it.attempt_id);
            continue;
          }
        }
        if (latest.sequence !== it.expected_sequence) add("STALE_SEQUENCE", "the assessment changed since it was exported");
        else if (!queued.has(it.attempt_id)) add("NOT_IN_QUEUE", "the attempt is neither waiting for a decision nor an AI-checked answer");
      }
      if (problems.length > 0) throw new ApiError(409, "VERDICT_REVIEW_REFUSED", "Manifest refused; no assessment was changed", { problems });
      const byVerdict: Record<string, number> = {};
      let applied = 0;
      let proposedVariants = 0;
      for (const it of m.items) {
        if (already.has(it.attempt_id)) continue;
        const note = it.proposed_variant ? ` Proposed variant: "${it.proposed_variant}".` : "";
        const rationale = `${tag(m.review_version)} ${reviewer.data}: ${it.rationale}${note}`.slice(0, 1000);
        appendAssessmentRevision(db, deps as AttemptDeps, { attemptId: it.attempt_id, expectedSequence: it.expected_sequence, decision: { verdict: it.verdict, confirmation: "confirmed", source: "human", rationale } });
        byVerdict[it.verdict] = (byVerdict[it.verdict] ?? 0) + 1;
        if (it.proposed_variant) proposedVariants++;
        applied++;
      }
      return { reviewer: reviewer.data, reviewVersion: m.review_version, applied, alreadyApplied: already.size, byVerdict, proposedVariants };
    })
    .immediate();
}
