import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { WordLessonContentSchema, type WordLessonContent, type WordLessonRunState } from "../../../packages/contracts/src/index.js";
import { ApiError } from "../../../apps/server/src/errors.js";
import { startGeneration } from "../../../apps/server/src/domain/wordLessons/generate.js";
import { completeRun, disputeAttempt, giveUpWaiting, listLessons, recordEvent, runState, startRun, submitAttempt } from "../../../apps/server/src/domain/wordLessons/runs.js";
import { upsertModelVersion } from "../../../apps/server/src/domain/attempts/transcripts.js";
import { analysisRunner, deps, generationRunner, goodAnswers, runJob, saveWord, scriptedChat, setup, type Env } from "./fixtures.js";

let env: Env | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

async function readyLesson(): Promise<{ db: Env["db"]; lessonId: string; content: WordLessonContent }> {
  env = await setup();
  const { db } = env;
  saveWord(db, "overlook");
  startGeneration(db, deps, 1);
  const r = await runJob(db, generationRunner(db, scriptedChat()), "wordLessonId");
  expect(r.error).toBeNull();
  const row = db.prepare("SELECT id, content_json AS c FROM word_lessons").get() as { id: string; c: string };
  return { db, lessonId: row.id, content: WordLessonContentSchema.parse(JSON.parse(row.c)) };
}

const fails = (fn: () => unknown, status: number, code: string) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    expect({ status: (e as ApiError).status, code: (e as ApiError).code }).toEqual({ status, code });
    return;
  }
  throw new Error(`expected ${code}`);
};

const ev = (db: Env["db"], runId: string, itemKey: string, kind: Parameters<typeof recordEvent>[3]["kind"]) => recordEvent(db, deps, runId, { id: randomUUID(), itemKey, kind });
const answer = (db: Env["db"], runId: string, itemKey: string, text: string) => submitAttempt(db, deps, runId, { id: randomUUID(), itemKey, text, input: "text" });
const state = (db: Env["db"], runId: string): WordLessonRunState => runState(db, deps, runId, false);
const checkChat = (reply: unknown) => scriptedChat({ check: () => reply });

function expectedOf(c: WordLessonContent, key: string): string {
  return key === "s2" ? c.stage2.accepted_forms[0]! : key === "s4" ? c.stage4.expected_en : key === "s5" ? c.stage5.sample_en : c.stage3.items.find((i) => i.id === key)!.expected_en;
}

/** plays the whole lesson without help, answering every task exactly (stage 5 goes through the model) */
async function perfectRun(db: Env["db"], lessonId: string, content: WordLessonContent): Promise<{ runId: string; score: number }> {
  const { runId } = startRun(db, deps, lessonId, "tab-1");
  ev(db, runId, "s1", "stage_done");
  for (let guard = 0; guard < 10; guard++) {
    const st = state(db, runId);
    if (!st.currentKey) break;
    answer(db, runId, st.currentKey, expectedOf(content, st.currentKey));
    if (st.currentKey === "s5") await runJob(db, analysisRunner(db, checkChat({ verdict: "correct", issues: [], corrected_en: "", comment_ru: "Хорошо." })), "wordLessonAttemptId");
  }
  return { runId, score: completeRun(db, deps, runId).score };
}

