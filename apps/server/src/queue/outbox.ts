import type { Db } from "../db/open.js";
import type { Outbox } from "../domain/attempts/ports.js";
import { enqueue, type JobKind, type QueueDeps } from "./jobs.js";

const KINDS: ReadonlySet<string> = new Set<JobKind>(["free_text_analysis", "triage", "vocabulary_enrichment", "tutor"]);

/**
 * The real outbox (D27): called INSIDE the attempt transaction, so the raw answer, its pending assessment and the queued analysis job
 * are committed together or not at all. It only writes a row; no model is called and no GPU is touched here.
 */
export function jobsOutbox(deps: QueueDeps): Outbox {
  return {
    enqueue(db: Db, item) {
      if (!KINDS.has(item.kind)) throw new Error(`outbox kind ${item.kind} is not an allowlisted job kind`);
      enqueue(db, deps, {
        kind: item.kind as JobKind,
        payload: { ...item.payload, attemptId: item.attemptId, assessmentId: item.assessmentId },
        idempotencyKey: `${item.kind}:${item.attemptId}`,
      });
    },
  };
}
