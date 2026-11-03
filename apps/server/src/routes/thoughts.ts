import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/open.js";
import { ApiError } from "../errors.js";
import { addThought, createThoughtBatch, listThoughts, thoughtsNeedingSkills, thoughtsReady, type ThoughtDeps } from "../domain/thoughts/repository.js";

const Body = z.object({ text: z.string() }).strict();

/** TASK_026: save the learner's own Russian thoughts (the model reads them later through the queue) and turn analysed ones into one ordinary draft batch. */
export function registerThoughtRoutes(app: FastifyInstance, db: Db, deps: ThoughtDeps, hooks: { onQueued?: () => void } = {}): void {
  app.post("/api/v1/thoughts", async (req, reply) => {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, "VALIDATION_ERROR", "Request body is invalid", parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
    const r = addThought(db, deps, parsed.data.text);
    if (r.created) hooks.onQueued?.();
    return reply.code(r.created ? 201 : 200).send(r);
  });
  app.get("/api/v1/thoughts", async () => ({ thoughts: listThoughts(db), readyForBatch: thoughtsReady(db), needSkills: thoughtsNeedingSkills(db) }));
  app.post("/api/v1/thoughts/batch", async (_req, reply) => {
    const r = createThoughtBatch(db, deps);
    hooks.onQueued?.();
    return reply.code(202).send(r);
  });
}
