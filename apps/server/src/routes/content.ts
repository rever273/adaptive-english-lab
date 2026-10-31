import type { FastifyInstance } from "fastify";
import { CreateBatchRequestSchema, ExerciseReportRequestSchema, PublishReleaseRequestSchema, type ExerciseReportResponse } from "@english-lab/contracts";
import type { Db } from "../db/open.js";
import { planRelease, publishRelease, reportExercise, type ContentDeps } from "../domain/content/repository.js";
import { coverage, createBatch, getBatch, listBatches, trialGate } from "../domain/content/batches/repository.js";
import { importReviewManifest } from "../domain/content/batches/reviewImport.js";
import { ApiError } from "../errors.js";
import { completeBatch } from "../domain/content/batches/completion.js";
import { replenishmentStock } from "../domain/content/batches/stock.js";

export function registerContentRoutes(app: FastifyInstance, db: Db, deps: ContentDeps, hooks: { onBatchQueued?: () => void } = {}): void {
  const bad = (e: { issues: Array<{ path: PropertyKey[]; message: string }> }) => new ApiError(400, "VALIDATION_ERROR", "Request body is invalid", e.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const idParams = { schema: { params: { type: "object", properties: { id: { type: "string", minLength: 1, maxLength: 64 } }, required: ["id"] } } };

  // "Report incorrect exercise": flags an approved revision at once (eligibility revoked); never deletes anything.
  app.post<{ Params: { id: string } }>(
    "/api/v1/exercises/:id/report",
    { schema: { params: { type: "object", properties: { id: { type: "string", minLength: 1, maxLength: 64 } }, required: ["id"] } } },
    async (req, reply) => {
      const parsed = ExerciseReportRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ApiError(400, "VALIDATION_ERROR", "Request body is invalid", parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
      }
      const r = reportExercise(db, deps, { exerciseId: req.params.id, ...parsed.data });
      const body: ExerciseReportResponse = { reportId: r.reportId, revisionId: parsed.data.revisionId, state: r.state, eligibilityRevoked: r.eligibilityRevoked };
      return reply.code(201).send(body);
    },
  );

  // ---- TASK_010: draft batches, review import, coverage, controlled release (spec/02) ----
  // Creating a batch only stores the request and queues short jobs; the dispatcher runs them. Nothing here calls a model.
  app.post("/api/v1/content/batches", async (req, reply) => {
    const parsed = CreateBatchRequestSchema.safeParse(req.body);
    if (!parsed.success) throw bad(parsed.error);
    const created = createBatch(db, deps, parsed.data);
    hooks.onBatchQueued?.();
    return reply.code(202).send(created);
  });
  app.get("/api/v1/content/batches", async () => ({ batches: listBatches(db), trialGate: trialGate(db) }));
  app.get<{ Params: { id: string } }>("/api/v1/content/batches/:id", idParams, async (req) => ({ ...getBatch(db, req.params.id), trialGate: trialGate(db) }));
  app.get("/api/v1/content/coverage", async () => coverage(db));
  app.get("/api/v1/content/stock", async () => replenishmentStock(db));
  app.post<{ Params: { id: string } }>("/api/v1/content/batches/:id/complete", { ...idParams, bodyLimit: 10 * 1024 * 1024 }, async (req, reply) => {
    if ((req.body as { plan?: { batch_id?: string } })?.plan?.batch_id !== req.params.id) throw new ApiError(400, "BATCH_MISMATCH", "Plan must name this batch");
    return reply.code(200).send(completeBatch(db, deps, req.body));
  });
  // read-only view of one stored revision (what the reviewer is asked to judge)
  app.get<{ Params: { id: string } }>("/api/v1/content/revisions/:id", idParams, async (req) => {
    const r = db.prepare("SELECT er.id AS revisionId, er.content_hash AS contentHash, er.content_json AS c, s.status AS status FROM exercise_revisions er JOIN latest_content_state s ON s.revision_id = er.id WHERE er.id = ?").get(req.params.id) as { revisionId: string; contentHash: string; c: string; status: string } | undefined;
    if (!r) throw new ApiError(404, "REVISION_NOT_FOUND", "Unknown revision");
    return { revisionId: r.revisionId, contentHash: r.contentHash, status: r.status, content: JSON.parse(r.c) as unknown };
  });
  app.post<{ Params: { id: string } }>("/api/v1/content/batches/:id/review-import", idParams, async (req, reply) => reply.code(201).send(importReviewManifest(db, deps, req.params.id, req.body)));
  // What the reviewer is about to publish: the exact (revision, hash, review) set and its manifest hash. Read-only.
  app.post("/api/v1/content/releases/preview", async (req) => {
    const parsed = PublishReleaseRequestSchema.pick({ revisionIds: true }).safeParse(req.body);
    if (!parsed.success) throw bad(parsed.error);
    return planRelease(db, parsed.data.revisionIds);
  });
  app.post("/api/v1/content/releases", async (req, reply) => {
    const parsed = PublishReleaseRequestSchema.safeParse(req.body);
    if (!parsed.success) throw bad(parsed.error);
    const isVocabulary = db.prepare("SELECT json_type(content_json, '$.vocabulary') IS NOT NULL AS vocabulary FROM exercise_revisions WHERE id = ?");
    if (parsed.data.revisionIds.some((id) => (isVocabulary.get(id) as { vocabulary: number } | undefined)?.vocabulary)) {
      throw new ApiError(422, "VOCABULARY_PACK_REQUIRED", "Vocabulary revisions must be published through pack with an independent review manifest");
    }
    const r = publishRelease(db, deps, { revisionIds: parsed.data.revisionIds, reviewer: parsed.data.reviewer, expectedManifestHash: parsed.data.manifestHash });
    return reply.code(r.replayed ? 200 : 201).send({ ...r, released: r.items.length, note: "only the listed revisions were published; this is not a statement about the rest of any batch" });
  });
}
