import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../../apps/server/src/db/migrate.js";
import { openDatabase, type Db } from "../../../apps/server/src/db/open.js";
import type { TtsClient } from "../../../apps/server/src/adapters/tts/piper.js";
import type { ChatClient } from "../../../apps/server/src/domain/ai/clients.js";
import type { DictationAsr } from "../../../apps/server/src/domain/typing/dictation/asr.js";
import { buildItems, createLesson, dictationOverview, prepareTracks, revealAnswer, dictationState, exerciseAudio, openTranslation, recordPlay, recordTime, requestHint, retryLesson, startLesson, submitAnswer, type DictationEnv } from "../../../apps/server/src/domain/typing/dictation/lessons.js";
import { buildDictationResult } from "../../../apps/server/src/domain/typing/dictation/result.js";
import { dictationAnalytics } from "../../../apps/server/src/domain/typing/dictation/analytics.js";
import { runDictationJob, type DictationJobPayload, type DictationPayload } from "../../../apps/server/src/domain/typing/dictation/runner.js";
import { tokenize } from "../../../apps/server/src/domain/typing/dictation/check.js";
import { VoiceService } from "../../../apps/server/src/domain/voices/service.js";
import { addWord } from "../../../apps/server/src/domain/vocabulary/repository.js";
import { typingProgress } from "../../../apps/server/src/domain/typing/xp.js";
import { enqueue, getJob, type Job } from "../../../apps/server/src/queue/jobs.js";
import { makeScratchRoot, projectRoot } from "../helpers.js";

const deps = { now: () => new Date(), newId: randomUUID };
const ru = "Это придуманное предложение для проверки.";
const SENTENCES = [
  "The old bakery on the corner sells fresh bread every single morning.",
  "My cousin finally bought a bright orange bicycle for the summer.",
  "Nobody noticed the tiny robot hiding behind the large green curtain.",
  "We watched a quiet film about a lighthouse keeper last weekend.",
  "The teacher asked everyone to bring a favourite book to class.",
  "A friendly neighbour left some warm biscuits on our front step.",
  "Most mornings I walk along the river before the shops open.",
  "The band practised their loudest song in the empty warehouse.",
  "Our new neighbours planted tomatoes along the sunny fence.",
  "She kept her old camera in a drawer beside the window.",
  "The crane operator waved at us from high above the street.",
  "I forgot my umbrella again and walked home in the rain.",
  "He fixed the broken gate with a few nails and some wire.",
  "The little shop near the station closes quite early on Sundays.",
  "A cold wind swept across the empty car park after lunch.",
  "They painted the whole fence white before the weekend arrived.",
];

let scratch: ReturnType<typeof makeScratchRoot> | null = null;
let db: Db | null = null;
afterEach(() => {
  db?.close();
  db = null;
  scratch?.cleanup();
  scratch = null;
});

function wav(words: number): Buffer {
  const rate = 22050;
  const n = Math.round(rate * 0.4 * words);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVEfmt ", 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(8000 * Math.sin(i / 8)), 44 + i * 2);
  return buf;
}

interface Fakes {
  env: DictationEnv;
  state: { queue: string[]; asrReply: (text: string, call: number) => string; asrCalls: number; ttsVoices: number[] };
  chat: ChatClient;
}

async function setup(count = 5): Promise<{ db: Db; f: Fakes }> {
  scratch = makeScratchRoot();
  db = openDatabase(path.join(scratch.root, "db", "test.sqlite"));
  await runMigrations(db, { migrationsDir: path.join(projectRoot, "migrations"), appVersion: "test" });
  db.prepare("INSERT INTO settings_revisions(id, revision, values_json, created_at) SELECT ?, MAX(revision)+1, json_set(values_json, '$.typingDictationExercisesPerLesson', ?), ? FROM settings_revisions").run(randomUUID(), count, new Date().toISOString());
  const state: Fakes["state"] = { queue: [...SENTENCES], asrReply: (t) => t, asrCalls: 0, ttsVoices: [] };
  let currentText = "";
  const tts: TtsClient = {
    available: () => ({ ok: true, modelSha256: "a".repeat(64) }),
    synthesize: async ({ text, speakerId }) => {
      currentText = text;
      state.ttsVoices.push(speakerId);
      return wav(text.split(/\s+/).length);
    },
    stop: async () => {},
  };
  const asr: DictationAsr = { available: () => true, transcribe: async () => ({ text: state.asrReply(currentText, ++state.asrCalls), model: "fake-large-v3" }), stop: async () => {} };
  const chat: ChatClient = {
    chat: async () => ({ text: JSON.stringify({ text_en: state.queue.shift() ?? "Nothing left to say here, said the very quiet robot.", translation_ru: ru }), stats: { totalMs: 1, loadMs: null, promptTokens: null, evalTokens: null, evalMs: null } }),
  };
  const env: DictationEnv = { tts, asr, voices: new VoiceService(), topics: [{ name: "Space exploration", group: "space" }, { name: "Thriller films", group: "film" }, { name: "Software debugging", group: "tech" }, { name: "Coffee culture", group: "food" }], audioDir: path.join(scratch.root, "audio") };
  return { db, f: { env, state, chat } };
}

