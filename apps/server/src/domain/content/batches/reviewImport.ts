import { ReviewManifestSchema, ReviewerSchema, type ReviewManifest, type ValidationIssue } from "@english-lab/contracts";
import type { Db } from "../../../db/open.js";
import { ApiError } from "../../../errors.js";
import { approveRevision, flagRevision, latestState, rejectRevision, submitReview, type ContentDeps } from "../repository.js";

export interface ReviewImportResult {
  batchId: string;
  reviewer: string;
  reviewVersion: string;
  /** one review record per manifest item, written in this call */
  recorded: number;
  approved: number;
  flagged: number;
  rejected: number;
}

/**
 * Imports a reviewer's manifest for ONE batch (spec/06 "Безопасный внешний review"). Every item is checked against the CURRENT immutable
 * content first - revision belongs to the batch, hash equals the stored hash, state still awaits a decision. Any problem refuses the
 * whole manifest and nothing is written (a stale or foreign manifest never half-applies). An accepted item gets its own individual
 * review record; there is no "approve all". The reviewer is `human:` or `agent:` and is recorded as such.
 */
export function importReviewManifest(db: Db, deps: ContentDeps, batchId: string, input: unknown): ReviewImportResult {
  const parsed = ReviewManifestSchema.safeParse(input);
  if (!parsed.success) throw new ApiError(400, "VALIDATION_ERROR", "Review manifest is invalid", parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const manifest: ReviewManifest = parsed.data;
  const reviewer = ReviewerSchema.safeParse(manifest.reviewer);
  if (!reviewer.success) throw new ApiError(422, "REVIEWER_INVALID", reviewer.error.issues[0]?.message ?? "invalid reviewer");
  const actor = { type: reviewer.data.startsWith("human:") ? ("user" as const) : ("agent" as const), id: reviewer.data };

  return db
    .transaction((): ReviewImportResult => {
      if (!db.prepare("SELECT 1 FROM batches WHERE id = ?").get(batchId)) throw new ApiError(404, "BATCH_NOT_FOUND", "Unknown batch");
      const problems: Array<ValidationIssue & { revisionId: string }> = [];
      const seen = new Set<string>();
      for (const item of manifest.items) {
        const issue = (code: string, message: string) => problems.push({ code, path: "", message, revisionId: item.revision_id });
        if (seen.has(item.revision_id)) {
          issue("DUPLICATE_ITEM", "the revision appears twice in the manifest");
          continue;
        }
        seen.add(item.revision_id);
        const row = db
          .prepare("SELECT er.content_hash AS hash FROM batch_items bi JOIN exercise_revisions er ON er.id = bi.revision_id WHERE bi.batch_id = ? AND bi.revision_id = ?")
          .get(batchId, item.revision_id) as { hash: string } | undefined;
        if (!row) {
          issue("NOT_IN_BATCH", "this revision does not belong to the batch");
          continue;
        }
        if (row.hash !== item.content_hash) {
          issue("STALE_HASH", "the reviewed hash is not the revision's current content hash");
          continue;
        }
        const state = latestState(db, item.revision_id)?.status;
        if (state !== "pending_review" && state !== "flagged") issue("REVIEW_STATE", `a revision can be reviewed only while pending_review or flagged (now ${state ?? "none"})`);
        else if (item.verdict === "flagged" && state === "flagged") issue("ALREADY_FLAGGED", "the revision is already flagged");
      }
      if (problems.length > 0) throw new ApiError(409, "REVIEW_IMPORT_REFUSED", "Review manifest refused; nothing was recorded", { problems });

      const out: ReviewImportResult = { batchId, reviewer: reviewer.data, reviewVersion: manifest.review_version, recorded: 0, approved: 0, flagged: 0, rejected: 0 };
      for (const item of manifest.items) {
        submitReview(db, deps, { revisionId: item.revision_id, reviewer: reviewer.data, reviewVersion: manifest.review_version, contentHash: item.content_hash, checklist: item.checklist, verdict: item.verdict });
        out.recorded++;
        if (item.verdict === "approved") {
          approveRevision(db, deps, { revisionId: item.revision_id, actor, reason: item.reason });
          out.approved++;
        } else if (item.verdict === "flagged") {
          flagRevision(db, deps, { revisionId: item.revision_id, actor, reason: item.reason });
          out.flagged++;
        } else {
          rejectRevision(db, deps, { revisionId: item.revision_id, actor, reason: item.reason });
          out.rejected++;
        }
      }
      return out;
    })
    .immediate();
}
