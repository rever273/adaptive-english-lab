import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { SessionBootstrapSchema } from "../../../packages/contracts/src/index.js";
import { buildApp } from "../../../apps/server/src/app.js";
import { runMastery } from "../../../apps/server/src/domain/analytics/runs.js";
import { createDiagnosticBlock } from "../../../apps/server/src/domain/diagnostics/session.js";
import type { ChatClient, ChatResult, CallStats } from "../../../apps/server/src/domain/ai/clients.js";
import { AI_CONFIG_V2 } from "../../../apps/server/src/domain/ai/config.js";
import { getReport } from "../../../apps/server/src/domain/reports/report.js";
import { VocabularyJobRunner } from "../../../apps/server/src/domain/vocabulary/enrichment.js";
import { addWord, getEntry, listWords, lookupWord, patchWord, revisionHistory, vocabularyTotals } from "../../../apps/server/src/domain/vocabulary/repository.js";
import { getJob } from "../../../apps/server/src/queue/jobs.js";
import { GpuScheduler } from "../../../apps/server/src/queue/scheduler.js";
import { ApiError } from "../../../apps/server/src/errors.js";
import { FakeClock, FakeGpu, flush } from "../../fixtures/queue/fakes.js";
import { diagEnv, reveal, seed, diagnosticBank, sessionDeps, slotsOf, answerSlot } from "../diagnostics/fixtures.js";
import { freePort, testConfig } from "../helpers.js";
import { makeEnv, one, rows, type Env } from "../attempts/fixtures.js";

let env: Env | null = null;
let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
  env?.cleanup();
  env = null;
});
const deps = () => ({ now: () => new Date(env!.clock.current), newId: randomUUID });
const fails = (fn: () => unknown, status: number, code: string): ApiError => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).status).toBe(status);
    expect((e as ApiError).code).toBe(code);
    return e as ApiError;
  }
  throw new Error(`expected ${code}`);
};

