import { afterEach, describe, expect, it } from "vitest";
import { WordLessonContentSchema } from "../../../packages/contracts/src/index.js";
import { retryFailed, startGeneration, studioStatus } from "../../../apps/server/src/domain/wordLessons/generate.js";
import { listLessons } from "../../../apps/server/src/domain/wordLessons/runs.js";
import { wordLessonCoverage } from "../../../apps/server/src/domain/wordLessons/selection.js";
import { removeWord } from "../../../apps/server/src/domain/vocabulary/repository.js";
import { deps, generationRunner, goodAnswers, runJob, saveWord, scriptedChat, setup, type Env } from "./fixtures.js";

let env: Env | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});
const tasks = (chat: { calls: Array<{ task: string }> }) => chat.calls.map((c) => c.task).filter((t) => !["pairs", "uses", "keep"].includes(t));
const lessons = (db: Env["db"]) => db.prepare("SELECT id, entry_id AS entryId, status, generation_attempt AS attempt, error_code AS code FROM word_lessons ORDER BY created_at, rowid").all() as Array<{ id: string; entryId: string; status: string; attempt: number; code: string | null }>;

describe("word lesson generation", () => {
  it("counts only words with a translation, defaults to min(10, candidates) and queues one job per lesson", async () => {
    env = await setup();
    const { db } = env;
    saveWord(db, "overlook");
    saveWord(db, "scarce", "дефицитный");
    db.prepare("INSERT INTO vocabulary_entries(id, lemma, pos, language, surface_forms_json, created_at) VALUES ('x1','nameless','unknown','en','[]',?)").run(new Date().toISOString());
    const s = studioStatus(db, new Date());
    expect(s).toMatchObject({ ready: 0, eligible: 2, waitingTranslation: 1, candidates: 2, defaultCount: 2 });
    expect(startGeneration(db, deps, 10).created).toBe(2);
    expect(lessons(db).map((l) => l.status)).toEqual(["generating", "generating"]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE json_extract(payload_json, '$.wordLessonId') IS NOT NULL").get() as { n: number }).n).toBe(2);
    // a second request has nothing left to prepare
    expect(() => startGeneration(db, deps, 5)).toThrow(/Every word/);
  });

  it("stores a lesson only after every stage passed: validated, never approved, and ready counts it", async () => {
    env = await setup();
    const { db } = env;
    const entry = saveWord(db, "overlook");
    startGeneration(db, deps, 1);
    const chat = scriptedChat();
    const { error } = await runJob(db, generationRunner(db, chat), "wordLessonId");
    expect(error).toBeNull();
    const row = db.prepare("SELECT status, content_status AS cs, schema_version AS sv, content_json AS c FROM word_lessons WHERE entry_id = ?").get(entry) as { status: string; cs: string; sv: string; c: string };
    expect(row).toMatchObject({ status: "ready", cs: "validated", sv: "word-lesson-v1" });
    const content = WordLessonContentSchema.parse(JSON.parse(row.c));
    const first = content.stage1.examples[0]!;
    expect(first.en.slice(first.target.start, first.target.start + first.target.length).toLowerCase()).toBe("overlook");
    expect(content.stage2.gapped_en).toContain("___");
    expect(content.stage3.items.length).toBeGreaterThanOrEqual(2);
    expect(tasks(chat)).toEqual(["stage12", "stage3", "stage4", "stage5", "review"]);
    expect(wordLessonCoverage(db).ready).toBe(1);
    // it never reaches the exercise bank, the no-repeat ledger or a practice session
    for (const t of ["exercise_revisions", "prompt_units", "exposures", "prompt_reservations", "vocabulary_sessions", "sessions"]) expect((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n, t).toBe(0);
    expect(listLessons(db, new Date()).lessons.map((l) => l.lemma)).toEqual(["overlook"]);
  });

  it("an interrupted pack keeps the finished lessons; the half-written one is hidden, uncounted and can be retried without duplicates", async () => {
    env = await setup();
    const { db } = env;
    saveWord(db, "overlook");
    saveWord(db, "scarce", "дефицитный");
    startGeneration(db, deps, 2);
    // the scripted sentences are about "overlook": the lesson of "scarce" cannot pass the check for its own word
    const first = await runJob(db, generationRunner(db, scriptedChat()), "wordLessonId");
    const second = await runJob(db, generationRunner(db, scriptedChat()), "wordLessonId");
    expect([first.error === null, second.error === null].sort()).toEqual([false, true]);
    // the failing lesson is written again by itself twice more, then it is shown as failed
    await runJob(db, generationRunner(db, scriptedChat()), "wordLessonId");
    await runJob(db, generationRunner(db, scriptedChat()), "wordLessonId");
    const states = lessons(db);
    expect(states.map((l) => l.status).sort()).toEqual(["failed", "ready"]);
    expect(listLessons(db, new Date()).coverage).toEqual({ ready: 1, eligible: 2 });
    expect(studioStatus(db, new Date())).toMatchObject({ ready: 1, failed: 1, generating: 0, candidates: 0 });
    // retry: the same row gets the next attempt; ready lessons are not touched
    const readyBefore = states.find((l) => l.status === "ready")!;
    expect(retryFailed(db, deps).queued).toBe(1);
    const after = lessons(db);
    expect(after).toHaveLength(2);
    expect(after.find((l) => l.id === readyBefore.id)).toMatchObject({ status: "ready", attempt: 1 });
    expect(after.find((l) => l.status === "generating")).toMatchObject({ attempt: 4 });
    expect(retryFailed(db, deps).queued).toBe(0);
  });

  it("rejects a stage that breaks the rules, asks again, and writes nothing when it cannot be fixed", async () => {
    env = await setup();
    const { db } = env;
    saveWord(db, "overlook");
    startGeneration(db, deps, 1);
    // the hint of stage 4 is not the start of the sentence: invalid every time
    const broken = { ...(goodAnswers().stage4 as object), hint_partial_en: "Something else entirely" };
    const chat = scriptedChat({ stage4: () => broken });
    const { error } = await runJob(db, generationRunner(db, chat), "wordLessonId");
    expect(String((error as Error).message)).toMatch(/stage4/);
    // rejected: the lesson is written again by itself (a new attempt, two more allowed), not shown as failed yet
    expect(lessons(db)[0]).toMatchObject({ status: "generating", attempt: 2 });
    expect(JSON.parse((db.prepare("SELECT payload_json AS p FROM jobs WHERE state = 'queued' AND json_extract(payload_json, '$.wordLessonId') IS NOT NULL").get() as { p: string }).p)).toMatchObject({ attempt: 2, autoLeft: 1 });
    await runJob(db, generationRunner(db, chat), "wordLessonId");
    await runJob(db, generationRunner(db, chat), "wordLessonId");
    expect(lessons(db)[0]).toMatchObject({ status: "failed", attempt: 3, code: "lesson_stage_failed" });
    expect((db.prepare("SELECT content_json AS c FROM word_lessons").get() as { c: string | null }).c).toBeNull();
    expect(chat.calls.filter((c) => c.task === "stage4").length).toBeGreaterThanOrEqual(3);
  });

  it("sends the reviewer's remark back to the stage and accepts the rewritten one", async () => {
    env = await setup();
    const { db } = env;
    saveWord(db, "overlook");
    startGeneration(db, deps, 1);
    let reviews = 0;
    const chat = scriptedChat({ review: () => (reviews++ === 0 ? { problems: [{ id: "b", severity: "error", quote: "overlooked the deadline", problem: "the idea does not match the sentence" }] } : { problems: [] }) });
    const { error } = await runJob(db, generationRunner(db, chat), "wordLessonId");
    expect(error).toBeNull();
    expect(tasks(chat)).toEqual(["stage12", "stage3", "stage4", "stage5", "review", "stage4", "review"]);
    const second = chat.calls.filter((c) => c.task === "stage4")[1]!;
    expect(JSON.parse(second.messages[1]!.content).avoid_problems).toEqual(["b: the idea does not match the sentence"]);
  });

  it("ignores remarks that are only taste, or whose quote is not in the sentence", async () => {
    env = await setup();
    const { db } = env;
    saveWord(db, "overlook");
    startGeneration(db, deps, 1);
    const chat = scriptedChat({ review: () => ({ problems: [{ id: "b", severity: "minor", quote: "overlooked the deadline", problem: "a matter of taste" }, { id: "t1", severity: "error", quote: "words that are not there", problem: "invented" }] }) });
    const { error } = await runJob(db, generationRunner(db, chat), "wordLessonId");
    expect(error).toBeNull();
    expect(tasks(chat)).toEqual(["stage12", "stage3", "stage4", "stage5", "review"]);
  });

  it("a Russian text that does not say what the English says sends the stage back; an unreadable answer of that check is skipped", async () => {
    env = await setup();
    const { db } = env;
    saveWord(db, "overlook");
    startGeneration(db, deps, 1);
    let pairs = 0;
    const chat = scriptedChat({ pairs: () => (pairs++ === 0 ? { pairs: [{ id: "b", same: false, difference: "the Russian is in the past, the English is a conditional" }] } : "garbage") });
    const { error } = await runJob(db, generationRunner(db, chat), "wordLessonId");
    expect(error).toBeNull();
    expect(tasks(chat)).toEqual(["stage12", "stage3", "stage4", "stage5", "review", "stage4", "review"]);
    expect(JSON.parse(chat.calls.filter((c) => c.task === "stage4")[1]!.messages[1]!.content).avoid_problems[0]).toMatch(/^b: the Russian does not say the same/);
  });

  it("never overwrites a ready lesson and hides a lesson whose word was removed", async () => {
    env = await setup();
    const { db } = env;
    const entry = saveWord(db, "overlook");
    startGeneration(db, deps, 1);
    await runJob(db, generationRunner(db, scriptedChat()), "wordLessonId");
    const before = db.prepare("SELECT content_json AS c FROM word_lessons").get();
    expect(() => startGeneration(db, deps, 1)).toThrow();
    expect(() => db.prepare("UPDATE word_lessons SET content_json = '{}'").run()).toThrow(/word_lessons/);
    expect(() => db.prepare("DELETE FROM word_lessons").run()).toThrow(/never deleted/);
    expect(db.prepare("SELECT content_json AS c FROM word_lessons").get()).toEqual(before);
    removeWord(db, deps, entry);
    expect(listLessons(db, new Date())).toEqual({ lessons: [], coverage: { ready: 0, eligible: 0 } });
  });
});