describe("word lesson run", () => {
  it("starts at the passive stage, resumes the open run, and keeps the answers out of the state until they are earned", async () => {
    const { db, lessonId, content } = await readyLesson();
    const a = startRun(db, deps, lessonId, "tab-1");
    expect(a.resumed).toBe(false);
    expect(startRun(db, deps, lessonId, "tab-2")).toEqual({ runId: a.runId, resumed: true });
    const st = state(db, a.runId);
    expect(st).toMatchObject({ stage: 1, currentKey: "s1", task: null, status: "active", lemma: "overlook" });
    expect(st.stage1.examples).toHaveLength(3);
    // nothing of the answers is in the state of a fresh run
    const json = JSON.stringify({ ...st, stage1: undefined });
    for (const secret of [content.stage2.full_en, content.stage4.expected_en, content.stage5.sample_en, ...content.stage3.items.map((i) => i.expected_en)]) expect(json).not.toContain(secret);
    // the five stages cannot be skipped or entered out of order
    fails(() => answer(db, a.runId, "s2", "overlook"), 409, "WORD_LESSON_ITEM_NOT_CURRENT");
    fails(() => completeRun(db, deps, a.runId), 409, "WORD_LESSON_NOT_FINISHED");
    ev(db, a.runId, "s1", "stage_done");
    const recall = state(db, a.runId);
    expect(recall).toMatchObject({ stage: 2, currentKey: "s2", lemma: "", task: { stage: 2, key: "s2" } });
    expect(JSON.stringify(recall.task)).not.toContain("overlook");
  });

  it("stage 2 is judged by code: only the form that fits counts, a hint is recorded, and it ends only with the right word", async () => {
    const { db, lessonId } = await readyLesson();
    const { runId } = startRun(db, deps, lessonId, "t");
    ev(db, runId, "s1", "stage_done");
    answer(db, runId, "s2", "overlooked"); // another form of the same word does not fit this sentence
    let item = state(db, runId).items.find((i) => i.key === "s2")!;
    expect(item.attempts[0]).toMatchObject({ verdict: "incorrect", disputable: false });
    expect(item.done).toBe(false);
    expect(item.revealed.word).toBeUndefined();
    fails(() => ev(db, runId, "s2", "continue"), 409, "EVENT_NOT_ALLOWED");
    ev(db, runId, "s2", "hint_word");
    item = state(db, runId).items.find((i) => i.key === "s2")!;
    expect(item.revealed.word).toBe("overlook");
    answer(db, runId, "s2", "  Overlook. ");
    expect(state(db, runId).items.find((i) => i.key === "s2")!.done).toBe(true);
    expect(state(db, runId).stage).toBe(3);
  });

  it("stages 3-4: an approved variant passes at once (case, spaces and the final stop do not matter); a missing word is judged by code", async () => {
    const { db, lessonId, content } = await readyLesson();
    const { runId } = startRun(db, deps, lessonId, "t");
    ev(db, runId, "s1", "stage_done");
    answer(db, runId, "s2", "overlook");
    const first = content.stage3.items[0]!;
    answer(db, runId, "s3.1", "I think nothing was wrong."); // no target word
    let item = state(db, runId).items.find((i) => i.key === "s3.1")!;
    expect(item.attempts[0]).toMatchObject({ verdict: "incorrect", disputable: false, feedback: { correctedEn: first.expected_en } });
    answer(db, runId, "s3.1", `  ${first.expected_en.toLowerCase().replace(/\.$/, "")}  `);
    item = state(db, runId).items.find((i) => i.key === "s3.1")!;
    expect(item.attempts[1]).toMatchObject({ verdict: "correct" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'free_text_analysis'").get()).toEqual({ n: 0 }); // the fast path never asks the model
  });

  it("an answer that is not an approved variant goes to the local model; its remarks and corrected sentence are shown, the learner may try again or continue", async () => {
    const { db, lessonId, content } = await readyLesson();
    const { runId } = startRun(db, deps, lessonId, "t");
    ev(db, runId, "s1", "stage_done");
    answer(db, runId, "s2", "overlook");
    const wrong = "Small details were overlooked by her when she is tired.";
    answer(db, runId, "s3.1", content.stage3.items[0]!.expected_en);
    answer(db, runId, "s3.2", wrong);
    // the answer waits for the model; a second answer or "continue" is refused meanwhile
    expect(state(db, runId).items.find((i) => i.key === "s3.2")!.attempts[0]!.verdict).toBe("pending");
    fails(() => answer(db, runId, "s3.2", wrong), 409, "ATTEMPT_PENDING");
    fails(() => ev(db, runId, "s3.2", "continue"), 409, "CONTINUE_NOT_ALLOWED");
    const chat = checkChat({ verdict: "incorrect", issues: [{ fragment: "were", problem_ru: "Нужно настоящее время: are.", fix_en: "are" }], corrected_en: "Small details are overlooked by her when she is tired.", comment_ru: "Почти." });
    await runJob(db, analysisRunner(db, chat), "wordLessonAttemptId");
    const item = state(db, runId).items.find((i) => i.key === "s3.2")!;
    expect(item.attempts[0]).toMatchObject({ verdict: "incorrect", disputable: true, feedback: { correctedEn: "Small details are overlooked by her when she is tired.", issues: [{ fragment: "were", fixEn: "are" }] } });
    expect(item.revealed.full).toBeUndefined(); // the corrected sentence is in the feedback; the reference is not revealed
    expect(JSON.parse(chat.calls[0]!.messages[1]!.content)).toMatchObject({ stage: 3, learner_answer: wrong, model_answer: content.stage3.items[1]!.expected_en });
    // continue after feedback is a real step, not a skip
    ev(db, runId, "s3.2", "continue");
    expect(state(db, runId).items.find((i) => i.key === "s3.2")!.done).toBe(true);
  });

  it("the learner can disagree with the model; the answer is kept as disputed and the lesson goes on", async () => {
    const { db, lessonId, content } = await readyLesson();
    const { runId } = startRun(db, deps, lessonId, "t");
    ev(db, runId, "s1", "stage_done");
    answer(db, runId, "s2", "overlook");
    const { attemptId } = submitAttempt(db, deps, runId, { id: randomUUID(), itemKey: "s3.1", text: "The crack in the wall was overlooked by the inspector.", input: "text" });
    await runJob(db, analysisRunner(db, checkChat({ verdict: "incorrect", issues: [{ fragment: "The", problem_ru: "Артикль.", fix_en: "A" }], corrected_en: content.stage3.items[0]!.expected_en, comment_ru: "Артикль." })), "wordLessonAttemptId");
    disputeAttempt(db, deps, runId, attemptId, "the crack was mentioned before");
    fails(() => disputeAttempt(db, deps, runId, attemptId, undefined), 409, "ALREADY_DISPUTED");
    const item = state(db, runId).items.find((i) => i.key === "s3.1")!;
    expect(item.attempts[0]).toMatchObject({ verdict: "disputed", disputable: false });
    expect(db.prepare("SELECT COUNT(*) AS n FROM word_lesson_verdicts WHERE attempt_id = ?").get(attemptId)).toEqual({ n: 3 }); // code, model, learner: history is kept
    ev(db, runId, "s3.1", "continue");
    expect(state(db, runId).currentKey).toBe("s3.2");
  });

  it("a model that cannot judge, or is too slow, leaves the answer unresolved: the reference is shown and nobody is stuck", async () => {
    const { db, lessonId, content } = await readyLesson();
    const { runId } = startRun(db, deps, lessonId, "t");
    ev(db, runId, "s1", "stage_done");
    answer(db, runId, "s2", "overlook");
    for (const k of content.stage3.items.map((i) => i.id)) answer(db, runId, k, expectedOf(content, k));
    answer(db, runId, "s4", expectedOf(content, "s4"));
    // stage 5: always the model; garbage twice -> unresolved
    answer(db, runId, "s5", "I overlooked my keys this morning.");
    await runJob(db, analysisRunner(db, checkChat("not json")), "wordLessonAttemptId");
    const s5 = state(db, runId).items.find((i) => i.key === "s5")!;
    expect(s5.attempts[0]!.verdict).toBe("unresolved");
    expect(s5.revealed.full).toBe(content.stage5.sample_en);
    ev(db, runId, "s5", "continue");
    expect(state(db, runId).currentKey).toBeNull();
  });

  it("giving up on a pending check, or a check whose job is gone, makes the answer unresolved", async () => {
    const { db, lessonId, content } = await readyLesson();
    const { runId } = startRun(db, deps, lessonId, "t");
    ev(db, runId, "s1", "stage_done");
    answer(db, runId, "s2", "overlook");
    const a1 = submitAttempt(db, deps, runId, { id: randomUUID(), itemKey: "s3.1", text: "The crack was overlooked by the man in charge.", input: "text" });
    giveUpWaiting(db, deps, runId, a1.attemptId);
    expect(state(db, runId).items.find((i) => i.key === "s3.1")!.attempts[0]).toMatchObject({ verdict: "unresolved" });
    // a late verdict of the model is still saved
    await runJob(db, analysisRunner(db, checkChat({ verdict: "correct", issues: [], corrected_en: "", comment_ru: "Верно." })), "wordLessonAttemptId");
    expect(state(db, runId).items.find((i) => i.key === "s3.1")!.attempts[0]).toMatchObject({ verdict: "correct" });
    // a job that ended without a verdict: the next read settles the answer
    const a2 = submitAttempt(db, deps, runId, { id: randomUUID(), itemKey: "s3.2", text: "Details were overlooked quite often by her.", input: "text" });
    await runJob(db, { run: async () => { throw new Error("model server stopped"); } }, "wordLessonAttemptId");
    expect(state(db, runId).items.find((i) => i.key === "s3.2")!.attempts[0]).toMatchObject({ id: a2.attemptId, verdict: "unresolved" });
    expect(content).toBeTruthy();
  });

  it("scores independence: a clean run is 100, helped and corrected runs are lower, and every run is kept", async () => {
    const { db, lessonId, content } = await readyLesson();
    const clean = await perfectRun(db, lessonId, content);
    expect(clean.score).toBe(100);
    expect(db.prepare("SELECT status, score_version AS v FROM word_lesson_runs WHERE id = ?").get(clean.runId)).toEqual({ status: "completed", v: "word-lesson-score-v1" });
    // a second pass: every hint opened, everything corrected
    const { runId } = startRun(db, deps, lessonId, "tab-2");
    ev(db, runId, "s1", "stage_done");
    ev(db, runId, "s2", "hint_word");
    answer(db, runId, "s2", "overlook");
    for (const item of content.stage3.items) {
      ev(db, runId, item.id, "hint_partial");
      ev(db, runId, item.id, "hint_full");
      answer(db, runId, item.id, item.expected_en);
    }
    ev(db, runId, "s4", "hint_partial");
    ev(db, runId, "s4", "hint_full");
    answer(db, runId, "s4", content.stage4.expected_en);
    ev(db, runId, "s5", "hint_start");
    answer(db, runId, "s5", content.stage5.sample_en);
    await runJob(db, analysisRunner(db, checkChat({ verdict: "correct", issues: [], corrected_en: "", comment_ru: "Хорошо." })), "wordLessonAttemptId");
    const helped = completeRun(db, deps, runId).score;
    expect(helped).toBeLessThan(40);
    expect(helped).toBeGreaterThan(0);
    // the earlier run is unchanged; the list shows the LAST result and counts both
    expect(db.prepare("SELECT score FROM word_lesson_runs WHERE id = ?").get(clean.runId)).toEqual({ score: 100 });
    expect(listLessons(db, new Date()).lessons[0]).toMatchObject({ completedRuns: 2, lastScore: helped, activeRunId: null });
    expect(() => db.prepare("UPDATE word_lesson_runs SET score = 1 WHERE id = ?").run(clean.runId)).toThrow(/never changes/);
    // the same lesson is played again: its content did not change and nothing was generated
    expect(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE json_extract(payload_json, '$.wordLessonId') IS NOT NULL").get()).toEqual({ n: 1 });
    expect(state(db, runId).result?.score).toBe(helped);
    expect(state(db, runId).result?.stages.map((s) => s.stage)).toEqual([1, 2, 3, 4, 5]);
  });

  it("a voice answer keeps only text: what was heard, the confirmed text and whether it was edited", async () => {
    const { db, lessonId } = await readyLesson();
    const { runId } = startRun(db, deps, lessonId, "t");
    ev(db, runId, "s1", "stage_done");
    const stt = upsertModelVersion(db, randomUUID, { tag: "whisper-large-v3", digest: "provider-managed", runtime: "groq", runtimeVersion: "api", parameters: {} });
    const id = randomUUID();
    submitAttempt(db, deps, runId, { id, itemKey: "s2", text: "overlook", input: "voice", voice: { asrText: "over look", sttModelId: stt } });
    expect(db.prepare("SELECT input, asr_text AS heard, edited, answer_text AS text FROM word_lesson_attempts WHERE id = ?").get(id)).toEqual({ input: "voice", heard: "over look", edited: 1, text: "overlook" });
    expect(Object.keys(db.prepare("SELECT * FROM word_lesson_attempts LIMIT 1").get() as object).some((k) => /audio|wav|pcm/i.test(k))).toBe(false);
  });

  it("is idempotent by id and refuses a finished run", async () => {
    const { db, lessonId, content } = await readyLesson();
    const done = await perfectRun(db, lessonId, content);
    expect(completeRun(db, deps, done.runId).score).toBe(done.score);
    expect(db.prepare("SELECT track, amount FROM mode_xp_events WHERE source='wordLesson'").all()).toEqual([{ track: 'vocabulary', amount: 50 }]); // once, however often it is completed
    fails(() => answer(db, done.runId, "s2", "overlook"), 409, "WORD_LESSON_RUN_COMPLETED");
    const { runId } = startRun(db, deps, lessonId, "t");
    const id = randomUUID();
    recordEvent(db, deps, runId, { id, itemKey: "s1", kind: "stage_done" });
    recordEvent(db, deps, runId, { id, itemKey: "s1", kind: "stage_done" });
    fails(() => recordEvent(db, deps, runId, { id, itemKey: "s2", kind: "hint_word" }), 409, "EVENT_ID_CONFLICT");
    expect(db.prepare("SELECT COUNT(*) AS n FROM word_lesson_events WHERE run_id = ?").get(runId)).toEqual({ n: 1 });
    void goodAnswers;
  });
});
