import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/open.js";
import { ApiError } from "../errors.js";
import { addWord, getEntry, listWords, lookupWord, patchWord, revisionHistory, vocabularyTotals } from "../domain/vocabulary/repository.js";

const idParams = { schema: { params: { type: "object", properties: { id: { type: "string", minLength: 1, maxLength: 64 } }, required: ["id"] } } } as const;
const ListQuery = z.object({ q: z.string().max(80).optional(), learned: z.enum(["true", "false"]).optional(), limit: z.coerce.number().int().min(1).max(1000).optional() }).strict();

/**
 * Vocabulary (spec/02): saving is immediate and never waits for the AI; text edits carry the revision they were made from and a stale edit is a 409
 * that shows the current text instead of overwriting anything. There is no review schedule and no flashcard endpoint on purpose.
 */
export function registerVocabularyRoutes(app: FastifyInstance, db: Db, deps: { now: () => Date; newId?: () => string }): void {
  app.post("/api/v1/vocabulary", async (req, reply) => {
    const r = addWord(db, deps, req.body);
    return reply.code(r.created ? 201 : 200).send({ ...r.entry, created: r.created });
  });

  app.get("/api/v1/vocabulary", async (req) => {
    const q = ListQuery.safeParse(req.query);
    if (!q.success) throw new ApiError(400, "VALIDATION_ERROR", "Query is invalid", q.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
    return { ...listWords(db, { q: q.data.q, learned: q.data.learned === undefined ? undefined : q.data.learned === "true", limit: q.data.limit }), totals: vocabularyTotals(db) };
  });

  // for the word popup: is this word (or a form of it) already saved?
  app.get("/api/v1/vocabulary/lookup", async (req) => {
    const w = z.object({ word: z.string().min(1).max(120) }).strict().safeParse(req.query);
    if (!w.success) throw new ApiError(400, "VALIDATION_ERROR", "Query is invalid");
    const entry = lookupWord(db, w.data.word);
    return { known: entry !== null, entry };
  });

  app.get<{ Params: { id: string } }>("/api/v1/vocabulary/:id", idParams, async (req) => ({ ...getEntry(db, req.params.id), history: revisionHistory(db, req.params.id) }));

  app.patch<{ Params: { id: string } }>("/api/v1/vocabulary/:id", idParams, async (req) => patchWord(db, deps, req.params.id, req.body));
}
