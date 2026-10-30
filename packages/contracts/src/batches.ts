import { z } from "zod";
import { EXERCISE_TYPES, ReviewChecklistSchema } from "./exercises.js";

/** TASK_010 / spec/02: content batches. Every count in a response is a count of real rows, never a requested number. */
export const BATCH_MODES = ["adaptive", "balanced", "manual"] as const;
export const TRIAL_SIZE = 24;
export const TRIAL_PER_TYPE = 4;

export const CreateBatchRequestSchema = z
  .object({
    count: z.number().int().min(1).max(500),
    mode: z.enum(BATCH_MODES),
    /** the 24-draft trial (4 per format) that must be fully reviewed before any larger batch */
    trial: z.boolean().default(false),
    /** skills to cover (required for manual; optional restriction for balanced/adaptive) */
    skills: z.array(z.string().min(1).max(120)).max(200).optional(),
    types: z.array(z.enum(EXERCISE_TYPES)).min(1).max(6).optional(),
  })
  .strict();
export type CreateBatchRequest = z.infer<typeof CreateBatchRequestSchema>;

export const ReviewManifestSchema = z
  .object({
    schema_version: z.literal("content-review-v1"),
    reviewer: z.string().min(1).max(200),
    review_version: z.string().min(1).max(120),
    items: z
      .array(
        z
          .object({
            revision_id: z.string().min(1).max(64),
            content_hash: z.string().regex(/^[0-9a-f]{64}$/),
            verdict: z.enum(["approved", "flagged", "rejected"]),
            checklist: ReviewChecklistSchema,
            reason: z.string().trim().min(1).max(2000),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();
export type ReviewManifest = z.infer<typeof ReviewManifestSchema>;

export const PublishReleaseRequestSchema = z
  .object({
    revisionIds: z.array(z.string().min(1).max(64)).min(1).max(500),
    reviewer: z.string().min(1).max(200),
    /** hash of the exact (revision, content hash, review) set the reviewer saw; refused when the current content differs */
    manifestHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type PublishReleaseRequest = z.infer<typeof PublishReleaseRequestSchema>;
