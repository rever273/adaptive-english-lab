import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { SessionBootstrapSchema } from "../../../packages/contracts/src/index.js";
import { buildApp } from "../../../apps/server/src/app.js";
import type { CallStats, ChatClient, ChatResult } from "../../../apps/server/src/domain/ai/clients.js";
import { AI_CONFIG_V3 } from "../../../apps/server/src/domain/ai/config.js";
import { takeLease } from "../../../apps/server/src/domain/sessions/lease.js";
import { createDiagnosticBlock } from "../../../apps/server/src/domain/diagnostics/session.js";
import { finishSession } from "../../../apps/server/src/domain/sessions/finish.js";
import { EXPORT_LIMITS, agentTask, exportExercise, exportSession, mdText } from "../../../apps/server/src/domain/tutor/agentExport.js";
import { askTutor, getThread } from "../../../apps/server/src/domain/tutor/repository.js";
import { TutorJobRunner, validateTutorOutput } from "../../../apps/server/src/domain/tutor/runner.js";
import { GpuScheduler } from "../../../apps/server/src/queue/scheduler.js";
import { ApiError } from "../../../apps/server/src/errors.js";
import { FakeClock, FakeGpu, flush } from "../../fixtures/queue/fakes.js";
import { answerSlot, diagEnv, practiseRevisions, sessionDeps, slotsOf } from "../diagnostics/fixtures.js";
import { freePort, testConfig } from "../helpers.js";
import { makeRevision, makeSession, makeSlot, addEvent, one, rows, type Env } from "../attempts/fixtures.js";

