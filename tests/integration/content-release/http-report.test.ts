import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ErrorEnvelopeSchema, ExerciseReportResponseSchema, REVIEW_CHECKLIST_KEYS, SessionBootstrapSchema, type ReviewChecklist } from "../../../packages/contracts/src/index.js";
import { buildApp } from "../../../apps/server/src/app.js";
import { approveRevision, isSelectable, publishRelease, registerRevision, submitForReview, submitReview } from "../../../apps/server/src/domain/content/repository.js";
import { loadCandidates } from "../../../apps/server/src/domain/sessions/bank.js";
import { uniq } from "../../fixtures/exercises/load.js";
import { advance, makeEnv, makeSession, one, testConfigFor, type Env } from "../attempts/fixtures.js";

const PORT = 4318;
const HOST = `127.0.0.1:${PORT}`;
const ORIGIN = `http://127.0.0.1:${PORT}`;
let env: Env;
let app: FastifyInstance;
let cookie = "";
let csrf = "";

beforeAll(async () => {
  env = await makeEnv();
  app = await buildApp({ config: testConfigFor(env, PORT), db: env.db, instanceId: "i", startedAt: "2026-01-01T00:00:00Z", shutdownToken: "t", onShutdown: () => {}, csrfSecret: Buffer.alloc(32, 3), attempts: { now: env.deps.now, newId: randomUUID } });
  const boot = await app.inject({ method: "GET", url: "/api/v1/session", headers: { host: HOST } });
  csrf = SessionBootstrapSchema.parse(boot.json()).csrfToken;
  cookie = String(boot.headers["set-cookie"]).split(";")[0]!;
});
afterAll(async () => {
  await app.close();
  env.cleanup();
});

const deps = () => ({ now: env.deps.now, newId: randomUUID });
const post = (url: string, payload: unknown, headers: Record<string, string> = {}) => app.inject({ method: "POST", url, payload: payload as object, headers: { host: HOST, origin: ORIGIN, cookie, "x-csrf-token": csrf, ...headers } });

it("blocks the Studio release route for vocabulary and excludes released vocabulary from the grammar bank", async () => {
  const content = uniq("choose_form", "Vocabulary isolation");
  content.vocabulary = {
    schemaVersion: "vocabulary-practice-v1",
    family: "recognition",
    target: { entryId: "test-entry", lemma: "publish", senseId: "test-sense", partOfSpeech: "verb", surfaceForm: "published" },
    options: content.payload.options.map((o: { id: string; text: string }) => ({ ...o, rationaleRu: "Тестовое пояснение." })),
    acceptedOptionId: content.payload.accepted_option_ids[0],
  };
  const revision = registerRevision(env.db, deps(), { content, actor: { type: "agent", id: "author" } });
  const response = await post("/api/v1/content/releases", { revisionIds: [revision.revisionId], reviewer: "agent:reviewer@1", manifestHash: "a".repeat(64) });
  expect(response.statusCode).toBe(422);
  expect(response.json().error.code).toBe("VOCABULARY_PACK_REQUIRED");

  submitForReview(env.db, deps(), revision.revisionId, { type: "agent", id: "reviewer" });
  const checklist = Object.fromEntries(REVIEW_CHECKLIST_KEYS.map((k) => [k, true])) as ReviewChecklist;
  submitReview(env.db, deps(), { revisionId: revision.revisionId, reviewer: "agent:reviewer@1", reviewVersion: "v1", contentHash: revision.contentHash, checklist, verdict: "approved" });
  approveRevision(env.db, deps(), { revisionId: revision.revisionId, actor: { type: "agent", id: "reviewer" } });
  publishRelease(env.db, deps(), { revisionIds: [revision.revisionId], reviewer: "agent:reviewer@1" });
  expect(isSelectable(env.db, revision.revisionId)).toBe(true);
  expect(loadCandidates(env.db, "practice").some((candidate) => candidate.revisionId === revision.revisionId)).toBe(false);
});

let n = 0;
function released() {
  const r = registerRevision(env.db, deps(), { content: uniq("choose_form", `Variant${++n}`), actor: { type: "model", id: "qwen" } });
  submitForReview(env.db, deps(), r.revisionId, { type: "agent", id: "a" });
  advance(env, 5);
  const checklist = Object.fromEntries(REVIEW_CHECKLIST_KEYS.map((k) => [k, k === "distractors_valid" || k === "no_mistake_case_correct" ? "n/a" : true])) as ReviewChecklist;
  submitReview(env.db, deps(), { revisionId: r.revisionId, reviewer: "agent:a@1", reviewVersion: "v1", contentHash: r.contentHash, checklist, verdict: "approved" });
  advance(env, 5);
  approveRevision(env.db, deps(), { revisionId: r.revisionId, actor: { type: "agent", id: "a" } });
  publishRelease(env.db, deps(), { revisionIds: [r.revisionId], reviewer: "agent:a@1" });
  return r;
}

describe("POST /api/v1/exercises/:id/report", () => {
  it("flags the revision, revokes eligibility and returns the contract shape", async () => {
    const r = released();
    expect(isSelectable(env.db, r.revisionId)).toBe(true);
    const session = makeSession(env);
    const res = await post(`/api/v1/exercises/${r.exerciseId}/report`, { revisionId: r.revisionId, reason: "The answer is wrong.", sessionId: session });
    expect(res.statusCode).toBe(201);
    expect(ExerciseReportResponseSchema.parse(res.json())).toMatchObject({ revisionId: r.revisionId, state: "flagged", eligibilityRevoked: true });
    expect(isSelectable(env.db, r.revisionId)).toBe(false);
    expect(one<{ session_id: string }>(env.db, "SELECT session_id FROM exercise_reports").session_id).toBe(session);
  });

  it("is protected like every mutation (cookie + CSRF + Origin)", async () => {
    const r = released();
    const noCsrf = await post(`/api/v1/exercises/${r.exerciseId}/report`, { revisionId: r.revisionId, reason: "x" }, { "x-csrf-token": "" });
    expect(noCsrf.statusCode).toBe(403);
    expect(isSelectable(env.db, r.revisionId)).toBe(true);
  });

  it.each([
    ["no reason", { revisionId: "r" }],
    ["blank reason", { revisionId: "r", reason: "   " }],
    ["reason over 2000 chars", { revisionId: "r", reason: "x".repeat(2001) }],
    ["unknown field (e.g. a status)", { revisionId: "r", reason: "x", status: "approved" }],
  ])("rejects %s", async (_n, body) => {
    const res = await post(`/api/v1/exercises/${randomUUID()}/report`, body);
    expect(res.statusCode).toBe(400);
    expect(ErrorEnvelopeSchema.parse(res.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("404s a revision of another exercise or an unknown session", async () => {
    const r = released();
    const wrongExercise = await post(`/api/v1/exercises/${randomUUID()}/report`, { revisionId: r.revisionId, reason: "x" });
    expect(wrongExercise.statusCode).toBe(404);
    const noSession = await post(`/api/v1/exercises/${r.exerciseId}/report`, { revisionId: r.revisionId, reason: "x", sessionId: randomUUID() });
    expect(noSession.statusCode).toBe(404);
    expect(isSelectable(env.db, r.revisionId)).toBe(true);
  });
});
