import type { Db } from "../../db/open.js";

export type Verdict = "correct" | "incorrect" | "idk" | "pending" | "ambiguous" | "disputed" | "rejected";
export type Confirmation = "confirmed" | "tentative" | "uncertain" | "disputed" | "rejected";
export type AssessmentSource = "deterministic" | "model" | "human";

/** One finding (error span) attached to an assessment. Skill is a stable taxonomy key, e.g. "articles.definite". */
export interface FindingInput {
  skillId: string;
  fragmentStart?: number;
  fragmentEnd?: number;
  correction?: string;
  explanationRu: string;
  findingType: "grammar" | "style" | "ambiguity";
  verdict: Confirmation;
  confidence?: number;
  modelVersionId?: string;
}

/** Work to hand to the future GPU queue in the same transaction as the attempt (spec/02, TASK_008). */
export interface OutboxDescriptor {
  kind: string;
  payload: Record<string, unknown>;
}

export interface AssessmentDecision {
  verdict: Verdict;
  confirmation: Confirmation;
  source: AssessmentSource;
  rationale: string;
  modelVersionId?: string;
  /** the validated AI annotation this revision was derived from (provenance; never authority) */
  aiAnnotationId?: string;
  findings?: FindingInput[];
  outbox?: OutboxDescriptor;
}

export interface AssessContext {
  attemptId: string;
  slotId: string;
  sessionId: string;
  purpose: "practice" | "diagnostic" | "heldout";
  exerciseRevisionId: string;
  exerciseType: string;
  content: unknown;
  questionId: string | null;
  rawAnswer: unknown;
  inputMode: "text" | "voice";
  idk: boolean;
  firstAttempt: boolean;
  hintsBefore: number;
  answerSeenBefore: boolean;
  criterionVersion: string;
}

/**
 * Produces the first assessment of an attempt, synchronously and without side effects (it runs inside the
 * attempt transaction). Closed-form graders arrive with TASK_006/007; a model-backed one only returns `pending`
 * plus an outbox descriptor, it never calls a model here.
 */
export interface Assessor {
  assess(ctx: AssessContext): AssessmentDecision;
}

/** Queue hand-off boundary. The real implementation (persistent jobs) is TASK_008; nothing here calls a model. */
export interface Outbox {
  /** Called inside the attempt transaction; throwing aborts the whole attempt (atomic raw answer + descriptor). */
  enqueue(db: Db, item: OutboxDescriptor & { attemptId: string; assessmentId: string }): void;
}

export const NullOutbox: Outbox = {
  enqueue() {
    /* no queue exists yet: the attempt stays pending, which is stated honestly to the user */
  },
};

/**
 * Default until a grader is registered: an explicit "I don't know" is a deterministic fact; everything else is
 * pending. Never fabricates correctness.
 */
export const PendingAssessor: Assessor = {
  assess(ctx) {
    if (ctx.idk) {
      return { verdict: "idk", confirmation: "confirmed", source: "deterministic", rationale: "User chose \"I don't know\"." };
    }
    return { verdict: "pending", confirmation: "tentative", source: "deterministic", rationale: "No grader registered for this exercise type yet." };
  },
};

export interface AttemptDeps {
  assessor: Assessor;
  outbox: Outbox;
  now: () => Date;
  newId: () => string;
}
