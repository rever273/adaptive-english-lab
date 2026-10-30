import type { Db } from "../../db/open.js";
import { ApiError } from "../../errors.js";
import type { Confirmation } from "./ports.js";

export interface ReviewFindingInput {
  findingId: string;
  verdict: Confirmation;
  reviewer: string;
  reviewVersion: string;
  sourceHash: string;
  reason: string;
  /** Optimistic compare on the latest review sequence (0 = no review yet). */
  expectedSequence: number;
  newId: () => string;
  now: () => Date;
}

/** Append-only review of an AI finding (D18/D21). Re-acceptance is a new event, never an overwrite. */
export function reviewFinding(db: Db, input: ReviewFindingInput): { sequence: number } {
  return db
    .transaction(() => {
      const f = db.prepare("SELECT id FROM error_events WHERE id = ?").get(input.findingId);
      if (!f) throw new ApiError(404, "FINDING_NOT_FOUND", "Unknown finding");
      const last = db.prepare("SELECT COALESCE(MAX(sequence), 0) AS n FROM finding_review_events WHERE finding_id = ?").get(input.findingId) as { n: number };
      if (last.n !== input.expectedSequence) {
        throw new ApiError(409, "STALE_REVIEW", "The finding was reviewed since it was read", { latestSequence: last.n });
      }
      const sequence = last.n + 1;
      db.prepare(
        `INSERT INTO finding_review_events(id, finding_id, sequence, verdict, reviewer, review_version, source_hash, reason, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run(input.newId(), input.findingId, sequence, input.verdict, input.reviewer, input.reviewVersion, input.sourceHash, input.reason, input.now().toISOString());
      return { sequence };
    })
    .immediate();
}

/** Effective status = latest review event, else the original finding verdict (spec/04, spec/09). */
export function effectiveFindingVerdict(db: Db, findingId: string): Confirmation {
  const r = db
    .prepare(
      `SELECT COALESCE((SELECT verdict FROM finding_review_events WHERE finding_id = e.id ORDER BY sequence DESC LIMIT 1), e.verdict) AS v
         FROM error_events e WHERE e.id = ?`,
    )
    .get(findingId) as { v: Confirmation } | undefined;
  if (!r) throw new ApiError(404, "FINDING_NOT_FOUND", "Unknown finding");
  return r.v;
}
