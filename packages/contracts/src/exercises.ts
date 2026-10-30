import { z } from "zod";

export const EXERCISE_TYPES = ["choose_form", "choose_missing_fragment", "detect_error", "guided_short_answer", "russian_to_english_short", "context_reading"] as const;
export type ExerciseType = (typeof EXERCISE_TYPES)[number];

export const CONTENT_STATUSES = ["draft", "validated", "pending_review", "approved", "flagged", "rejected"] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

export const ACTOR_TYPES = ["code", "model", "agent", "user"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

/** Dimension is decided by the format (spec/05 table). */
export const DIMENSION_BY_TYPE: Record<ExerciseType, "recognition" | "correction" | "production"> = {
  choose_form: "recognition",
  choose_missing_fragment: "recognition",
  context_reading: "recognition",
  detect_error: "correction",
  guided_short_answer: "production",
  russian_to_english_short: "production",
};

/** Reviewer checklist (spec/05). Every item must be true for an approval; two items may be "n/a" by format. */
export const REVIEW_CHECKLIST_KEYS = [
  "natural_en_au_b2",
  "unambiguous_goal",
  "taxonomy_correct",
  "all_accepted_answers",
  "distractors_valid",
  "no_mistake_case_correct",
  "russian_explanation",
  "style_grammar_separated",
  "no_private_data",
  "no_exact_near_duplicates",
  "size_ok",
  "no_heldout_leakage",
  "provenance_checked",
] as const;
export const NA_ALLOWED_KEYS: ReadonlyArray<(typeof REVIEW_CHECKLIST_KEYS)[number]> = ["distractors_valid", "no_mistake_case_correct"];

const ChecklistValue = z.union([z.boolean(), z.literal("n/a")]);
export const ReviewChecklistSchema = z
  .object(Object.fromEntries(REVIEW_CHECKLIST_KEYS.map((k) => [k, ChecklistValue])) as Record<(typeof REVIEW_CHECKLIST_KEYS)[number], typeof ChecklistValue>)
  .strict();
export type ReviewChecklist = z.infer<typeof ReviewChecklistSchema>;

/** `human:<name>` or `agent:<name>@<version>`: an agent review is never presented as a human one (spec/05). */
export const ReviewerSchema = z.string().regex(/^(human|agent):[^\s].{0,119}$/, "reviewer must be 'human:<name>' or 'agent:<name>@<version>'");

export interface ValidationIssue {
  code: string;
  path: string;
  message: string;
}

export interface PromptUnitFingerprint {
  role: "prompt" | "option" | "answer" | "passage";
  ordinal: number;
  /** normalised text that was hashed (norm-v1) */
  text: string;
  fingerprint: string;
}

/** Output of the validator. `ok` never means approved: it only means "structurally valid and eligible for validated". */
export interface ValidationResult {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  contentHash: string | null;
  units: PromptUnitFingerprint[];
}

/** POST /api/v1/exercises/:id/report */
export const ExerciseReportRequestSchema = z
  .object({
    revisionId: z.string().min(1).max(64),
    sessionId: z.string().min(1).max(64).optional(),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();
export type ExerciseReportRequest = z.infer<typeof ExerciseReportRequestSchema>;

export const ExerciseReportResponseSchema = z
  .object({
    reportId: z.string(),
    revisionId: z.string(),
    state: z.enum(CONTENT_STATUSES),
    /** true when this report took the revision out of selection */
    eligibilityRevoked: z.boolean(),
  })
  .strict();
export type ExerciseReportResponse = z.infer<typeof ExerciseReportResponseSchema>;
