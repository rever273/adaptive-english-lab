import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../../apps/server/src/db/migrate.js";
import { openDatabase, type Db } from "../../../apps/server/src/db/open.js";
import type { ChatClient } from "../../../apps/server/src/domain/ai/clients.js";
import { AUDIT_CHUNK, auditOverview, auditRows, remainingCount, runGrammarClozeAudit, setAuditEnabled, setOverride } from "../../../apps/server/src/domain/grammarCloze/audit.js";
import { importCleaned } from "../../../apps/server/src/domain/grammarCloze/importer.js";
import { completeSession, excludeItem, sessionView, stageView, startSession, submitAnswer } from "../../../apps/server/src/domain/grammarCloze/repository.js";
import { makeScratchRoot, projectRoot } from "../helpers.js";

const deps = { now: () => new Date(), newId: randomUUID };
let db: Db;
let cleanup: () => void;
const N = 24;
beforeEach(async () => {
  const scratch = makeScratchRoot();
  db = openDatabase(path.join(scratch.root, "db", "test.sqlite"));
  cleanup = () => {
    db.close();
    scratch.cleanup();
  };
  await runMigrations(db, { migrationsDir: path.join(projectRoot, "migrations"), appVersion: "test" });
  const topics = ["past_simple", "present_simple", "articles", "modals"];
  const items = Array.from({ length: N }, (_, i) => ({
    sourceIndex: i + 1,
    gappedText: `Tom ___ to school ${i + 1} days ago.`,
    solution: "went",
    distractors: ["goes", "has gone"],
    filledText: `Tom went to school ${i + 1} days ago.`,
    sourceTopic: topics[i % 4]!,
    skillId: null,
    skillConfidence: "general" as const,
    status: "validated" as const,
    flagReasons: [],
    contentHash: `h${i}`,
  }));
  importCleaned(db, { source: "zanichelli", sourceSha256: "s", cleanVersion: "c", classifierVersion: "k", configSha256: "x", items }, { apply: true });
});
afterEach(() => cleanup());

/** a model that calls every third sentence ambiguous */
let calls = 0;
const chat: ChatClient = {
  chat: async () => {
    calls++;
    const bad = calls % 3 === 0;
    return {
      text: JSON.stringify({ verdict: bad ? "several_correct" : "key_ok", other_correct: bad ? ["has gone"] : [], reason_ru: "ago — законченное прошлое → Past Simple", cues: ["days ago"], names: ["Tom"] }),
      stats: { totalMs: 1, loadMs: null, promptTokens: null, evalTokens: null, evalMs: null },
    };
  },
} as unknown as ChatClient;

const openJobs = () => db.prepare("SELECT id, checkpoint_json AS cp FROM jobs WHERE kind = 'tutor' AND json_extract(payload_json, '$.grammarClozeAudit') = 1 AND state IN ('queued','waiting_for_gpu','running','paused')").all() as Array<{ id: string; cp: string }>;
async function runChunk(): Promise<void> {
  const job = openJobs()[0]!;
  let cp: unknown = JSON.parse(job.cp);
  const ctx = { job: { id: job.id, payload: { grammarClozeAudit: 1 }, checkpoint: cp }, token: 1, signal: new AbortController().signal, checkpoint: (c: unknown) => (cp = c) } as never;
  const out = await runGrammarClozeAudit(db, chat, ctx, null);
  db.transaction(() => {
    if ((db.prepare("SELECT state FROM jobs WHERE id = ?").get(job.id) as { state: string }).state === "paused") db.prepare("UPDATE jobs SET state = 'queued' WHERE id = ?").run(job.id);
    db.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(job.id);
    db.prepare("UPDATE jobs SET state = 'completed', finished_at = ? WHERE id = ?").run(new Date().toISOString(), job.id);
    out.alsoCommit!(db);
  })();
}

