import { createHash, randomUUID } from "node:crypto";
import { ReviewerSchema } from "@english-lab/contracts";
import { z } from "zod";
import type { Db } from "../../db/open.js";
import { ApiError } from "../../errors.js";
import { reviewFinding } from "../attempts/findings.js";

/**
 * Bulk review of AI findings by a strong agent or by the user (spec/06 `finding-review-v1`). All-or-nothing: a stale hash or sequence anywhere
 * refuses the whole manifest. Each accepted item is one append-only review event; the original answers and findings are never touched, and
 * because the discovery signal and every list read the EFFECTIVE status, a rejected or disputed finding stops counting at once.
 */
export const FindingManifestSchema = z
  .object({
    schema_version: z.literal("finding-review-v1"),
    reviewer: z.string().min(1).max(200),
    review_version: z.string().min(1).max(120),
    items: z
      .array(
        z
          .object({
            finding_id: z.string().min(1).max(64),
            source_hash: z.string().regex(/^[0-9a-f]{64}$/),
            expected_sequence: z.number().int().min(0),
            verdict: z.enum(["confirmed", "rejected", "disputed", "uncertain"]),
            reason: z.string().trim().min(1).max(2000),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();
export type FindingManifest = z.infer<typeof FindingManifestSchema>;

interface Row {
  id: string;
  assessment_id: string;
  skill_id: string;
  fs: number | null;
  fe: number | null;
  correction: string | null;
  explanation_ru: string;
  finding_type: string;
  verdict: string;
  confidence: number | null;
  model_version_id: string | null;
  raw: string;
}

/** What a reviewer actually judged: the finding as it was stored, bound to the answer it refers to. If any of it changes, the hash changes. */
export function findingSourceHash(db: Db, findingId: string): string {
  const r = db
    .prepare(
      `SELECT e.id, e.assessment_id, sr.skill_id AS skill_id, e.fragment_start AS fs, e.fragment_end AS fe, e.correction, e.explanation_ru, e.finding_type, e.verdict, e.confidence, e.model_version_id, t.raw_answer_json AS raw
         FROM error_events e JOIN skill_revisions sr ON sr.id = e.skill_revision_id JOIN assessment_revisions a ON a.id = e.assessment_id JOIN attempts t ON t.id = a.attempt_id WHERE e.id = ?`,
    )
    .get(findingId) as Row | undefined;
  if (!r) throw new ApiError(404, "FINDING_NOT_FOUND", `Unknown finding ${findingId}`);
  return createHash("sha256").update(JSON.stringify([r.id, r.assessment_id, r.skill_id, r.fs, r.fe, r.correction, r.explanation_ru, r.finding_type, r.verdict, r.confidence, r.model_version_id, r.raw])).digest("hex");
}

const currentSequence = (db: Db, id: string): number => (db.prepare("SELECT COALESCE(MAX(sequence), 0) AS n FROM finding_review_events WHERE finding_id = ?").get(id) as { n: number }).n;

export interface FindingForReview {
  finding_id: string;
  source_hash: string;
  expected_sequence: number;
  skill_id: string;
  finding_type: string;
  status: string;
  span: { start: number | null; end: number | null; unit: "unicode_code_points" };
  correction: string | null;
  explanation_ru: string;
  confidence: number | null;
  model: string | null;
  /** the learner's answer text the finding refers to, and the task it answered */
  answer: unknown;
  prompt: string | null;
}

/** For `lab:export findings`: the tentative (or chosen) findings with exactly the three values a manifest must echo back. */
export function findingsForReview(db: Db, o: { status?: string; limit?: number } = {}): FindingForReview[] {
  const status = o.status ?? "tentative";
  const rows = db
    .prepare(
      `SELECT e.id AS id, sr.skill_id AS skill, e.finding_type AS ft, e.fragment_start AS fs, e.fragment_end AS fe, e.correction AS correction, e.explanation_ru AS ex, e.confidence AS conf,
              COALESCE((SELECT r.verdict FROM finding_review_events r WHERE r.finding_id = e.id ORDER BY r.sequence DESC LIMIT 1), e.verdict) AS eff, mv.tag AS model, t.raw_answer_json AS raw, er.content_json AS content
         FROM error_events e JOIN skill_revisions sr ON sr.id = e.skill_revision_id JOIN assessment_revisions a ON a.id = e.assessment_id JOIN attempts t ON t.id = a.attempt_id
         JOIN session_slots ss ON ss.id = t.slot_id JOIN exercise_revisions er ON er.id = ss.exercise_revision_id LEFT JOIN model_versions mv ON mv.id = e.model_version_id
        ORDER BY t.submitted_at DESC, e.id`,
    )
    .all() as Array<{ id: string; skill: string; ft: string; fs: number | null; fe: number | null; correction: string | null; ex: string; conf: number | null; eff: string; model: string | null; raw: string; content: string }>;
  return rows
    .filter((r) => r.eff === status)
    .slice(0, o.limit ?? 100)
    .map((r) => ({
      finding_id: r.id,
      source_hash: findingSourceHash(db, r.id),
      expected_sequence: currentSequence(db, r.id),
      skill_id: r.skill,
      finding_type: r.ft,
      status: r.eff,
      span: { start: r.fs, end: r.fe, unit: "unicode_code_points" as const },
      correction: r.correction,
      explanation_ru: r.ex,
      confidence: r.conf,
      model: r.model,
      answer: JSON.parse(r.raw) as unknown,
      prompt: (JSON.parse(r.content) as { prompt_en?: string }).prompt_en ?? null,
    }));
}

export interface FindingImportResult {
  reviewer: string;
  reviewVersion: string;
  recorded: number;
  byVerdict: Record<string, number>;
}

export function importFindingReviews(db: Db, deps: { now: () => Date; newId?: () => string }, input: unknown): FindingImportResult {
  const parsed = FindingManifestSchema.safeParse(input);
  if (!parsed.success) throw new ApiError(400, "VALIDATION_ERROR", "Finding review manifest is invalid", parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const m = parsed.data;
  const reviewer = ReviewerSchema.safeParse(m.reviewer);
  if (!reviewer.success) throw new ApiError(422, "REVIEWER_INVALID", reviewer.error.issues[0]?.message ?? "invalid reviewer");
  return db
    .transaction((): FindingImportResult => {
      const problems: Array<{ findingId: string; code: string; message: string }> = [];
      const seen = new Set<string>();
      for (const it of m.items) {
        const add = (code: string, message: string) => problems.push({ findingId: it.finding_id, code, message });
        if (seen.has(it.finding_id)) {
          add("DUPLICATE_ITEM", "the finding appears twice in the manifest");
          continue;
        }
        seen.add(it.finding_id);
        let hash: string;
        try {
          hash = findingSourceHash(db, it.finding_id);
        } catch {
          add("FINDING_NOT_FOUND", "unknown finding");
          continue;
        }
        if (hash !== it.source_hash) add("STALE_HASH", "the finding changed since it was exported");
        else if (currentSequence(db, it.finding_id) !== it.expected_sequence) add("STALE_SEQUENCE", "the finding was reviewed since it was exported");
      }
      if (problems.length > 0) throw new ApiError(409, "FINDING_REVIEW_REFUSED", "Manifest refused; no finding was changed", { problems });
      const byVerdict: Record<string, number> = {};
      for (const it of m.items) {
        reviewFinding(db, { findingId: it.finding_id, verdict: it.verdict, reviewer: reviewer.data, reviewVersion: m.review_version, sourceHash: it.source_hash, reason: it.reason, expectedSequence: it.expected_sequence, newId: deps.newId ?? randomUUID, now: deps.now });
        byVerdict[it.verdict] = (byVerdict[it.verdict] ?? 0) + 1;
      }
      return { reviewer: reviewer.data, reviewVersion: m.review_version, recorded: m.items.length, byVerdict };
    })
    .immediate();
}