async function runJob(d: Db, f: Fakes, payload: DictationJobPayload) {
  const key = `test:${randomUUID()}`;
  const job = enqueue(d, deps, { kind: "generation", payload, idempotencyKey: key, priority: 3 }).job;
  const out = await runDictationJob({ job: { ...job, payload }, token: 1, signal: new AbortController().signal, checkpoint: () => {} }, {
    db: d, chat: f.chat, model: { tag: "gemma4:12b", digest: "x" }, params: { numCtx: 8192, temperature: 0.6, seed: 42 }, env: f.env, deps, assertModel: async () => {}, sleep: async () => {},
  });
  d.transaction(() => out.alsoCommit?.(d))();
  return out;
}

const allJobs = async (d: Db, f: Fakes, lessonId: string, attempt = 1, ordinals?: number[]) => {
  const n = (d.prepare("SELECT exercise_count AS n FROM typing_dictation_lessons WHERE id = ?").get(lessonId) as { n: number }).n;
  for (const o of ordinals ?? Array.from({ length: n }, (_, i) => i)) await runJob(d, f, { dictationLessonId: lessonId, ordinal: o, attempt });
};

describe("audio dictation", () => {
  it("creates one lesson idempotently, queues one job per sentence and becomes ready with the last job", async () => {
    const { db: d, f } = await setup();
    const a = createLesson(d, deps, f.env);
    const b = createLesson(d, deps, f.env);
    expect(b.id).toBe(a.id);
    expect(a).toMatchObject({ level: 1, status: "generating", ready: 0, total: 5, started: false });
    expect((d.prepare("SELECT COUNT(*) AS n FROM jobs WHERE json_extract(payload_json,'$.dictationLessonId') = ?").get(a.id) as { n: number }).n).toBe(5);
    await allJobs(d, f, a.id, 1, [0, 1, 2, 3]);
    expect(dictationOverview(d, f.env).lesson).toMatchObject({ ready: 4, status: "generating" });
    expect(() => startLesson(d, deps, f.env, a.id)).toThrow(/not ready/);
    await allJobs(d, f, a.id, 1, [4]);
    expect(dictationOverview(d, f.env).lesson).toMatchObject({ ready: 5, status: "ready" });
    const rows = d.prepare("SELECT status, asr_model, voice_name, source FROM typing_dictation_exercises").all() as Array<Record<string, string>>;
    expect(rows.every((r) => r.status === "validated" && r.asr_model === "fake-large-v3" && r.source === "tts")).toBe(true);
    expect(() => d.prepare("UPDATE typing_dictation_exercises SET text_en = 'x'").run()).toThrow(/immutable/);
  });

  it("the speech check writing '10' for the spoken 'ten' is not a mismatch (D127), and the plan records how the voices were weighted", async () => {
    const { db: d, f } = await setup();
    const lesson = createLesson(d, deps, f.env);
    f.state.queue = ["She has lived in Brisbane for almost ten years now."];
    f.state.asrReply = (t) => t.replace("ten", "10");
    const out = await runJob(d, f, { dictationLessonId: lesson.id, ordinal: 0, attempt: 1 });
    expect((out.metrics as { rejected: unknown[] }).rejected).toEqual([]);
    expect(f.state.ttsVoices).toHaveLength(1);
    expect(d.prepare("SELECT outcome FROM tts_voice_checks").all()).toEqual([{ outcome: "ok" }]);
    const plan = JSON.parse((d.prepare("SELECT plan_json FROM typing_dictation_lessons WHERE id = ?").get(lesson.id) as { plan_json: string }).plan_json) as { voicesVersion: number; voiceWeights: Record<string, number> };
    expect(plan.voicesVersion).toBe(1);
    expect(Object.keys(plan.voiceWeights)).toHaveLength(10);
    expect(plan.voiceWeights.banjo).toBeGreaterThan(plan.voiceWeights.clancy!);
  });

  it("an ASR mismatch tries another voice; two mismatches drop the sentence for a new one; the recorded voice is the real one", async () => {
    const { db: d, f } = await setup();
    const lesson = createLesson(d, deps, f.env);
    // first voice misheard, second voice fine
    f.state.asrReply = (t, call) => (call === 1 ? "something else entirely" : t);
    await runJob(d, f, { dictationLessonId: lesson.id, ordinal: 0, attempt: 1 });
    const ex = d.prepare("SELECT voice_id, voice_name FROM typing_dictation_exercises WHERE ordinal = 0").get() as { voice_id: number };
    expect(f.state.ttsVoices).toHaveLength(2);
    expect(ex.voice_id).toBe(f.state.ttsVoices[1]);
    // every voiced attempt is counted for the voice statistics: the misheard one and the one that was heard back
    const checks = d.prepare("SELECT CAST(replace(voice_key, 'piper:en_AU-librivox-medium:', '') AS INTEGER) AS v, outcome AS o FROM tts_voice_checks ORDER BY rowid").all() as Array<{ v: number; o: string }>;
    expect(checks).toEqual(expect.arrayContaining([{ v: f.state.ttsVoices[0], o: "asr_mismatch" }, { v: f.state.ttsVoices[1], o: "ok" }]));
    expect(() => d.prepare("DELETE FROM tts_voice_checks").run()).toThrow(/append-only/);
    expect(f.state.ttsVoices[0]).not.toBe(f.state.ttsVoices[1]);
    // both voices misheard: the next sentence is written
    const before = f.state.asrCalls;
    f.state.asrReply = (t, call) => (call - before <= 2 ? "wrong" : t);
    const out = await runJob(d, f, { dictationLessonId: lesson.id, ordinal: 1, attempt: 1 });
    expect((out.metrics as { rejected: Array<{ code: string }> }).rejected.map((r) => r.code)).toEqual(["ASR_MISMATCH", "ASR_MISMATCH", "SENTENCE_DROPPED"]);
    expect((d.prepare("SELECT COUNT(*) AS n FROM typing_dictation_exercises").get() as { n: number }).n).toBe(2);
  });

  it("refuses a repeated sentence, a delivered-twice job writes nothing new, and a failing lesson is failed then retried only for what is missing", async () => {
    const { db: d, f } = await setup();
    const lesson = createLesson(d, deps, f.env);
    await runJob(d, f, { dictationLessonId: lesson.id, ordinal: 0, attempt: 1 });
    f.state.queue.unshift(SENTENCES[0]!.replace(".", "!")); // same sentence again: DUPLICATE, then the next one is used
    const out = await runJob(d, f, { dictationLessonId: lesson.id, ordinal: 1, attempt: 1 });
    expect((out.metrics as { rejected: Array<{ code: string }> }).rejected[0]?.code).toBe("DUPLICATE");
    const again = await runJob(d, f, { dictationLessonId: lesson.id, ordinal: 0, attempt: 1 });
    expect((again.output as { skipped?: string }).skipped).toBe("already_done");

    // the remaining jobs end for good: effective status failed, exercises 0 and 1 intact
    d.prepare("UPDATE jobs SET state = 'cancelled', finished_at = ? WHERE json_extract(payload_json,'$.dictationLessonId') = ? AND state = 'queued'").run(new Date().toISOString(), lesson.id);
    expect(dictationOverview(d, f.env).lesson?.status).toBe("failed");
    const retried = retryLesson(d, deps, f.env, lesson.id);
    expect(retried.status).toBe("generating");
    const fresh = d.prepare("SELECT json_extract(payload_json,'$.ordinal') AS o FROM jobs WHERE json_extract(payload_json,'$.attempt') = 2 ORDER BY 1").all() as Array<{ o: number }>;
    expect(fresh.map((r) => r.o)).toEqual([2, 3, 4]);
    expect(() => retryLesson(d, deps, f.env, lesson.id)).toThrow(/Only a lesson/);
  });

  it("hints follow the position without a limit, answers are credited by mistakes, F5 gives no credit, and the result adds up", async () => {
    const { db: d, f } = await setup();
    const lesson = createLesson(d, deps, f.env);
    await allJobs(d, f, lesson.id);
    const state0 = startLesson(d, deps, f.env, lesson.id);
    expect(state0.currentOrdinal).toBe(0);
    const ids = state0.exercises.map((e) => e.id);
    const texts = state0.exercises.map((e) => e.textEn);
    const n = (i: number) => tokenize(texts[i]!).length;
    expect(state0.exercises[0]!.words.every((w) => w.text === null)).toBe(true);

    // not the current sentence; no result yet
    expect(() => submitAnswer(d, deps, ids[1]!, { attemptId: randomUUID(), text: texts[1]!, activeMs: 10 })).toThrow(/current/);
    expect(() => buildDictationResult(d, lesson.id)).toThrow(/every sentence/);

    // a hint on a complete answer is not spent (and the missing final full stop is no mistake)
    expect(requestHint(d, deps, ids[0]!, texts[0]!.replace(/\.$/, ""))).toMatchObject({ applied: false, hintLevel: 0 });
    // a hint shows everything up to the first word that is wrong, and keeps what was shown
    const words0 = texts[0]!.split(" ");
    const h1 = requestHint(d, deps, ids[0]!, words0.slice(0, 2).join(" "));
    expect(h1).toMatchObject({ applied: true, hintLevel: 1 });
    expect(h1.words.filter((w) => w.text !== null).map((w) => w.index)).toEqual([0, 1, 2]);
    // the same spot again shows nothing new and costs nothing
    expect(requestHint(d, deps, ids[0]!, words0.slice(0, 2).join(" ")).applied).toBe(false);
    expect(dictationState(d, lesson.id).exercises[0]!.words.filter((w) => w.text !== null)).toHaveLength(3);

    // a wrong answer with exactly one wrong word: no XP yet, and the hint points at that word (everything before it comes with it)
    const wrongWords = [...words0];
    wrongWords[3] = "zebra";
    const wrong = submitAnswer(d, deps, ids[0]!, { attemptId: randomUUID(), text: wrongWords.join(" "), activeMs: 5000 });
    expect(wrong).toMatchObject({ correct: false, xpAwarded: 0, nextOrdinal: 0 });
    expect(wrong.words.filter((w) => w.text !== null).map((w) => w.index)).toEqual([0, 1, 2, 3]);
    // then the right answer: credit = 1 - (1 wrong word + half a word for the one hint I asked for) / words
    const id = randomUUID();
    const right = submitAnswer(d, deps, ids[0]!, { attemptId: id, text: texts[0]!.toLowerCase().replace(/\.$/, ""), activeMs: 9000, typingMs: 12000, keystrokes: 60 });
    const c0 = Math.round((1 - 1.5 / n(0)) * 100) / 100;
    expect(right).toMatchObject({ correct: true, xpAwarded: Math.round(6 * c0), nextOrdinal: 1 });
    expect(submitAnswer(d, deps, ids[0]!, { attemptId: id, text: texts[0]!, activeMs: 9000 })).toEqual(right);
    expect((d.prepare("SELECT COUNT(*) AS n FROM typing_dictation_attempts").get() as { n: number }).n).toBe(2);
    expect(() => submitAnswer(d, deps, ids[0]!, { attemptId: randomUUID(), text: texts[0]!, activeMs: 9000 })).toThrow(/current/);

    // 2: clean = 6 XP; 3: only the translation = half; 4: many hints (no limit), then F5 = no credit; 5: clean and the lesson completes
    expect(submitAnswer(d, deps, ids[1]!, { attemptId: randomUUID(), text: texts[1]!, activeMs: 10000 }).xpAwarded).toBe(6);
    openTranslation(d, deps, ids[2]!);
    expect(openTranslation(d, deps, ids[2]!).translationRu).toBe(ru);
    expect((d.prepare("SELECT COUNT(*) AS n FROM typing_dictation_events WHERE kind='translation'").get() as { n: number }).n).toBe(1);
    expect(submitAnswer(d, deps, ids[2]!, { attemptId: randomUUID(), text: texts[2]!, activeMs: 11000 }).xpAwarded).toBe(3);
    const words3 = texts[3]!.split(" ");
    for (let k = 0; k < 5; k++) expect(requestHint(d, deps, ids[3]!, words3.slice(0, k).join(" ")).applied).toBe(true); // more than three hints
    const shown = revealAnswer(d, deps, ids[3]!);
    expect(shown.applied).toBe(true);
    expect(shown.words.every((w) => w.text !== null)).toBe(true);
    expect(revealAnswer(d, deps, ids[3]!).applied).toBe(false);
    expect(submitAnswer(d, deps, ids[3]!, { attemptId: randomUUID(), text: texts[3]!, activeMs: 12000 }).xpAwarded).toBe(0);
    expect((d.prepare("SELECT COUNT(*) AS n FROM typing_dictation_xp_events").get() as { n: number }).n).toBe(3);
    recordPlay(d, deps, ids[4]!, "auto");
    recordPlay(d, deps, ids[4]!, "manual");
    const last = submitAnswer(d, deps, ids[4]!, { attemptId: randomUUID(), text: texts[4]!, activeMs: 13000 });
    expect(last).toMatchObject({ correct: true, xpAwarded: 6, lessonCompleted: true, nextOrdinal: null });

    const result = buildDictationResult(d, lesson.id);
    expect(result).toMatchObject({ sentences: 5, xpAwarded: Math.round(6 * c0) + 6 + 3 + 6, noHelp: 2, partial: 2, fullReveal: 1, wrongSubmissions: 1, plays: 2, manualReplays: 1, activeMs: 13000 });
    expect(result.score).toBe(Math.round((100 * (c0 + 1 + 0.5 + 0 + 1)) / 5));
    expect(result.items[0]!.firstAnswer).toBe(wrongWords.join(" "));
    expect(result.items[0]!.diff.filter((o) => o.op !== "same")).toHaveLength(1);
    expect(result.items[3]!.maxHintLevel).toBe(6);
    // typing speed: only attempt 0 was timed (12 s for its correct answer)
    expect(result.typingMs).toBe(12000);
    expect(result.wpm).toBeGreaterThan(0);
    expect(result.cpm).toBeGreaterThan(0);
    expect(recordTime(d, lesson.id, 99999)).toEqual({ ok: true, applied: false });

    // XP joins the Typing track; the lesson is frozen
    expect(typingProgress(d).total).toBe(result.xpAwarded);
    expect(() => d.prepare("UPDATE typing_dictation_lessons SET active_ms = 1 WHERE id = ?").run(lesson.id)).toThrow();
    const stats = dictationAnalytics(d, { days: 7, timezone: "UTC", now: new Date(), voices: f.env.voices.list(d, { purpose: "dictation" }) });
    expect(stats.summary).toMatchObject({ lessons: 1, exercises: 5 });
    // the first answer of sentence 1 had exactly one wrong word; the other first answers were right
    expect(stats.errorTypes.reduce((a, e) => a + e.count, 0)).toBe(1);
    expect(stats.summary.totalChars).toBeGreaterThan(0);
    expect(stats.summary.bestScore).toBe(result.score);
    expect(stats.series[0]!.independent).toBe(40);
    expect(stats.voiceBalance).toHaveLength(10);
    expect(stats.voiceBalance.every((v) => v.weight > 0 && v.weight <= 1.25)).toBe(true);
    expect(stats.voiceBalance.reduce((a, v) => a + v.share, 0)).toBeGreaterThan(99);
    const u = stats.summary.hintUsage;
    expect(u.none + u.level1 + u.level2 + u.level3).toBe(5);
    expect(u.level3).toBe(1); // the stored level is capped at 3 ("three or more")
    expect(stats.voices.every((v) => v.enoughData === false && v.firstAttemptAccuracy === null)).toBe(true);
    expect(createLesson(d, deps, f.env).level).toBe(2);
  });

  it("prepared tracks are used by the next lesson, and a sentence answered with mistakes comes back once as a marked repeat", async () => {
    const { db: d, f } = await setup(6);
    const l1 = createLesson(d, deps, f.env);
    await allJobs(d, f, l1.id);
    const s1 = startLesson(d, deps, f.env, l1.id);
    // the first sentence is answered wrongly once, the rest cleanly
    expect(submitAnswer(d, deps, s1.exercises[0]!.id, { attemptId: randomUUID(), text: "wrong wrong wrong", activeMs: 1 }).correct).toBe(false);
    for (const e of s1.exercises) expect(submitAnswer(d, deps, e.id, { attemptId: randomUUID(), text: e.textEn, activeMs: 2 }).correct).toBe(true);
    expect(dictationOverview(d, f.env).lesson).toBeNull();

    // three prepared tracks
    expect(prepareTracks(d, deps, f.env, 3)).toEqual({ queued: 3 });
    expect(dictationOverview(d, f.env).pool).toEqual({ prepared: 0, generating: 3 });
    const poolJobs = d.prepare("SELECT id, payload_json FROM jobs WHERE json_extract(payload_json, '$.dictationPool') = 1 ORDER BY created_at, rowid").all() as Array<{ id: string; payload_json: string }>;
    for (const j of poolJobs) {
      const payload = JSON.parse(j.payload_json) as DictationJobPayload;
      const out = await runDictationJob({ job: { ...(getJob(d, j.id) as Job), payload }, token: 1, signal: new AbortController().signal, checkpoint: () => {} }, { db: d, chat: f.chat, model: { tag: "gemma4:12b", digest: "x" }, params: { numCtx: 8192, temperature: 0.6, seed: 42 }, env: f.env, deps, assertModel: async () => {}, sleep: async () => {} });
      d.transaction(() => out.alsoCommit?.(d))();
      d.prepare("UPDATE jobs SET state = 'cancelled', finished_at = ? WHERE id = ?").run(new Date().toISOString(), j.id);
    }
    expect(dictationOverview(d, f.env).pool).toEqual({ prepared: 3, generating: 0 });

    // lesson 2: one repeat (6 / 6), three prepared tracks, two sentences left to write
    const l2 = createLesson(d, deps, f.env);
    expect(l2.level).toBe(2);
    expect(l2.status).toBe("generating");
    expect(l2.ready).toBe(4);
    const rows = d.prepare("SELECT ordinal, text_en, repeat_of FROM typing_dictation_exercises WHERE lesson_id = ? ORDER BY ordinal").all(l2.id) as Array<{ ordinal: number; text_en: string; repeat_of: string | null }>;
    const repeat = rows.filter((r) => r.repeat_of !== null);
    expect(repeat).toHaveLength(1);
    expect(repeat[0]!.ordinal).toBeGreaterThanOrEqual(2);
    expect(repeat[0]!.text_en).toBe(s1.exercises[0]!.textEn);
    expect((d.prepare("SELECT COUNT(*) AS n FROM typing_dictation_pool_use").get() as { n: number }).n).toBe(3);
    expect(dictationOverview(d, f.env).pool.prepared).toBe(0);
    expect((d.prepare("SELECT COUNT(*) AS n FROM jobs WHERE json_extract(payload_json,'$.dictationLessonId') = ?").get(l2.id) as { n: number }).n).toBe(2);
    await allJobs(d, f, l2.id, 1, [0, 1, 2, 3, 4, 5].filter((o) => !rows.some((r) => r.ordinal === o)));
    expect(dictationOverview(d, f.env).lesson?.status).toBe("ready");
    expect(dictationState(d, l2.id).exercises.filter((e) => e.isRepeat)).toHaveLength(1);
  });

  it("a saved word is asked for, and a sentence without it is refused", async () => {
    const { db: d, f } = await setup();
    addWord(d, deps, { word: "bakery" });
    const items = buildItems(d, f.env, { count: 50, seed: 3, topicOffset: 0, asOf: new Date().toISOString() });
    expect(items.some((i) => i.vocabularyLemma === "bakery" && (i.vocabularyForms ?? []).includes("bakery"))).toBe(true);
    expect(items.every((i) => (i.targetWords ?? 0) >= 7 && (i.targetWords ?? 0) <= 14)).toBe(true);
    const lesson = createLesson(d, deps, f.env);
    f.state.queue.unshift("A sentence that avoids the special word is here today.");
    const plan = JSON.parse((d.prepare("SELECT plan_json FROM typing_dictation_lessons WHERE id = ?").get(lesson.id) as { plan_json: string }).plan_json) as { items: Array<Record<string, unknown>> };
    plan.items[0] = { ...plan.items[0], vocabularyLemma: "bakery", vocabularyForms: ["bakery", "bakeries"] };
    d.exec("DROP TRIGGER typing_dictation_lessons_identity");
    d.prepare("UPDATE typing_dictation_lessons SET plan_json = ? WHERE id = ?").run(JSON.stringify(plan), lesson.id);
    const out = await runJob(d, f, { dictationLessonId: lesson.id, ordinal: 0, attempt: 1 });
    expect((out.metrics as { rejected: Array<{ code: string }> }).rejected[0]?.code).toBe("WORD_MISSING");
    expect((d.prepare("SELECT text_en FROM typing_dictation_exercises WHERE ordinal = 0").get() as { text_en: string }).text_en).toContain("bakery");
  });

  it("a missing audio file blocks Start, is voiced again from the saved sentence, then the lesson is ready", async () => {
    const { db: d, f } = await setup();
    const lesson = createLesson(d, deps, f.env);
    await allJobs(d, f, lesson.id);
    const ex = d.prepare("SELECT id, audio_file FROM typing_dictation_exercises WHERE ordinal = 2").get() as { id: string; audio_file: string };
    rmSync(path.join(f.env.audioDir, ex.audio_file));
    expect(() => exerciseAudio(d, f.env, ex.id)).toThrow(/missing/);
    expect(() => startLesson(d, deps, f.env, lesson.id)).toThrow(/missing/);
    expect(dictationOverview(d, f.env).lesson?.status).toBe("generating");
    await runJob(d, f, { dictationLessonId: lesson.id, ordinal: 2, attempt: 2, resynthesize: true });
    expect(existsSync(path.join(f.env.audioDir, ex.audio_file))).toBe(true);
    expect(dictationOverview(d, f.env).lesson?.status).toBe("ready");
    expect(startLesson(d, deps, f.env, lesson.id).exercises).toHaveLength(5);
  });

  it("a retry with nothing missing (the audio came back before the jobs ran) makes the lesson ready, not stuck", async () => {
    const { db: d, f } = await setup();
    const lesson = createLesson(d, deps, f.env);
    await allJobs(d, f, lesson.id);
    const ex = d.prepare("SELECT audio_file FROM typing_dictation_exercises WHERE ordinal = 1").get() as { audio_file: string };
    const bytes = readFileSync(path.join(f.env.audioDir, ex.audio_file));
    rmSync(path.join(f.env.audioDir, ex.audio_file));
    expect(() => startLesson(d, deps, f.env, lesson.id)).toThrow(/missing/);
    writeFileSync(path.join(f.env.audioDir, ex.audio_file), bytes); // restored before the job runs
    d.prepare("UPDATE jobs SET state = 'cancelled', finished_at = ? WHERE json_extract(payload_json,'$.dictationLessonId') = ? AND state = 'queued'").run(new Date().toISOString(), lesson.id);
    expect(dictationOverview(d, f.env).lesson?.status).toBe("failed");
    expect(retryLesson(d, deps, f.env, lesson.id).status).toBe("ready");
  });

  it("without Piper or a speech check the mode is unavailable and no lesson is created", async () => {
    const { db: d, f } = await setup();
    f.env.tts = { ...f.env.tts, available: () => ({ ok: false, reason: "tts_not_installed" }) };
    expect(dictationOverview(d, f.env)).toMatchObject({ available: false, reason: "tts_not_installed", lesson: null, nextLevel: 1 });
    expect(() => createLesson(d, deps, f.env)).toThrow(/not available/);
    f.env.tts = { ...f.env.tts, available: () => ({ ok: true, modelSha256: "a".repeat(64) }) };
    f.env.asr = { ...f.env.asr, available: () => false };
    expect(dictationOverview(d, f.env).reason).toBe("asr_unavailable");
    expect(tokenize("ok")).toEqual(["ok"]);
  });

  it("the migration triggers: one open lesson, an answered sentence is closed, XP needs a correct answer, completion needs all answers", async () => {
    const { db: d, f } = await setup();
    const lesson = createLesson(d, deps, f.env);
    expect(() => d.prepare("INSERT INTO typing_dictation_lessons(id, level_number, status, exercise_count, settings_revision, settings_json, plan_json, created_at) VALUES ('x', 9, 'generating', 5, 1, '{}', '{}', 'now')").run()).toThrow();
    expect(() => d.prepare("UPDATE typing_dictation_lessons SET status = 'completed', completed_at = 'now' WHERE id = ?").run(lesson.id)).toThrow(/every sentence/);
    expect(() => d.prepare("DELETE FROM typing_dictation_lessons").run()).toThrow(/append-only/);
    expect(() => d.prepare("INSERT INTO typing_dictation_xp_events(id, exercise_id, amount, coefficient, rule_version, created_at) VALUES ('a','nope',3,0.5,'v','now')").run()).toThrow();
  });
});
