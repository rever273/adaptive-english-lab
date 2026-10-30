import type { FastifyInstance } from "fastify";
import type { ZodType } from "zod";
import { AttemptRequestSchema, DisputeRequestSchema, SessionEventRequestSchema } from "@english-lab/contracts";
import type { Db } from "../db/open.js";
import { disputeAssessment } from "../domain/attempts/assessments.js";
import { recordAttempt } from "../domain/attempts/attempts.js";
import type { AttemptDeps } from "../domain/attempts/ports.js";
import { recordSessionEvent } from "../domain/attempts/sessionEvents.js";
import { ApiError } from "../errors.js";

function parse<T>(schema: ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) {
    throw new ApiError(400, "VALIDATION_ERROR", "Request body is invalid", r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  return r.data;
}

const idParams = { type: "object", properties: { id: { type: "string", minLength: 1, maxLength: 64 } }, required: ["id"] } as const;

export function registerAttemptRoutes(app: FastifyInstance, db: Db, deps: AttemptDeps): void {
  app.post("/api/v1/attempts", async (req, reply) => {
    const body = parse(AttemptRequestSchema, req.body);
    const r = recordAttempt(db, deps, body);
    return reply.code(r.status).send(r.body);
  });

  app.post<{ Params: { id: string } }>("/api/v1/sessions/:id/events", { schema: { params: idParams } }, async (req, reply) => {
    const body = parse(SessionEventRequestSchema, req.body);
    const r = recordSessionEvent(db, deps, req.params.id, body);
    return reply.code(r.status).send(r.body);
  });

  app.post<{ Params: { id: string } }>("/api/v1/assessments/:id/dispute", { schema: { params: idParams } }, async (req, reply) => {
    const body = parse(DisputeRequestSchema, req.body);
    const r = disputeAssessment(db, deps, { assessmentId: req.params.id, reason: body.reason });
    return reply.code(201).send({
      disputeId: r.disputeId,
      attemptId: r.attemptId,
      assessment: { id: r.assessment.id, sequence: r.assessment.sequence, verdict: "disputed", confirmation: "disputed" },
    });
  });
}