describe("saving a word", () => {
  it("is immediate and needs no AI: the word is stored, an enrichment job is merely queued, and the same word is the same entry", async () => {
    env = await makeEnv();
    const a = addWord(env.db, deps(), { word: "  Pharmacy " });
    expect(a.created).toBe(true);
    expect(a.entry).toMatchObject({ lemma: "pharmacy", pos: "unknown", learned: false, userRevision: 0, aiPending: true, translation: { text: "", source: null } });
    const job = rows<{ kind: string; state: string; priority: number }>(env.db, "SELECT kind, state, priority FROM jobs");
    expect(job).toEqual([{ kind: "vocabulary_enrichment", state: "queued", priority: 2 }]); // waits; nothing needed it to finish
    const b = addWord(env.db, deps(), { word: "pharmacy", selected: "Pharmacies" });
    expect(b.created).toBe(false);
    expect(b.entry.id).toBe(a.entry.id);
    expect(b.entry.surfaceForms).toEqual(["pharmacies"]);
    expect(one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM vocabulary_entries").n).toBe(1);
    expect(one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM jobs").n).toBe(1); // no second job for the same word
    fails(() => addWord(env!.db, deps(), { word: "" }), 400, "VALIDATION_ERROR");
    for (const bad of ["42", "one two three four five", "rm -rf /", "a/b"]) fails(() => addWord(env!.db, deps(), { word: bad }), 422, "WORD_INVALID");
    fails(() => addWord(env!.db, deps(), { word: "ok", extra: 1 }), 400, "VALIDATION_ERROR");
  });

  it("lookup finds a saved word by its lemma, a regular form, or a form the learner selected", async () => {
    env = await makeEnv();
    addWord(env.db, deps(), { word: "stop" });
    addWord(env.db, deps(), { word: "go", selected: "went" });
    expect(lookupWord(env.db, "Stopped")?.lemma).toBe("stop");
    expect(lookupWord(env.db, "stopping")?.lemma).toBe("stop");
    expect(lookupWord(env.db, "went")?.lemma).toBe("go");
    expect(lookupWord(env.db, "goes")?.lemma).toBe("go");
    expect(lookupWord(env.db, "unknownword")).toBeNull();
    expect(listWords(env.db, { q: "sto" }).words.map((w) => w.lemma)).toEqual(["stop"]);
  });
});

describe("encounters: bank and displayed are different things", () => {
  it("bank counts approved exercises (and new releases); displayed counts what a slot actually showed, once per slot, however it is re-rendered", async () => {
    const x = await diagEnv({ practice: true });
    env = x.env;
    addWord(env.db, deps(), { word: "pharmacy" });
    const before = getEntry(env.db, one<{ id: string }>(env.db, "SELECT id FROM vocabulary_entries").id);
    expect(before.bank).toEqual({ occurrences: 0, revisions: 0 }); // nothing in the bank mentions it yet
    // the diagnostic bank is released LATER: the saved word is counted against it in the release transaction
    seed(env, diagnosticBank());
    const w = getEntry(env.db, before.id);
    expect(w.bank).toEqual({ occurrences: 2, revisions: 1 }); // "...where the nearest pharmacy is?" appears in two accepted answers of ONE exercise
    expect(w.displayed).toEqual({ occurrences: 0, slots: 0 }); // answers are not shown at reveal: still not displayed
    // a diagnostic block: pick a word that one slot really SHOWS in its prompt
    const sess = createDiagnosticBlock(env.db, sessionDeps(env), { purpose: "diagnostic", timezone: "Australia/Brisbane", seed: "v" });
    const slots = slotsOf(env, sess.sessionId);
    const shownSlot = slots.find((s) => s.type === "choose_form" || s.type === "choose_missing_fragment")!;
    const promptWord = (JSON.parse(shownSlot.content_json).prompt_en as string).match(/[A-Za-z]{6,}/)![0].toLowerCase();
    addWord(env.db, deps(), { word: promptWord });
    expect(lookupWord(env.db, promptWord)!.bank.occurrences).toBeGreaterThanOrEqual(1);
    expect(lookupWord(env.db, promptWord)!.displayed.occurrences).toBe(0); // not shown yet
    reveal(env, sess.sessionId, shownSlot);
    const shown = lookupWord(env.db, promptWord)!.displayed;
    expect(shown.slots).toBe(1);
    expect(shown.occurrences).toBeGreaterThanOrEqual(1);
    reveal(env, sess.sessionId, shownSlot); // the page reloads and reveals again (resume): not a new encounter
    expect(lookupWord(env.db, promptWord)!.displayed).toEqual(shown);
    expect(lookupWord(env.db, promptWord)!.lastSeen).toBeTruthy();
    const withLibrary = shownSlot;
    void withLibrary;
    // bank and displayed are separate figures: never one total
    const totals = vocabularyTotals(env.db);
    expect(totals).toMatchObject({ words: 2, displayedOccurrences: shown.occurrences });
    expect(totals.bankOccurrences).toBeGreaterThanOrEqual(w.bank.occurrences);
    const rep = getReport(env.db, deps(), {}).report.metrics.vocabulary;
    expect(rep).toMatchObject({ available: true, words: 2, displayedOccurrences: shown.occurrences, bankOccurrences: totals.bankOccurrences });
    answerSlot(env, sess.sessionId, slots.find((s) => s.slot_id !== shownSlot.slot_id)!);
  });
});

describe("the learner's text is never silently overwritten", () => {
  it("a stale edit is a 409 that shows the current text and changes nothing; the history is append-only", async () => {
    env = await makeEnv();
    const w = addWord(env.db, deps(), { word: "meeting" }).entry;
    const one1 = patchWord(env.db, deps(), w.id, { expectedRevision: 0, translationRu: "собрание", exampleEn: "The meeting starts at nine." });
    expect(one1).toMatchObject({ userRevision: 1, translation: { text: "собрание", source: "user" }, example: { source: "user" } });
    const clash = fails(() => patchWord(env!.db, deps(), w.id, { expectedRevision: 0, translationRu: "встреча" }), 409, "REVISION_CONFLICT");
    expect((clash.details as { currentRevision: number; current: { translation: { text: string } } }).currentRevision).toBe(1);
    expect((clash.details as { current: { translation: { text: string } } }).current.translation.text).toBe("собрание");
    expect(getEntry(env.db, w.id).translation.text).toBe("собрание"); // the losing edit changed nothing
    fails(() => patchWord(env!.db, deps(), w.id, { translationRu: "x" }), 400, "VALIDATION_ERROR"); // an edit must say which version it started from
    fails(() => patchWord(env!.db, deps(), w.id, {}), 400, "VALIDATION_ERROR");
    const two = patchWord(env.db, deps(), w.id, { expectedRevision: 1, collocations: ["hold a meeting", "attend a meeting"] });
    expect(two).toMatchObject({ userRevision: 2, translation: { text: "собрание" }, collocations: { items: ["hold a meeting", "attend a meeting"], source: "user" } }); // untouched fields carry over
    expect(revisionHistory(env.db, w.id).map((r) => [r.revision, r.source, r.status])).toEqual([[1, "user", "approved"], [2, "user", "approved"]]);
    expect(() => env!.db.prepare("UPDATE vocabulary_revisions SET translation_ru = 'x'").run()).toThrow(/append-only/);
    expect(() => env!.db.prepare("DELETE FROM vocabulary_revisions").run()).toThrow(/append-only/);
    expect(() => env!.db.prepare("DELETE FROM vocabulary_entries").run()).toThrow(/never deleted/);
    expect(() => env!.db.prepare("UPDATE vocabulary_entries SET lemma = 'other'").run()).toThrow(/never change/);
    expect(() => env!.db.prepare("UPDATE vocabulary_entries SET user_revision = 0").run()).toThrow(/only grows/);
    expect(() => env!.db.prepare("INSERT INTO vocabulary_revisions(id, entry_id, revision, translation_ru, part_of_speech, example_en, collocations_json, source, status, user_edited, created_at) VALUES ('x', ?, 9, 'a', 'noun', 'b', '[]', 'model', 'approved', 0, 'n')").run(w.id)).toThrow(/CHECK/); // a model can never write an approved revision
  });

  it("learned is a flag: it does not bump the revision, does not need one, and moves no score", async () => {
    const x = await diagEnv({ diagnostic: true });
    env = x.env;
    const sess = createDiagnosticBlock(env.db, sessionDeps(env), { purpose: "diagnostic", timezone: "Australia/Brisbane" });
    for (const s of slotsOf(env, sess.sessionId)) answerSlot(env, sess.sessionId, s);
    const asOf = new Date(env.clock.current.getTime() + 3600_000).toISOString();
    const run = () => runMastery(env!.db, { asOf, cohort: { criterionVersion: "rubric-v1", difficulty: "B2", protocol: "diagnostic-v1" }, taxonomyId: env!.taxonomyId, now: env!.deps.now });
    const before = run();
    const w = addWord(env.db, deps(), { word: "train" }).entry;
    const after = patchWord(env.db, deps(), w.id, { learned: true });
    expect(after).toMatchObject({ learned: true, userRevision: 0 });
    expect(patchWord(env.db, deps(), w.id, { learned: false }).learned).toBe(false);
    expect(run().inputHash).toBe(before.inputHash); // identical inputs: the learned flag is not an input
    expect(one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM mastery_snapshots").n).toBeGreaterThan(0);
  });
});

// -------------------------------------------------------------------------------------------------------------------------- the AI draft
const stats: CallStats = { totalMs: 10, loadMs: null, promptTokens: 5, evalTokens: 5, evalMs: 5 };
class ScriptedChat implements ChatClient {
  calls = 0;
  constructor(public respond: (call: number, entryId: string) => string) {}
  async chat(req: { messages: Array<{ role: string; content: string }> }): Promise<ChatResult> {
    const user = JSON.parse(req.messages[1]!.content) as { entry_id: string };
    return { text: this.respond(++this.calls, user.entry_id), stats };
  }
}
const goodDraft = (entryId: string, o: Record<string, unknown> = {}) => JSON.stringify({ schema_version: "vocabulary-v1", entry_id: entryId, translation_ru: "собрание", part_of_speech: "noun", example_en: "The meeting was moved to Friday.", collocations: ["hold a meeting"], ...o });

async function aiRig(respond: (call: number, entryId: string) => string) {
  env = await makeEnv();
  const clock = new FakeClock();
  const gpu = new FakeGpu(clock);
  const chat = new ScriptedChat(respond);
  const runner = new VocabularyJobRunner({ db: env.db, chat, installedDigest: async () => AI_CONFIG_V2.analysis.digest, runtimeVersion: async () => "test", deps: deps(), sleep: async () => {} });
  await runner.prepare();
  const sched = new GpuScheduler({ db: env.db, newId: randomUUID, clock, telemetry: gpu, control: gpu, runners: [runner], instanceId: "A", config: { admission: "spike", idleUnloadMs: 600_000 } });
  const settle = async (entryId: string) => {
    for (let i = 0; i < 60; i++) {
      await sched.tick();
      await flush();
      await flush();
      const j = env!.db.prepare("SELECT state FROM jobs WHERE idempotency_key LIKE ?").get(`vocab:${entryId}:%`) as { state: string };
      if (["completed", "failed", "cancelled"].includes(j.state)) return j.state;
      clock.advance(1500);
    }
    throw new Error("job never settled");
  };
  return { chat, settle };
}

describe("the AI draft (Qwen through the dispatcher)", () => {
  it("fills a draft translation, POS, example and collocations - labelled as a draft, never touching the entry or a flag", async () => {
    const r = await aiRig((_c, id) => goodDraft(id));
    const w = addWord(env!.db, deps(), { word: "meeting" }).entry;
    expect(await r.settle(w.id)).toBe("completed");
    const v = getEntry(env!.db, w.id);
    expect(v).toMatchObject({ pos: "noun", translation: { text: "собрание", source: "ai_draft" }, example: { source: "ai_draft" }, collocations: { items: ["hold a meeting"], source: "ai_draft" }, aiPending: false, userRevision: 0, learned: false });
    const h = revisionHistory(env!.db, w.id);
    expect(h).toEqual([expect.objectContaining({ revision: 1, source: "model", status: "draft", basedOnUserRev: 0 })]);
    expect(one<{ pos: string }>(env!.db, "SELECT pos FROM vocabulary_entries WHERE id = ?", w.id).pos).toBe("unknown"); // the stored entry was not rewritten by the model
  });

  it("a late AI result never overwrites what the learner wrote in the meantime (concurrent manual edit + job result)", async () => {
    const r = await aiRig((_c, id) => goodDraft(id, { translation_ru: "встреча", example_en: "We had a meeting yesterday." }));
    const w = addWord(env!.db, deps(), { word: "meeting" }).entry;
    // the learner edits BEFORE the model's result arrives
    patchWord(env!.db, deps(), w.id, { expectedRevision: 0, translationRu: "собрание (рабочее)" });
    expect(await r.settle(w.id)).toBe("completed");
    const v = getEntry(env!.db, w.id);
    expect(v.translation).toEqual({ text: "собрание (рабочее)", source: "user" }); // the user's text wins
    expect(v.example).toMatchObject({ text: "We had a meeting yesterday.", source: "ai_draft" }); // the draft only fills what the learner left empty
    expect(v.draftPredatesEdit).toBe(true); // and the page can say "this draft was written before your last edit"
    expect(v.userRevision).toBe(1);
    // and a later edit still has to name the revision it saw
    fails(() => patchWord(env!.db, deps(), w.id, { expectedRevision: 0, translationRu: "x" }), 409, "REVISION_CONFLICT");
    const sources = revisionHistory(env!.db, w.id).map((x) => x.source);
    expect(sources).toEqual(["user", "model"]);
  });

  it("an invalid draft (English translation, no use of the word, unknown POS, wrong entry, prose) is refused: no revision, the word is still saved", async () => {
    for (const bad of [
      (id: string) => goodDraft(id, { translation_ru: "meeting" }),
      (id: string) => goodDraft(id, { example_en: "Something unrelated entirely." }),
      (id: string) => goodDraft(id, { part_of_speech: "whatever" }),
      () => goodDraft("another-entry"),
      () => "Sure! The word means 'собрание'.",
    ]) {
      const r = await aiRig((_c, id) => bad(id));
      const w = addWord(env!.db, deps(), { word: "meeting" }).entry;
      expect(await r.settle(w.id)).toBe("failed");
      expect(revisionHistory(env!.db, w.id)).toEqual([]);
      expect(getEntry(env!.db, w.id)).toMatchObject({ lemma: "meeting", translation: { source: null } });
      env!.cleanup();
      env = null;
    }
  });

  it("with the AI offline the word is saved, listed and editable; the draft simply never arrives", async () => {
    env = await makeEnv(); // no runner, no scheduler at all
    const w = addWord(env.db, deps(), { word: "harbour" }).entry;
    expect(getEntry(env.db, w.id)).toMatchObject({ aiPending: true });
    const e = patchWord(env.db, deps(), w.id, { expectedRevision: 0, translationRu: "гавань", pos: "noun" });
    expect(e).toMatchObject({ pos: "noun", translation: { text: "гавань", source: "user" }, userRevision: 1 });
    expect(listWords(env.db).words.map((x) => x.lemma)).toEqual(["harbour"]);
    expect(getJob(env.db, one<{ id: string }>(env.db, "SELECT id FROM jobs").id)!.state).toBe("queued");
  });
});

describe("vocabulary over HTTP", () => {
  it("saves, searches, looks up and edits with CSRF and optimistic concurrency", async () => {
    env = await makeEnv();
    const port = await freePort();
    app = await buildApp({ config: testConfig(env.scratch.root, port), db: env.db, instanceId: "i", startedAt: "2026-01-01T00:00:00Z", shutdownToken: "t", onShutdown: () => {}, csrfSecret: Buffer.alloc(32, 5), attempts: { now: () => new Date(env!.clock.current), newId: randomUUID } as never });
    const host = `127.0.0.1:${port}`;
    const b = await app.inject({ method: "GET", url: "/api/v1/session", headers: { host } });
    const csrf = SessionBootstrapSchema.parse(b.json()).csrfToken;
    const cookie = String(b.headers["set-cookie"]).split(";")[0]!;
    const call = (method: "POST" | "PATCH" | "GET", url: string, body?: unknown, ok = true) => app!.inject({ method, url, payload: body as object, headers: { host, origin: `http://${host}`, cookie, "x-csrf-token": ok ? csrf : "" } });

    expect((await call("POST", "/api/v1/vocabulary", { word: "ferry" }, false)).statusCode).toBe(403);
    const add = await call("POST", "/api/v1/vocabulary", { word: "Ferry", selected: "ferries" });
    expect(add.statusCode).toBe(201);
    const w = add.json() as { id: string; userRevision: number; created: boolean };
    expect((await call("POST", "/api/v1/vocabulary", { word: "ferry" })).statusCode).toBe(200);
    expect(((await call("GET", "/api/v1/vocabulary?q=fer")).json() as { words: unknown[]; totals: { words: number } }).totals.words).toBe(1);
    expect((await call("GET", "/api/v1/vocabulary/lookup?word=Ferries")).json()).toMatchObject({ known: true });
    expect((await call("GET", "/api/v1/vocabulary/lookup?word=zebra")).json()).toMatchObject({ known: false, entry: null });
    expect((await call("PATCH", `/api/v1/vocabulary/${w.id}`, { expectedRevision: 0, translationRu: "паром" }, false)).statusCode).toBe(403);
    const ok = await call("PATCH", `/api/v1/vocabulary/${w.id}`, { expectedRevision: 0, translationRu: "паром" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ userRevision: 1, translation: { text: "паром", source: "user" } });
    const stale = await call("PATCH", `/api/v1/vocabulary/${w.id}`, { expectedRevision: 0, translationRu: "лодка" });
    expect(stale.statusCode).toBe(409);
    expect((stale.json() as { error: { code: string; details: { currentRevision: number } } }).error).toMatchObject({ code: "REVISION_CONFLICT", details: { currentRevision: 1 } });
    expect((await call("PATCH", `/api/v1/vocabulary/${w.id}`, { learned: true })).json()).toMatchObject({ learned: true, userRevision: 1 });
    const got = (await call("GET", `/api/v1/vocabulary/${w.id}`)).json() as { history: unknown[] };
    expect(got.history).toHaveLength(1);
    expect((await call("GET", "/api/v1/vocabulary/nope")).statusCode).toBe(404);
    expect((await call("GET", "/api/v1/vocabulary/flashcards")).statusCode).toBe(404); // no review schedule, no flashcards
  });
});
