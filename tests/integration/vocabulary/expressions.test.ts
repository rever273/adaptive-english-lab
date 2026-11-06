import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../../apps/server/src/db/migrate.js";
import { openDatabase, type Db } from "../../../apps/server/src/db/open.js";
import type { ChatClient } from "../../../apps/server/src/domain/ai/clients.js";
import { AI_CONFIG_V3 } from "../../../apps/server/src/domain/ai/config.js";
import { GenerationJobRunner } from "../../../apps/server/src/domain/content/batches/generationRunner.js";
import { addExpression, editExpression, expressionsForForms, listExpressions, normalizePhrase, removeExpression, retryExpression } from "../../../apps/server/src/domain/vocabulary/expressions.js";
import { getJob } from "../../../apps/server/src/queue/jobs.js";
import { makeScratchRoot, projectRoot } from "../helpers.js";

const deps = { now: () => new Date(), newId: randomUUID };
let scratch: ReturnType<typeof makeScratchRoot> | null = null;
let db: Db | null = null;
afterEach(() => {
  db?.close();
  db = null;
  scratch?.cleanup();
  scratch = null;
});

async function setup(): Promise<Db> {
  scratch = makeScratchRoot();
  db = openDatabase(path.join(scratch.root, "db", "test.sqlite"));
  await runMigrations(db, { migrationsDir: path.join(projectRoot, "migrations"), appVersion: "test" });
  return db;
}

const stats = { totalMs: 1, loadMs: null, promptTokens: null, evalTokens: null, evalMs: null };
const good = { translation_ru: "суровые погодные условия", example_en: "We had to cancel the trip because of harsh weather conditions.", description_ru: "Устойчивое сочетание: очень плохая погода (холод, ветер, шторм)." };

function runner(d: Db, replies: string[]) {
  const chat: ChatClient = { chat: async () => ({ text: replies.shift() ?? replies[0] ?? "{}", stats }) };
  return new GenerationJobRunner({ db: d, chat, installedDigest: async () => AI_CONFIG_V3.analysis.digest, runtimeVersion: async () => "test", deps, sleep: async () => {} });
}

async function runJobFor(d: Db, r: GenerationJobRunner, expressionId: string) {
  const row = d.prepare("SELECT id FROM jobs WHERE json_extract(payload_json, '$.expressionId') = ? ORDER BY created_at DESC, rowid DESC").get(expressionId) as { id: string };
  const job = getJob(d, row.id)!;
  const out = await r.run({ job: { ...job, payload: job.payload as never }, token: 1, signal: new AbortController().signal, checkpoint: () => {} });
  d.transaction(() => out.alsoCommit?.(d))();
  return out;
}

describe("expressions", () => {
  it("accepts two to eight English words and says clearly what is wrong otherwise", () => {
    expect(normalizePhrase("  Harsh   Weather conditions. ")).toBe("harsh weather conditions");
    expect(() => normalizePhrase("harsh")).toThrow(/Words part/);
    expect(() => normalizePhrase("one two three four five six seven eight nine")).toThrow(/eight/);
    expect(() => normalizePhrase("тяжёлые условия")).toThrow(/English/);
    expect(() => normalizePhrase("it's 2 late")).toThrow(/English/);
  });

  it("saves at once, queues one draft, is idempotent, and the model's draft appears as a blue (model) text", async () => {
    const d = await setup();
    const a = addExpression(d, deps, { phrase: "Harsh weather conditions" });
    expect(a).toMatchObject({ created: true, expression: { phrase: "harsh weather conditions", state: "generating", source: null } });
    expect(addExpression(d, deps, { phrase: "harsh weather conditions" }).created).toBe(false);
    expect((d.prepare("SELECT COUNT(*) AS n FROM jobs WHERE json_extract(payload_json, '$.expressionId') IS NOT NULL").get() as { n: number }).n).toBe(1);

    const r = runner(d, [JSON.stringify(good)]);
    await runJobFor(d, r, a.expression.id);
    expect(listExpressions(d)[0]).toMatchObject({ state: "ready", source: "model", translationRu: good.translation_ru, exampleEn: good.example_en });
    // a second delivery writes nothing
    const again = await runJobFor(d, r, a.expression.id);
    expect((again.output as { skipped?: string }).skipped).toBe("already_written");
    expect((d.prepare("SELECT COUNT(*) AS n FROM vocabulary_expression_revisions").get() as { n: number }).n).toBe(1);
    expect(() => d.prepare("DELETE FROM vocabulary_expression_revisions").run()).toThrow(/append-only/);
  });

  it("refuses an example that does not use the phrase, then offers a retry with a new job", async () => {
    const d = await setup();
    const a = addExpression(d, deps, { phrase: "harsh weather conditions" }).expression;
    const bad = JSON.stringify({ ...good, example_en: "The weather was awful on the day of the trip." });
    await expect(runJobFor(d, runner(d, [bad, bad, bad]), a.id)).rejects.toThrow(/EXAMPLE_WITHOUT_PHRASE/);
    // the failed job is closed: the list says so and Try again queues a fresh one
    d.prepare("UPDATE jobs SET state = 'cancelled', finished_at = ? WHERE json_extract(payload_json, '$.expressionId') = ?").run(new Date().toISOString(), a.id);
    expect(listExpressions(d)[0]!.state).toBe("failed");
    expect(retryExpression(d, deps, a.id).state).toBe("generating");
    await runJobFor(d, runner(d, [JSON.stringify(good)]), a.id);
    expect(listExpressions(d)[0]!.state).toBe("ready");
  });

  it("the learner's own text wins and is a new revision; remove hides it and adding it again brings it back", async () => {
    const d = await setup();
    const a = addExpression(d, deps, { phrase: "make up your mind" }).expression;
    await runJobFor(d, runner(d, [JSON.stringify({ translation_ru: "решиться", example_en: "You need to make up your mind soon.", description_ru: "Принять решение после раздумий." })]), a.id);
    const edited = editExpression(d, deps, a.id, { translationRu: "определиться" });
    expect(edited).toMatchObject({ translationRu: "определиться", source: "user", exampleEn: "You need to make up your mind soon." });
    expect((d.prepare("SELECT COUNT(*) AS n FROM vocabulary_expression_revisions").get() as { n: number }).n).toBe(2);
    removeExpression(d, deps, a.id);
    expect(listExpressions(d)).toHaveLength(0);
    expect(addExpression(d, deps, { phrase: "make up your mind" })).toMatchObject({ created: false, expression: { source: "user" } });
    expect(listExpressions(d)).toHaveLength(1);
  });

  it("finds the saved expressions that contain a word (any listed form), for use when sentences for that word are written", async () => {
    const d = await setup();
    addExpression(d, deps, { phrase: "harsh weather conditions" });
    addExpression(d, deps, { phrase: "take a harsher line" });
    addExpression(d, deps, { phrase: "make up your mind" });
    expect(expressionsForForms(d, ["harsh", "harsher"]).sort()).toEqual(["harsh weather conditions", "take a harsher line"]);
    expect(expressionsForForms(d, ["calm"])).toEqual([]);
  });
});
