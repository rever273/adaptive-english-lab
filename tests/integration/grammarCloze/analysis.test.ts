import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../../apps/server/src/db/migrate.js";
import { openDatabase, type Db } from "../../../apps/server/src/db/open.js";
import type { ChatClient } from "../../../apps/server/src/domain/ai/clients.js";
import { requestAnalysis, runGrammarClozeAnalysis, validateAnalysis, viewOf } from "../../../apps/server/src/domain/grammarCloze/analysis.js";
import { importCleaned } from "../../../apps/server/src/domain/grammarCloze/importer.js";
import { sessionView, startSession, submitAnswer } from "../../../apps/server/src/domain/grammarCloze/repository.js";
import { makeScratchRoot, projectRoot } from "../helpers.js";

const deps = { now: () => new Date(), newId: randomUUID };
let db: Db;
let cleanup: () => void;
beforeEach(async () => {
  const scratch = makeScratchRoot();
  db = openDatabase(path.join(scratch.root, "db", "test.sqlite"));
  cleanup = () => { db.close(); scratch.cleanup(); };
  await runMigrations(db, { migrationsDir: path.join(projectRoot, "migrations"), appVersion: "test" });
  const items = Array.from({ length: 20 }, (_, i) => ({ sourceIndex: i + 1, gappedText: `The book ___ very good number ${i + 1}.`, solution: "that", distractors: ["which", "where"], filledText: `The book that very good number ${i + 1}.`, sourceTopic: "relatives", skillId: "relatives.relative_pronouns", skillConfidence: "exact" as const, status: "validated" as const, flagReasons: [], contentHash: `h${i}` }));
  importCleaned(db, { source: "zanichelli", sourceSha256: "s", cleanVersion: "c", classifierVersion: "k", configSha256: "x", items }, { apply: true });
});
afterEach(() => cleanup());

const good = JSON.stringify({ verdict: "several_correct", options: [{ text: "that", fits: "yes", why_ru: "подходит" }, { text: "which", fits: "yes", why_ru: "тоже подходит" }, { text: "where", fits: "no", why_ru: "не подходит" }], rule_en: "Use that or which for things.", explanation_ru: "Здесь возможны два варианта: that и which.", caution_ru: "" });
const chatReturning = (text: string): ChatClient => ({ chat: async () => ({ text, stats: { totalMs: 1, loadMs: null, promptTokens: null, evalTokens: null, evalMs: null } }) }) as unknown as ChatClient;
const ctxFor = (id: string) => ({ job: { payload: { grammarClozeAnalysisId: id } }, signal: new AbortController().signal }) as never;

describe("Analyse with AI", () => {
  it("is refused before the sentence is answered, queued once afterwards, and never touches answers or statistics", () => {
    const { sessionId } = startSession(db, deps, "t");
    const slot = sessionView(db, sessionId).slots[0]!;
    expect(() => requestAnalysis(db, deps, slot.itemId, sessionId, 1)).toThrow(/Answer the sentence first/);
    submitAnswer(db, deps, sessionId, { id: randomUUID(), position: 1, chosen: slot.options[0]! });
    const before = db.prepare("SELECT * FROM grammar_cloze_attempts").all();
    const a = requestAnalysis(db, deps, slot.itemId, sessionId, 1);
    expect(a.status).toBe("pending");
    expect(requestAnalysis(db, deps, slot.itemId, sessionId, 1).id).toBe(a.id); // one request per revision
    expect((db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='tutor'").get() as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT idempotency_key AS k FROM jobs").get() as { k: string }).k).toBe(`grammar-cloze-analysis:${a.id}`);
    expect(db.prepare("SELECT * FROM grammar_cloze_attempts").all()).toEqual(before);
  });

  it("stores a valid opinion as done", async () => {
    const { sessionId } = startSession(db, deps, "t");
    const slot = sessionView(db, sessionId).slots[0]!;
    submitAnswer(db, deps, sessionId, { id: randomUUID(), position: 1, chosen: slot.options[0]! });
    const a = requestAnalysis(db, deps, slot.itemId, sessionId, 1);
    const out = await runGrammarClozeAnalysis(db, chatReturning(good), ctxFor(a.id));
    out.alsoCommit!(db);
    const v = viewOf(db, a.id);
    expect(v.status).toBe("done");
    expect(v.result?.verdict).toBe("several_correct");
  });

  it("stores an unusable opinion as failed and lets the learner ask again", async () => {
    const { sessionId } = startSession(db, deps, "t");
    const slot = sessionView(db, sessionId).slots[0]!;
    submitAnswer(db, deps, sessionId, { id: randomUUID(), position: 1, chosen: slot.options[0]! });
    const a = requestAnalysis(db, deps, slot.itemId, sessionId, 1);
    const out = await runGrammarClozeAnalysis(db, chatReturning("{\"verdict\":\"key_ok\"}"), ctxFor(a.id));
    out.alsoCommit!(db);
    expect(viewOf(db, a.id)).toMatchObject({ status: "failed", errorCode: "invalid_output", result: null });
    const again = requestAnalysis(db, deps, slot.itemId, sessionId, 1);
    expect(again.id).not.toBe(a.id);
    expect(again.status).toBe("pending");
  });

  it("checks the options and the Russian explanation", () => {
    const opts = ["that", "which", "where"];
    expect(validateAnalysis(good, opts)).not.toBeNull();
    expect(validateAnalysis(good, ["that", "which"])).toBeNull(); // the options must be exactly the exercise's
    expect(validateAnalysis(good.replace("Здесь возможны два варианта: that и which.", "Two options."), opts)).toBeNull(); // Russian required
    expect(validateAnalysis("not json", opts)).toBeNull();
  });
});
