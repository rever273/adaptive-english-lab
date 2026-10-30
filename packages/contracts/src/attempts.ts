import { z } from "zod";

/** Public answer limit (spec/11): 2000 characters. */
export const MAX_ANSWER_CHARS = 2000;
const Id = z.string().min(1).max(64);
const ClientKey = z.string().min(1).max(100);

export const InputModeSchema = z.enum(["text", "voice"]);

/**
 * POST /api/v1/attempts. Exactly one of `answer` / `idk: true`.
 * `answer` is free text (guided/translation/typed) or a list of option/segment IDs (closed formats).
 * The client never sends first-attempt, hint or answer-seen flags: the server derives them from stored events.
 */
export const AttemptRequestSchema = z
  .object({
    slotId: Id,
    submissionId: ClientKey,
    answer: z.union([z.string().min(1).max(MAX_ANSWER_CHARS), z.array(Id).min(1).max(20)]).optional(),
    idk: z.boolean().optional(),
    inputMode: InputModeSchema,
    transcriptId: Id.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const hasAnswer = v.answer !== undefined;
    const idk = v.idk === true;
    if (hasAnswer === idk) ctx.addIssue({ code: "custom", message: "send exactly one of `answer` or `idk: true`" });
    if (v.inputMode === "voice") {
      if (typeof v.answer !== "string") ctx.addIssue({ code: "custom", message: "voice input requires a text answer" });
      if (!v.transcriptId) ctx.addIssue({ code: "custom", message: "voice input requires transcriptId" });
    } else if (v.transcriptId) {
      ctx.addIssue({ code: "custom", message: "transcriptId is only valid with voice input" });
    }
    if (Array.isArray(v.answer) && new Set(v.answer).size !== v.answer.length) {
      ctx.addIssue({ code: "custom", message: "option IDs must be unique" });
    }
  });
export type AttemptRequest = z.infer<typeof AttemptRequestSchema>;

export const VerdictSchema = z.enum(["correct", "incorrect", "idk", "pending", "ambiguous", "disputed", "rejected"]);
export const ConfirmationSchema = z.enum(["confirmed", "tentative", "uncertain", "disputed", "rejected"]);

export const AttemptResponseSchema = z
  .object({
    attemptId: z.string(),
    attemptNo: z.number().int().positive(),
    firstAttempt: z.boolean(),
    /** true when a hint or the answer was seen before this attempt (kept in history, excluded from unaided evidence) */
    assisted: z.boolean(),
    replayed: z.boolean(),
    assessment: z
      .object({
        id: z.string(),
        sequence: z.number().int().positive(),
        verdict: VerdictSchema,
        confirmation: ConfirmationSchema,
        status: z.enum(["assessed", "pending"]),
      })
      .strict(),
    feedback: z.object({ allowed: z.boolean(), reason: z.string().nullable() }).strict(),
  })
  .strict();
export type AttemptResponse = z.infer<typeof AttemptResponseSchema>;

/** POST /api/v1/sessions/:id/events. `reveal`, `finish`, `resume`, `replacement` have their own endpoints/tasks. */
export const SessionEventRequestSchema = z
  .object({
    slotId: Id,
    type: z.enum(["hint", "reveal_answer", "skip", "continue"]),
    clientEventId: ClientKey,
  })
  .strict();
export type SessionEventRequest = z.infer<typeof SessionEventRequestSchema>;

export const SessionEventResponseSchema = z
  .object({
    eventId: z.string(),
    type: z.enum(["hint", "show_answer", "skip", "continue"]),
    slotId: z.string(),
    serverAt: z.string(),
    replayed: z.boolean(),
    /** Russian hint text for a `hint` event (never the answer); null for other events or when hints run out */
    hint: z.string().nullable().optional(),
  })
  .strict();
export type SessionEventResponse = z.infer<typeof SessionEventResponseSchema>;

/** POST /api/v1/assessments/:id/dispute */
export const DisputeRequestSchema = z
  .object({
    reason: z.string().trim().min(1).max(MAX_ANSWER_CHARS),
  })
  .strict();
export type DisputeRequest = z.infer<typeof DisputeRequestSchema>;

export const DisputeResponseSchema = z
  .object({
    disputeId: z.string(),
    attemptId: z.string(),
    assessment: z.object({ id: z.string(), sequence: z.number().int().positive(), verdict: z.literal("disputed"), confirmation: z.literal("disputed") }).strict(),
  })
  .strict();
export type DisputeResponse = z.infer<typeof DisputeResponseSchema>;

/** GET /api/v1/session: bootstrap of the local-service cookie + CSRF token (spec/11). */
export const SessionBootstrapSchema = z.object({ csrfToken: z.string() }).strict();
export type SessionBootstrap = z.infer<typeof SessionBootstrapSchema>;