let env: Env | null = null;
let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
  env?.cleanup();
  env = null;
});
const fails = (fn: () => unknown, status: number, code: string) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).status).toBe(status);
    expect((e as ApiError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
};

const req = { purpose: "diagnostic" as const, timezone: "Australia/Brisbane", seed: "tutor" };

/** a real diagnostic block (real reservations and exposure): the first n slots answered through the real attempt path, the block then finished */
async function practised(n = 2, finish = true) {
  const d = await diagEnv({ practice: true, diagnostic: true });
  env = d.env;
  const block = createDiagnosticBlock(env.db, sessionDeps(env), req);
  const all = slotsOf(env, block.sessionId);
  all.slice(0, n).forEach((s) => answerSlot(env!, block.sessionId, s));
  if (finish) finishSession(env.db, sessionDeps(env), block.sessionId, "ended_early");
  const slots = all.map((s) => ({ id: s.slot_id, revision: s.revision_id }));
  return { sessionId: block.sessionId, slots };
}

describe("asking the tutor", () => {
  it("shows the APPROVED rule immediately, with no model, no job and no chat call", async () => {
    const { sessionId, slots } = await practised();
    const slot = slots[0]!;
    const rule = (JSON.parse(one<{ c: string }>(env!.db, "SELECT content_json AS c FROM exercise_revisions WHERE id = ?", slot.revision).c) as { explanation_ru: string }).explanation_ru;
    // "Why?" answers once per task: pressing it again returns the same reply and adds nothing
    for (let i = 0; i < 2; i++) {
      const r = askTutor(env!.db, sessionDeps(env!), { sessionId, slotId: slot.id, kind: "why" });
      expect(r.jobId).toBeNull();
      const last = r.messages[r.messages.length - 1]!;
      expect(last).toMatchObject({ role: "assistant", source: "approved_exercise", status: "approved", text: rule });
    }
    expect(rows(env!.db, "SELECT id FROM jobs WHERE kind = 'tutor'")).toEqual([]);
    expect(getThread(env!.db, slot.id).messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("D64: 'Explain in Russian' is a longer AI explanation (a queued job), and pressing it again while it waits queues nothing new", async () => {
    const { sessionId, slots } = await practised();
    const slot = slots[0]!;
    const first = askTutor(env!.db, sessionDeps(env!), { sessionId, slotId: slot.id, kind: "explain_ru" });
    expect(first.jobId).not.toBeNull();
    const again = askTutor(env!.db, sessionDeps(env!), { sessionId, slotId: slot.id, kind: "explain_ru" });
    expect(again.jobId).toBe(first.jobId);
    const more = askTutor(env!.db, sessionDeps(env!), { sessionId, slotId: slot.id, kind: "more_examples" });
    expect(askTutor(env!.db, sessionDeps(env!), { sessionId, slotId: slot.id, kind: "more_examples" }).jobId).toBe(more.jobId);
    expect(rows(env!.db, "SELECT id FROM jobs WHERE kind = 'tutor'")).toHaveLength(2);
    expect(getThread(env!.db, slot.id).messages.filter((m) => m.role === "user")).toHaveLength(2);
  });

  it("opens only after the answer: an unanswered slot, a foreign slot, bad input and closed diagnostic blocks are refused", async () => {
    const { sessionId, slots } = await practised(1);
    const open = slots[slots.length - 1]!.id; // never answered, no skip/show_answer
    fails(() => askTutor(env!.db, sessionDeps(env!), { sessionId, slotId: open, kind: "why" }), 409, "FEEDBACK_NOT_AVAILABLE");
    const other = makeSession(env!);
    fails(() => askTutor(env!.db, sessionDeps(env!), { sessionId: other, slotId: slots[0]!.id, kind: "why" }), 404, "SLOT_NOT_FOUND");
    for (const bad of [{ sessionId, slotId: slots[0]!.id, kind: "question" }, { sessionId, slotId: slots[0]!.id, kind: "question", question: "   " }, { sessionId, slotId: slots[0]!.id, kind: "question", question: "x".repeat(2001) }, { sessionId, slotId: slots[0]!.id, kind: "hack" }, { sessionId, slotId: slots[0]!.id, kind: "why", sql: "DROP TABLE attempts" }, "nope"]) {
      fails(() => askTutor(env!.db, sessionDeps(env!), bad), 400, "VALIDATION_ERROR");
    }
    expect(rows(env!.db, "SELECT id FROM tutor_messages")).toEqual([]); // nothing was stored for any refusal
    expect(one<{ n: number }>(env!.db, "SELECT COUNT(*) AS n FROM attempts").n).toBe(1);
  });

  it("a diagnostic block stays closed while it is active (the tutor can never leak its answers); a skipped task has no rule to show", async () => {
    const { sessionId, slots } = await practised(2, false);
    fails(() => askTutor(env!.db, sessionDeps(env!), { sessionId, slotId: slots[0]!.id, kind: "why" }), 409, "TUTOR_NOT_AVAILABLE");
    expect(rows(env!.db, "SELECT id FROM tutor_messages")).toEqual([]);
    addEvent(env!, sessionId, slots[3]!.id, "reveal");
    addEvent(env!, sessionId, slots[3]!.id, "skip");
    finishSession(env!.db, sessionDeps(env!), sessionId, "ended_early");
    fails(() => askTutor(env!.db, sessionDeps(env!), { sessionId, slotId: slots[3]!.id, kind: "why" }), 409, "TUTOR_NOT_AVAILABLE");
    askTutor(env!.db, sessionDeps(env!), { sessionId, slotId: slots[0]!.id, kind: "why" }); // opens once the block is over
  });

  it("allows discussion of a tentative answer after a diagnostic block without changing its assessment", async () => {
    const { sessionId, slots } = await practised(1);
    const attempt = one<{ id: string }>(env!.db, "SELECT id FROM attempts WHERE slot_id = ?", slots[0]!.id);
    const latest = one<{ id: string; sequence: number }>(env!.db, "SELECT id, sequence FROM assessment_revisions WHERE attempt_id = ? ORDER BY sequence DESC LIMIT 1", attempt.id);
    env!.db.prepare("INSERT INTO assessment_revisions(id, attempt_id, sequence, source, verdict, confirmation, criterion_version, supersedes_id, rationale, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(randomUUID(), attempt.id, latest.sequence + 1, "model", "correct", "tentative", "test", latest.id, "draft", "2026-10-31T00:00:00Z");
    const before = one<{ n: number }>(env!.db, "SELECT COUNT(*) AS n FROM assessment_revisions").n;
    expect(askTutor(env!.db, sessionDeps(env!), { sessionId, slotId: slots[0]!.id, kind: "question", question: "Is my answer correct?" }).jobId).toBeTruthy();
    expect(one<{ n: number }>(env!.db, "SELECT COUNT(*) AS n FROM assessment_revisions").n).toBe(before);
  });

  it("the history of tutor messages cannot be edited or deleted, and a message cannot claim approval for model text", async () => {
    const { sessionId, slots } = await practised(1);
    askTutor(env!.db, sessionDeps(env!), { sessionId, slotId: slots[0]!.id, kind: "why" });
    expect(() => env!.db.prepare("UPDATE tutor_messages SET text = 'x'").run()).toThrow(/append-only/);
    expect(() => env!.db.prepare("DELETE FROM tutor_messages").run()).toThrow(/append-only/);
    expect(() =>
      env!.db.prepare("INSERT INTO tutor_messages(id, thread_id, role, kind, source, text, context_json, job_id, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(randomUUID(), slots[0]!.id, "assistant", "why", "model", "t", "{}", null, "approved", "2026-10-28T00:00:00Z"),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------------------------------------------------- the local model
const stats: CallStats = { totalMs: 10, loadMs: null, promptTokens: 5, evalTokens: 5, evalMs: 5 };
class ScriptedChat implements ChatClient {
  calls = 0;
  constructor(public respond: (messageId: string) => string) {}
  async chat(req: { messages: Array<{ role: string; content: string }> }): Promise<ChatResult> {
    this.calls++;
    const user = JSON.parse(req.messages[1]!.content) as { message_id: string };
    return { text: this.respond(user.message_id), stats };
  }
}
const good = (_id: string, o: Record<string, unknown> = {}) => JSON.stringify({ schema_version: "tutor-v1", explanation_ru: "Правило объяснено подробнее.", examples_en: ["The ferry leaves at noon."], uncertainty_note: "", ...o });

async function rig(respond: (messageId: string) => string) {
  const p = await practised(1);
  const clock = new FakeClock();
  const gpu = new FakeGpu(clock);
  const chat = new ScriptedChat(respond);
  const runner = new TutorJobRunner({ db: env!.db, chat, installedDigest: async () => AI_CONFIG_V3.analysis.digest, runtimeVersion: async () => "test", deps: { now: () => new Date(env!.clock.current), newId: randomUUID }, sleep: async () => {} });
  await runner.prepare();
  const sched = new GpuScheduler({ db: env!.db, newId: randomUUID, clock, telemetry: gpu, control: gpu, runners: [runner], instanceId: "A", config: { admission: "spike", idleUnloadMs: 600_000 } });
  const settle = async (jobId: string, ticks = 60) => {
    for (let i = 0; i < ticks; i++) {
      await sched.tick();
      await flush();
      await flush();
      const j = env!.db.prepare("SELECT state FROM jobs WHERE id = ?").get(jobId) as { state: string };
      if (["completed", "failed", "cancelled"].includes(j.state)) { return j.state; }
      clock.advance(1500);
    }
    return one<{ state: string }>(env!.db, "SELECT state FROM jobs WHERE id = ?", jobId).state;
  };
  return { ...p, chat, settle };
}

describe("the model's part (the local model through the dispatcher)", () => {
  it("more examples: queued at priority 2, answered as a labelled DRAFT; the approved rule stays separate and no score or attempt changes", async () => {
    const r = await rig((id) => good(id));
    const attemptsBefore = one<{ n: number }>(env!.db, "SELECT COUNT(*) AS n FROM attempts").n;
    const asked = askTutor(env!.db, sessionDeps(env!), { sessionId: r.sessionId, slotId: r.slots[0]!.id, kind: "more_examples" });
    expect(rows<{ priority: number; state: string }>(env!.db, "SELECT priority, state FROM jobs WHERE kind = 'tutor'")).toEqual([{ priority: 2, state: "queued" }]);
    expect(r.chat.calls).toBe(0); // asking itself never calls a model
    expect(await r.settle(asked.jobId!)).toBe("completed");
    const t = getThread(env!.db, r.slots[0]!.id);
    const draft = t.messages.filter((m) => m.source === "model");
    expect(draft).toHaveLength(1);
    expect(draft[0]).toMatchObject({ status: "draft", role: "assistant", examples: ["The ferry leaves at noon."] });
    expect(t.messages.filter((m) => m.source === "approved_exercise")).toHaveLength(1);
    expect(one<{ n: number }>(env!.db, "SELECT COUNT(*) AS n FROM attempts").n).toBe(attemptsBefore);
    expect(rows(env!.db, "SELECT id FROM tutor_messages WHERE status = 'approved' AND source = 'model'")).toEqual([]);
  });

  it("while Practice is active the queued job waits and no model is called; it runs once practice ends", async () => {
    const r = await rig((id) => good(id));
    const live = makeSession(env!);
    takeLease(env!.db, sessionDeps(env!) as never, live, "tab-1");
    const asked = askTutor(env!.db, sessionDeps(env!), { sessionId: r.sessionId, slotId: r.slots[0]!.id, kind: "question", question: "Why not the other form?" });
    expect(await r.settle(asked.jobId!, 8)).not.toBe("completed");
    expect(r.chat.calls).toBe(0);
    env!.db.prepare("DELETE FROM practice_leases").run();
    expect(await r.settle(asked.jobId!)).toBe("completed");
    expect(r.chat.calls).toBe(1);
  });

  it("an invalid answer (prose, English explanation, copied sentence, more than 3 examples, extra field) is refused: no message is stored", async () => {
    const own = () => (JSON.parse(one<{ c: string }>(env!.db, "SELECT er.content_json AS c FROM session_slots ss JOIN exercise_revisions er ON er.id = ss.exercise_revision_id ORDER BY ss.rowid LIMIT 1").c) as { prompt_en: string }).prompt_en;
    const bads: Array<(id: string) => string> = [
      () => "Sure! Here you go.",
      (id) => good(id, { explanation_ru: "This is English." }),
      (id) => good(id, { examples_en: [own()] }),
      (id) => good(id, { examples_en: ["A new one.", "Another one.", "Third one.", "Fourth one."] }),
      (id) => good(id, { status: "approved" }),
    ];
    for (const bad of bads) {
      const r = await rig(bad);
      const asked = askTutor(env!.db, sessionDeps(env!), { sessionId: r.sessionId, slotId: r.slots[0]!.id, kind: "more_examples" });
      expect(await r.settle(asked.jobId!)).toBe("failed");
      expect(getThread(env!.db, r.slots[0]!.id).messages.filter((m) => m.source === "model")).toEqual([]);
      env!.cleanup();
      env = null;
    }
    expect(validateTutorOutput(good("m"), { ownSentences: [] }).ok).toBe(true);
    expect(validateTutorOutput(good("m", { uncertainty_note: "english note" }), { ownSentences: [] }).ok).toBe(false);
  }, 240_000);
});

// ---------------------------------------------------------------------------------------------------------------------- agent hand-over
describe("bounded export and the Copy Agent Task text", () => {
  it("a session export is bounded, read-only, marks unconfirmed assessments and escapes markup", async () => {
    const d = await diagEnv({ practice: true });
    env = d.env;
    const evil = makeRevision(env, { content: { schema_version: "exercise-v1", id: randomUUID(), type: "choose_form", target_skill: "articles.definite", prompt_en: "<script>alert(1)</script> ___ `x` & more", payload: { options: [{ id: "a", text: "a" }, { id: "b", text: "b" }], accepted_option_ids: ["a"], multiple: false } } });
    const sessionId = practiseRevisions(env, [evil]);
    const before = JSON.stringify(rows(env.db, "SELECT * FROM attempts"));
    const out = exportSession(env.db, sessionId);
    expect(JSON.stringify(rows(env.db, "SELECT * FROM attempts"))).toBe(before);
    expect(out.markdown).not.toContain("<script>");
    expect(out.markdown).toContain("&lt;script&gt;");
    expect(mdText("a\nb")).toBe("a ⏎ b");
    expect(mdText("x".repeat(5000)).length).toBeLessThan(EXPORT_LIMITS.text + 20);
    const json = out.json as { schema_version: string; slots: Array<{ attempts: unknown[] }>; truncated: boolean };
    expect(json).toMatchObject({ schema_version: "session-export-v1", truncated: false });
    expect(json.slots[0]!.attempts).toHaveLength(1);
    fails(() => exportSession(env!.db, "not-a-uuid"), 400, "BAD_ID");
    fails(() => exportSession(env!.db, "1'; DROP TABLE attempts;--"), 400, "BAD_ID");
    fails(() => exportSession(env!.db, randomUUID()), 404, "SESSION_NOT_FOUND");
    // many slots are cut, and the export says so
    const big = makeSession(env);
    for (let i = 0; i < EXPORT_LIMITS.slots + 5; i++) makeSlot(env, big, evil, i);
    const cutOut = exportSession(env.db, big).json as { slotCount: number; truncated: boolean; slots: unknown[] };
    expect(cutOut).toMatchObject({ truncated: true, slotCount: EXPORT_LIMITS.slots + 5 });
    expect(cutOut.slots).toHaveLength(EXPORT_LIMITS.slots);
  });

  it("an exercise export carries status, hash and reviews but no learner answers; unknown or malformed ids fail", async () => {
    const d = await diagEnv({ practice: true });
    env = d.env;
    const rev = one<{ id: string; h: string }>(env.db, "SELECT id, content_hash AS h FROM exercise_revisions WHERE bank_role = 'practice' LIMIT 1");
    const out = exportExercise(env.db, rev.id);
    expect(out.json).toMatchObject({ schema_version: "exercise-export-v1", revision: { id: rev.id, contentHash: rev.h, status: "approved" } });
    expect((out.json as { reviews: unknown[] }).reviews.length).toBeGreaterThan(0);
    expect(JSON.stringify(out.json)).not.toContain("raw_answer");
    fails(() => exportExercise(env!.db, "../../etc/passwd"), 400, "BAD_ID");
    fails(() => exportExercise(env!.db, randomUUID()), 404, "REVISION_NOT_FOUND");
  });

  it("the agent task is short, names only the ID, a relative spec path and an allowlisted command - and rejects anything else", async () => {
    const { sessionId, slots } = await practised(1);
    const t = agentTask(env!.db, "session", sessionId);
    expect(t).toContain(`npm run lab:export -- session ${sessionId}`);
    expect(t).toContain("content/review-guidelines.md");
    expect(t).not.toMatch(/[A-Za-z]:\\/);
    expect(t.length).toBeLessThan(400);
    const rev = one<{ id: string }>(env!.db, "SELECT exercise_revision_id AS id FROM session_slots WHERE id = ?", slots[0]!.id).id;
    expect(agentTask(env!.db, "exercise", rev)).toContain(`lab:export -- exercise ${rev}`);
    expect(agentTask(env!.db, "coverage")).toContain("lab:export -- coverage");
    fails(() => agentTask(env!.db, "session", "x; rm -rf /"), 400, "BAD_ID");
    fails(() => agentTask(env!.db, "session", randomUUID()), 404, "SESSION_NOT_FOUND");
    fails(() => agentTask(env!.db, "batch", randomUUID()), 404, "BATCH_NOT_FOUND");
  });

  it("the two workflow tasks (D62) are complete instructions with session IDs and allowlisted commands only - no answers, no absolute paths", async () => {
    const { sessionId } = await practised(1);
    for (const kind of ["progress", "lessons"] as const) {
      const t = agentTask(env!.db, kind);
      expect(t).toContain(sessionId);
      expect(t).toContain("content/review-guidelines.md");
      expect(t).toContain("npm run pack -- check");
      if (kind === "progress") {
        expect(t).toContain("npm run pack -- publish");
        expect(t).toContain("DIFFERENT reviewer");
      } else {
        expect(t).toContain("node scripts/content-pack.mjs publish");
        expect(t).toContain("items: []");
        expect(t).toContain("Do not generate exercises");
        expect(t.endsWith("Number of new lessons: 5")).toBe(true);
      }
      expect(t).not.toMatch(/[A-Za-z]:\\/);
      expect(t).not.toContain("raw_answer");
    }
    expect(agentTask(env!.db, "progress")).toContain(`npm run lab:export -- session <id>`);
  });
});

describe("tutor over HTTP", () => {
  it("needs CSRF, answers 202, and serves the thread, the slot list and the agent task text", async () => {
    const { sessionId, slots } = await practised(1);
    const port = await freePort();
    app = await buildApp({ config: testConfig(env!.scratch.root, port), db: env!.db, instanceId: "i", startedAt: "2026-01-01T00:00:00Z", shutdownToken: "t", onShutdown: () => {}, csrfSecret: Buffer.alloc(32, 5), attempts: { now: () => new Date(env!.clock.current), newId: randomUUID } as never });
    const host = `127.0.0.1:${port}`;
    const b = await app.inject({ method: "GET", url: "/api/v1/session", headers: { host } });
    const csrf = SessionBootstrapSchema.parse(b.json()).csrfToken;
    const cookie = String(b.headers["set-cookie"]).split(";")[0]!;
    const call = (method: "POST" | "GET", url: string, body?: unknown, ok = true) => app!.inject({ method, url, payload: body as object, headers: { host, origin: `http://${host}`, cookie, "x-csrf-token": ok ? csrf : "" } });
    expect((await call("POST", "/api/v1/tutor", { sessionId, slotId: slots[0]!.id, kind: "why" }, false)).statusCode).toBe(403);
    const ok = await call("POST", "/api/v1/tutor", { sessionId, slotId: slots[0]!.id, kind: "more_examples" });
    expect(ok.statusCode).toBe(202);
    expect((ok.json() as { jobId: string }).jobId).toBeTruthy();
    expect((await call("POST", "/api/v1/tutor", { sessionId, slotId: slots[0]!.id, kind: "question" })).statusCode).toBe(400);
    const thread = (await call("GET", `/api/v1/tutor/threads/${slots[0]!.id}`)).json() as { messages: unknown[]; pendingJobs: number };
    expect(thread.pendingJobs).toBe(1);
    expect(thread.messages).toHaveLength(2);
    expect(((await call("GET", "/api/v1/tutor/slots")).json() as { slots: Array<{ slotId: string }> }).slots.map((s) => s.slotId)).toContain(slots[0]!.id);
    const attempt = one<{ id: string }>(env!.db, "SELECT id FROM attempts WHERE slot_id = ?", slots[0]!.id);
    const previous = one<{ id: string; sequence: number }>(env!.db, "SELECT id, sequence FROM assessment_revisions WHERE attempt_id = ? ORDER BY sequence DESC LIMIT 1", attempt.id);
    env!.db.prepare("INSERT INTO assessment_revisions(id, attempt_id, sequence, source, verdict, confirmation, criterion_version, supersedes_id, rationale, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(randomUUID(), attempt.id, previous.sequence + 1, "model", "correct", "tentative", "test", previous.id, "draft", "2026-10-31T00:00:00Z");
    const selected = ((await call("GET", "/api/v1/tutor/slots?filter=mistakes")).json() as { slots: Array<{ slotId: string }> }).slots;
    expect(selected.map((s) => s.slotId)).not.toContain(slots[0]!.id);
    expect(((await call("GET", "/api/v1/tutor/slots")).json() as { slots: Array<{ slotId: string; outcome: string }> }).slots.find((s) => s.slotId === slots[0]!.id)?.outcome).toBe("pending");
    expect((await call("GET", `/api/v1/tutor/agent-task?kind=session&id=${sessionId}`)).json()).toMatchObject({ text: expect.stringContaining(sessionId) });
    expect((await call("GET", "/api/v1/tutor/agent-task?kind=session&id=%3Bls")).statusCode).toBe(400);
    expect((await call("GET", "/api/v1/tutor/agent-task?kind=sql&id=1")).statusCode).toBe(400);
  });
});
