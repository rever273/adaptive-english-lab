import type { FastifyInstance } from "fastify";
import { addExpression, editExpression, listExpressions, removeExpression, retryExpression } from "../domain/vocabulary/expressions.js";

const idParams = { schema: { params: { type: "object", properties: { id: { type: "string", minLength: 1, maxLength: 64 } }, required: ["id"] } } } as const;

/** Expressions: the second part of the dictionary (phrases of several words). Saving is instant, the draft comes from the local model later. */
export function registerVocabularyExpressionRoutes(app: FastifyInstance, db: Parameters<typeof listExpressions>[0], deps: { now: () => Date; newId?: () => string }, hooks: { onQueued?: () => void } = {}): void {
  app.get("/api/v1/vocabulary/expressions", async () => ({ expressions: listExpressions(db) }));
  app.post("/api/v1/vocabulary/expressions", async (req, reply) => {
    const r = addExpression(db, deps, req.body);
    hooks.onQueued?.();
    return reply.code(r.created ? 201 : 200).send({ ...r.expression, created: r.created });
  });
  app.post<{ Params: { id: string } }>("/api/v1/vocabulary/expressions/:id/edit", idParams, async (req) => editExpression(db, deps, req.params.id, req.body));
  app.post<{ Params: { id: string } }>("/api/v1/vocabulary/expressions/:id/retry", idParams, async (req) => {
    const r = retryExpression(db, deps, req.params.id);
    hooks.onQueued?.();
    return r;
  });
  app.post<{ Params: { id: string } }>("/api/v1/vocabulary/expressions/:id/remove", idParams, async (req) => removeExpression(db, deps, req.params.id));
}