describe("Grammar Cloze background check", () => {
  beforeEach(() => (calls = 0));

  it("is off until started, checks in chunks, chains the next chunk and stops when paused", async () => {
    expect(auditOverview(db)).toMatchObject({ enabled: false, job: null, total: N, checked: 0, remaining: N });
    setAuditEnabled(db, deps, true);
    expect(openJobs()).toHaveLength(1);
    await runChunk();
    let o = auditOverview(db);
    expect(o.checked).toBe(AUDIT_CHUNK);
    expect(o.byVerdict.several_correct).toBe(3);
    expect(o.hidden).toBe(3);
    expect(openJobs()).toHaveLength(1); // the next chunk
    setAuditEnabled(db, deps, false);
    await runChunk(); // a paused chain that is resumed later asks nothing while switched off
    o = auditOverview(db);
    expect(o.checked).toBe(AUDIT_CHUNK);
    expect(openJobs()).toHaveLength(0);
  });

  it("hides doubtful sentences from new sessions and from the stage pool, keeps the reason, and lets the learner restore one", async () => {
    setAuditEnabled(db, deps, true);
    while (openJobs().length > 0) await runChunk();
    expect(auditOverview(db)).toMatchObject({ checked: N, hidden: 8, remaining: 0 });
    expect(stageView(db, 1).total).toBe(N - 8);
    expect(stageView(db, 1).hiddenByCheck).toBe(8);
    const rows = auditRows(db, { limit: 50, offset: 0 });
    expect(rows).toHaveLength(8);
    expect(rows[0]).toMatchObject({ verdict: "several_correct", otherCorrect: ["has gone"], hidden: true, override: null });
    const hiddenIds = new Set(rows.map((r) => r.itemId));
    const { sessionId } = startSession(db, deps, "t");
    const v = sessionView(db, sessionId);
    expect(v.slots.some((s) => hiddenIds.has(s.itemId))).toBe(false);
    // cues and names before the answer; the reason only after it
    expect(v.slots[0]).toMatchObject({ cues: ["days ago"], names: ["Tom"] });
    expect(v.slots[0]!.reasonRu).toBeUndefined();
    submitAnswer(db, deps, sessionId, { id: randomUUID(), position: 1, chosen: "went", hintLevel: 1 });
    const after = sessionView(db, sessionId).slots[0]!;
    expect(after).toMatchObject({ state: "correct", hintLevel: 1, reasonRu: "ago — законченное прошлое → Past Simple" });
    // a hinted correct answer earns half the XP and stays correct
    expect(db.prepare("SELECT amount FROM mode_xp_events").all()).toEqual([{ amount: 5 }]);
    expect(setOverride(db, deps, rows[0]!.itemId, "restore")).toEqual({ hidden: false });
    expect(auditOverview(db)).toMatchObject({ hidden: 7, restored: 1 });
    expect(setOverride(db, deps, rows[0]!.itemId, "hide")).toEqual({ hidden: true });
    // the model's opinion itself is never changed
    expect(() => db.prepare("UPDATE grammar_cloze_ai_analyses SET result_json = '{}'").run()).toThrow(/never changes/);
    expect(() => db.prepare("DELETE FROM grammar_cloze_audit_overrides").run()).toThrow(/append-only/);
    expect(db.prepare("SELECT hint_level AS h FROM grammar_cloze_attempts").all()).toEqual([{ h: 1 }]);
    expect(() => db.prepare("UPDATE grammar_cloze_sessions SET plan_json = '{}'").run()).toThrow(/plan is fixed/);
  });

  it("records a sentence that breaks the model call as unreadable instead of looping, and stops when the model fails twice", async () => {
    setAuditEnabled(db, deps, true);
    const job = openJobs()[0]!;
    let n = 0;
    const flaky = { chat: async () => { n++; if (n === 1 || n >= 3) throw new Error("HTTP 500"); return { text: "{}" }; } } as unknown as ChatClient;
    let cp: unknown = {};
    const ctx = { job: { id: job.id, payload: { grammarClozeAudit: 1 }, checkpoint: {} }, token: 1, signal: new AbortController().signal, checkpoint: (c: unknown) => (cp = c) } as never;
    await expect(runGrammarClozeAudit(db, flaky, ctx, null)).rejects.toThrow(/failed twice/);
    expect((cp as { results: unknown[] }).results).toHaveLength(3); // kept in the checkpoint for the retry
  });

  it("lists a sentence hidden by the full analysis, so it can be restored", () => {
    const item = db.prepare("SELECT id, current_revision_id AS rev FROM grammar_cloze_items LIMIT 1").get() as { id: string; rev: string };
    db.prepare("INSERT INTO grammar_cloze_ai_analyses(id, revision_id, prompt_version, status, result_json, created_at, finished_at) VALUES (?,?,?,?,?,?,?)").run(
      randomUUID(), item.rev, "grammar-cloze-analysis-v2", "done",
      JSON.stringify({ analysis: { verdict: "several_correct", options: [{ text: "went", fits: "yes", why_ru: "да" }, { text: "has gone", fits: "yes", why_ru: "да" }], rule_en: "r", explanation_ru: "текст", caution_ru: "оба подходят" } }),
      new Date().toISOString(), new Date().toISOString());
    const rows = auditRows(db, { limit: 50, offset: 0 });
    expect(rows).toEqual([expect.objectContaining({ itemId: item.id, verdict: "several_correct", otherCorrect: ["has gone"], reasonRu: "оба подходят", hidden: true })]);
    expect(setOverride(db, deps, item.id, "restore")).toEqual({ hidden: false });
  });

  it("does not carry a wrong answer to Stage 2 when the sentence is later found doubtful", async () => {
    const { sessionId } = startSession(db, deps, "t");
    const view = sessionView(db, sessionId);
    for (const s of view.slots) submitAnswer(db, deps, sessionId, { id: randomUUID(), position: s.position, chosen: "goes" });
    completeSession(db, deps, sessionId);
    const carried = stageView(db, 1).carriedToNext;
    expect(carried).toBe(view.slots.length);
    setOverride(db, deps, view.slots[0]!.itemId, "hide");
    expect(stageView(db, 1).carriedToNext).toBe(carried - 1);
    expect(stageView(db, 1).processed).toBe(view.slots.length - 1); // the hidden sentence leaves the stage count, its answer stays in the history
    expect(db.prepare("SELECT COUNT(*) AS n FROM grammar_cloze_attempts").get()).toEqual({ n: view.slots.length });
    // the two screens count the same pool: stage total = audit total - hidden sentences that were never answered
    const o = auditOverview(db);
    const st = stageView(db, 1);
    expect(o.hidden).toBe(1);
    expect(o.hiddenAnswered).toBe(1);
    expect(st.hiddenByCheck).toBe(o.hidden);
    expect(st.total).toBe(o.total - st.hiddenByCheck);
    // a sentence excluded after its answer stays in both counts
    excludeItem(db, deps, view.slots[1]!.itemId, { sessionId });
    expect(auditOverview(db).total - stageView(db, 1).hiddenByCheck).toBe(stageView(db, 1).total);
  });
  it("asks an unreadable sentence again only after two hours, and gives up after five tries", () => {
    setAuditEnabled(db, deps, true);
    const rev = (db.prepare("SELECT current_revision_id AS r FROM grammar_cloze_items LIMIT 1").get() as { r: string }).r;
    const fail = (at: Date) => db.prepare("INSERT INTO grammar_cloze_ai_analyses(id, revision_id, prompt_version, status, error_code, created_at, finished_at) VALUES (?,?,?,?,?,?,?)").run(randomUUID(), rev, "grammar-cloze-audit-v1", "failed", "invalid_output", at.toISOString(), at.toISOString());
    expect(remainingCount(db)).toBe(N);
    fail(new Date(Date.now() - 3 * 3600_000));
    expect(remainingCount(db)).toBe(N); // failed three hours ago: asked again
    fail(new Date());
    expect(remainingCount(db)).toBe(N - 1); // failed just now: wait
    for (let k = 0; k < 3; k++) fail(new Date(Date.now() - 5 * 3600_000));
    expect(remainingCount(db)).toBe(N - 1); // five tries in all: given up for good
  });
});
