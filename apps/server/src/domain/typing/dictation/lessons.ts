import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  DICTATION_CHECK_VERSION,
  DICTATION_XP_VERSION,
  typingDictationExercisesPerLesson,
  type DictationAnswerResponse,
  type DictationExerciseState,
  type DictationHintResponse,
  type DictationLessonSummary,
  type DictationOverview,
  type DictationState,
  type DictationUnavailableReason,
  type DictationWord,
} from "@english-lab/contracts";
import type { Db } from "../../../db/open.js";
import { ApiError } from "../../../errors.js";
import { enqueue } from "../../../queue/jobs.js";
import type { TtsClient } from "../../../adapters/tts/piper.js";
import type { VoiceService } from "../../voices/service.js";
import { isSoundFlagged } from "../../voices/flags.js";
import { modelShaOpt } from "../../voices/model.js";
import { loadSettings } from "../../sessions/policy.js";
import { buildItems, mulberry32, targetWordsFor, VOCABULARY_SHARE, weakGrammarSkills, type DictationTopic, type PlanItem } from "./planning.js";
import type { DictationAsr } from "./asr.js";
import { isCorrect, rawTokens, tokenize, wordDistance } from "./check.js";
import { attemptedAnswerWords, displayWords, revealedSet, stuckWord, wrongAnswerWords } from "./hints.js";
import { loadRealClips, type RealSpeechConfig } from "./realSpeech.js";
import { dictationFingerprint } from "./check.js";
import { answerLetterFacts } from "./keyFacts.js";
import { fingerprintOf, normalizeSentence } from "../../content/normalize.js";

/** Everything the dictation mode needs from outside the database. Tests replace the clients with fakes. */
export interface DictationEnv {
  tts: TtsClient;
  asr: DictationAsr;
  /** the one source of voices (TASK_029): catalogue, weights, checks */
  voices: VoiceService;
  topics: DictationTopic[];
  audioDir: string;
  realSpeech?: RealSpeechConfig;
}

export interface Deps {
  now: () => Date;
  newId: () => string;
}

/** own constants: the Mastery weights are not imported (a dictation answer is not grammar evidence) */
export const DICTATION_TRANSLATION_COEFFICIENT = 0.5;
export const DICTATION_XP_PER_EXERCISE = 6;
/** a hint asked for with F4 costs half a word error; a word error in a wrong answer costs one */
export const DICTATION_HINT_COST = 0.5;
export { buildItems, targetWordsFor, weakGrammarSkills };
/** at most one sentence in this many is a repeat of an earlier one answered with mistakes */
export const REPEAT_EVERY = 6;

export function loadDictationContent(projectRoot: string): { topics: DictationTopic[] } {
  const t = JSON.parse(readFileSync(path.join(projectRoot, "content", "dictation", "topics.json"), "utf8")) as { topics: Array<string | DictationTopic> };
  return { topics: t.topics.map((x) => (typeof x === "string" ? { name: x, group: "daily" } : x)) };
}

/* ------------------------------------------------------------------ availability */

export function dictationAvailability(env: DictationEnv): { available: boolean; reason: DictationUnavailableReason | null } {
  const tts = env.tts.available();
  if (!tts.ok) return { available: false, reason: tts.reason };
  if (!env.asr.available()) return { available: false, reason: "asr_unavailable" };
  return { available: true, reason: null };
}

/* ------------------------------------------------------------------ rows */

interface LessonRow {
  id: string;
  level_number: number;
  status: "generating" | "ready" | "failed" | "completed";
  exercise_count: number;
  settings_revision: number;
  settings_json: string;
  plan_json: string;
  generation_attempt: number;
  active_ms: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface ExerciseRow {
  id: string;
  lesson_id: string;
  ordinal: number;
  text_en: string;
  translation_ru: string;
  topic: string;
  target_skill_id: string | null;
  word_count: number;
  source: "tts" | "real";
  voice_name: string | null;
  audio_file: string;
  audio_ms: number;
  repeat_of: string | null;
}

export type { PlanItem } from "./planning.js";

export interface LessonPlan {
  version: 1;
  /** the formula version of the voice weights this plan was drawn with (D124) and the weights by voice name */
  voicesVersion: number;
  voiceWeights?: Record<string, number>;
  items: PlanItem[];
}

const lessonRow = (db: Db, id: string): LessonRow => {
  const r = db.prepare("SELECT * FROM typing_dictation_lessons WHERE id = ?").get(id) as LessonRow | undefined;
  if (!r) throw new ApiError(404, "TYPING_DICTATION_LESSON_NOT_FOUND", "Unknown dictation lesson");
  return r;
};

const exerciseRow = (db: Db, id: string): ExerciseRow & { status: LessonRow["status"] } => {
  const r = db.prepare("SELECT e.*, l.status AS lesson_status FROM typing_dictation_exercises e JOIN typing_dictation_lessons l ON l.id = e.lesson_id WHERE e.id = ?").get(id) as (ExerciseRow & { lesson_status: LessonRow["status"] }) | undefined;
  if (!r) throw new ApiError(404, "TYPING_DICTATION_EXERCISE_NOT_FOUND", "Unknown dictation exercise");
  return { ...r, status: r.lesson_status };
};

const OPEN_JOB_STATES = "('queued','waiting_for_gpu','running','paused')";

/** The queue does not call the domain when a job fails for good, so the state is derived on read (never written by a GET). */
export function effectiveStatus(db: Db, lesson: LessonRow): LessonRow["status"] {
  if (lesson.status !== "generating") return lesson.status;
  const open = (db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE kind = 'generation' AND json_extract(payload_json, '$.dictationLessonId') = ? AND state IN ${OPEN_JOB_STATES}`).get(lesson.id) as { n: number }).n;
  return open > 0 ? "generating" : "failed";
}

const readyCount = (db: Db, lessonId: string): number => (db.prepare("SELECT COUNT(*) AS n FROM typing_dictation_exercises WHERE lesson_id = ?").get(lessonId) as { n: number }).n;

function summary(db: Db, lesson: LessonRow): DictationLessonSummary {
  return { id: lesson.id, level: lesson.level_number, status: effectiveStatus(db, lesson), ready: readyCount(db, lesson.id), total: lesson.exercise_count, started: lesson.started_at !== null };
}

const openLesson = (db: Db): LessonRow | undefined => db.prepare("SELECT * FROM typing_dictation_lessons WHERE status <> 'completed'").get() as LessonRow | undefined;

export function unusedRealClips(db: Db, config: RealSpeechConfig) {
  const seen = new Set<string>();
  const inExercises = db.prepare("SELECT 1 FROM typing_dictation_exercises WHERE fingerprint = ?");
  const inPool = db.prepare("SELECT 1 FROM typing_dictation_pool WHERE fingerprint = ?");
  const inPrompts = db.prepare("SELECT 1 FROM prompt_units WHERE fingerprint = ? LIMIT 1");
  return loadRealClips(config).filter((c) => {
    const fp = dictationFingerprint(c.text);
    if (seen.has(fp) || inExercises.get(fp) || inPool.get(fp) || inPrompts.get(fingerprintOf(normalizeSentence(c.text)))) return false;
    seen.add(fp);
    return true;
  });
}

export function dictationOverview(db: Db, env: DictationEnv): DictationOverview {
  const open = openLesson(db);
  const nextLevel = open ? open.level_number : (db.prepare("SELECT COALESCE(MAX(level_number), 0) + 1 AS n FROM typing_dictation_lessons").get() as { n: number }).n;
  const source = loadSettings(db).values.typingDictationSource ?? (env.realSpeech ? "real" : "tts");
  let availableReal = false;
  if (source === "real" && !open && env.realSpeech) {
    const perLesson = typingDictationExercisesPerLesson(loadSettings(db).values);
    availableReal = unusedRealClips(db, env.realSpeech).length >= perLesson - realRepeatCandidates(db, Math.floor(perLesson / REPEAT_EVERY)).length;
  }
  const openIsReal = !!open && !!db.prepare("SELECT 1 FROM typing_dictation_exercises WHERE lesson_id = ? AND source = 'real' LIMIT 1").get(open.id);
  const a = openIsReal ? { available: true, reason: null } : source === "real" && !open ? { available: availableReal, reason: availableReal ? null : "real_speech_unavailable" as const } : dictationAvailability(env);
  const prepared = (db.prepare("SELECT COUNT(*) AS n FROM typing_dictation_pool p WHERE NOT EXISTS (SELECT 1 FROM typing_dictation_pool_use u WHERE u.pool_id = p.id)").get() as { n: number }).n;
  const generating = (db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE kind = 'generation' AND json_extract(payload_json, '$.dictationPool') = 1 AND state IN ${OPEN_JOB_STATES}`).get() as { n: number }).n;
  return { available: a.available, reason: a.reason, nextLevel, lesson: open ? summary(db, open) : null, pool: { prepared, generating } };
}

/* ------------------------------------------------------------------ planning */

const generationKey = (lessonId: string, ordinal: number, attempt: number): string => `dictation:${lessonId}:${ordinal}:${attempt}`;

function enqueueSentence(db: Db, deps: Deps, lesson: Pick<LessonRow, "id">, ordinal: number, attempt: number, resynthesize = false): void {
  enqueue(db, deps, {
    kind: "generation",
    priority: 3,
    payload: { dictationLessonId: lesson.id, ordinal, attempt, ...(resynthesize ? { resynthesize: true } : {}) },
    idempotencyKey: generationKey(lesson.id, ordinal, attempt),
  });
}

/** Prepare tracks ahead of time (the button under Start): sentences are written, voiced and checked now, and the next lessons take them. */
export function prepareTracks(db: Db, deps: Deps, env: DictationEnv, count: number): { queued: number } {
  const a = dictationAvailability(env);
  if (!a.available) throw new ApiError(409, "TYPING_DICTATION_UNAVAILABLE", `Audio Dictation is not available (${a.reason}). Run: npm run dictation:setup`);
  if (!Number.isInteger(count) || count < 1 || count > 50) throw new ApiError(400, "VALIDATION_ERROR", "Prepare between 1 and 50 tracks");
  return db
    .transaction(() => {
      const batch = deps.newId();
      const base = (db.prepare("SELECT (SELECT COUNT(*) FROM typing_dictation_exercises) + (SELECT COUNT(*) FROM typing_dictation_pool) AS n").get() as { n: number }).n;
      const items = buildItems(db, env, { count, seed: base * 31 + count, topicOffset: base, asOf: deps.now().toISOString() });
      for (const item of items) {
        enqueue(db, deps, { kind: "generation", priority: 3, payload: { dictationPool: 1, batch, index: item.ordinal, item }, idempotencyKey: `dictation-pool:${batch}:${item.ordinal}` });
      }
      return { queued: count };
    })
    .immediate();
}

/**
 * Real recordings come back only while they are not mastered: the first time the sentence took more than one mistake, or its answer was
 * shown. A sentence typed cleanly (no mistakes, no hints) never returns. It stays in the pool, now and then (not in the last two levels,
 * not when it came back recently), until a marked repeat of it is typed with no mistake, no hint and no shown answer.
 */
/** `recentLevels`: a sentence that came back in one of this many latest levels is left alone (tests pass a negative number to look at mastery only) */
export function realRepeatCandidates(db: Db, limit: number, recentLevels = 1): Array<{ id: string }> {
  if (limit <= 0) return [];
  return db
    .prepare(
      `SELECT e.id AS id FROM typing_dictation_exercises e
        JOIN typing_dictation_lessons l ON l.id = e.lesson_id AND l.status = 'completed'
       WHERE e.repeat_of IS NULL
         AND e.source = 'real'
         AND ((SELECT COALESCE(SUM(a.word_errors), 0) FROM typing_dictation_attempts a WHERE a.exercise_id = e.id AND a.correct = 0) > 1
              OR EXISTS (SELECT 1 FROM typing_dictation_events v WHERE v.exercise_id = e.id AND v.reveal_all = 1))
         AND NOT EXISTS (SELECT 1 FROM typing_dictation_exercises m
                          WHERE m.repeat_of = e.id
                            AND EXISTS (SELECT 1 FROM typing_dictation_attempts c WHERE c.exercise_id = m.id AND c.correct = 1)
                            AND NOT EXISTS (SELECT 1 FROM typing_dictation_attempts w WHERE w.exercise_id = m.id AND w.correct = 0 AND w.word_errors > 0)
                            AND NOT EXISTS (SELECT 1 FROM typing_dictation_events h WHERE h.exercise_id = m.id AND (h.kind = 'hint' OR h.reveal_all = 1)))
         AND NOT EXISTS (SELECT 1 FROM typing_dictation_exercises r JOIN typing_dictation_lessons rl ON rl.id = r.lesson_id
                          WHERE r.repeat_of = e.id AND rl.level_number >= (SELECT MAX(level_number) - ? FROM typing_dictation_lessons))
       ORDER BY (SELECT COALESCE(SUM(a.word_errors), 0) FROM typing_dictation_attempts a WHERE a.exercise_id = e.id AND a.correct = 0) DESC, e.created_at ASC
       LIMIT ?`,
    )
    .all(recentLevels, limit) as Array<{ id: string }>;
}

/** earlier sentences that were answered with mistakes or shown, worth repeating now and then; never one that already came back recently */
function repeatCandidates(db: Db, limit: number): Array<{ id: string }> {
  if (limit <= 0) return [];
  return db
    .prepare(
      `SELECT e.id AS id FROM typing_dictation_exercises e
        JOIN typing_dictation_lessons l ON l.id = e.lesson_id AND l.status = 'completed'
       WHERE e.repeat_of IS NULL
         AND e.source = 'tts'
         AND (EXISTS (SELECT 1 FROM typing_dictation_attempts a WHERE a.exercise_id = e.id AND a.correct = 0)
              OR EXISTS (SELECT 1 FROM typing_dictation_events v WHERE v.exercise_id = e.id AND v.reveal_all = 1))
         AND (SELECT COUNT(*) FROM typing_dictation_exercises r WHERE r.repeat_of = e.id) < 2
         AND NOT EXISTS (SELECT 1 FROM typing_dictation_exercises r JOIN typing_dictation_lessons rl ON rl.id = r.lesson_id
                          WHERE r.repeat_of = e.id AND rl.level_number >= l.level_number AND rl.level_number >= (SELECT MAX(level_number) - 1 FROM typing_dictation_lessons))
       ORDER BY (SELECT COALESCE(SUM(a.word_errors), 0) FROM typing_dictation_attempts a WHERE a.exercise_id = e.id AND a.correct = 0) DESC, e.created_at ASC
       LIMIT ?`,
    )
    .all(limit) as Array<{ id: string }>;
}

const EXERCISE_COLUMNS = "id, lesson_id, ordinal, text_en, translation_ru, topic, target_skill_id, word_count, fingerprint, source, voice_id, voice_name, length_scale, tts_model_sha256, audio_file, audio_ms, asr_model, asr_text, status, job_result_id, created_at, repeat_of";

/* ------------------------------------------------------------------ lessons */

/**
 * Idempotent: the open lesson is returned as it is. Otherwise the next level is created in ONE transaction: a few sentences that were
 * answered with mistakes come back as marked repeats, then prepared tracks are used (oldest first), and only the rest is queued for writing.
 */
export function createLesson(db: Db, deps: Deps, env: DictationEnv): DictationLessonSummary {
  const existing = openLesson(db);
  if (existing) return summary(db, existing);
  const asOf = deps.now().toISOString();
  const settings = loadSettings(db);
  const count = typingDictationExercisesPerLesson(settings.values);
  const level = (db.prepare("SELECT COALESCE(MAX(level_number), 0) + 1 AS n FROM typing_dictation_lessons").get() as { n: number }).n;
  if ((settings.values.typingDictationSource ?? (env.realSpeech ? "real" : "tts")) === "real") {
    if (!env.realSpeech) throw new ApiError(409, "TYPING_DICTATION_UNAVAILABLE", "Real speech recordings are not configured");
    const config = env.realSpeech;
    return db.transaction(() => {
      const again = openLesson(db);
      if (again) return summary(db, again);
      // a few sentences that were not mastered come back as marked repeats (never in the first two places); the rest are new recordings
      const repeats = realRepeatCandidates(db, Math.floor(count / REPEAT_EVERY));
      const selected = unusedRealClips(db, config).slice(0, count - repeats.length);
      if (selected.length < count - repeats.length) throw new ApiError(409, "TYPING_DICTATION_REAL_SHORTAGE", `Only ${selected.length} checked real-speech sentences remain; ${count - repeats.length} are needed.`);
      const rand = mulberry32(level * 104729 + count);
      const spots = Array.from({ length: Math.max(0, count - 2) }, (_, k) => k + 2);
      for (let i = spots.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [spots[i], spots[j]] = [spots[j]!, spots[i]!];
      }
      const repeatAt = new Map<number, string>(repeats.map((x, k) => [spots[k]!, x.id] as [number, string]));
      const slots: Array<{ repeat: string } | { clip: (typeof selected)[number] }> = [];
      let nextClip = 0;
      for (let ordinal = 0; ordinal < count; ordinal++) {
        const rep = repeatAt.get(ordinal);
        slots.push(rep ? { repeat: rep } : { clip: selected[nextClip++]! });
      }
      const id = deps.newId();
      const plan: LessonPlan = { version: 1, voicesVersion: 0, items: [] };
      db.prepare("INSERT INTO typing_dictation_lessons(id, level_number, status, exercise_count, settings_revision, settings_json, plan_json, generation_attempt, created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(id, level, "generating", count, settings.revision, JSON.stringify(settings.values), JSON.stringify(plan), 1, asOf);
      mkdirSync(env.audioDir, { recursive: true });
      slots.forEach((slot, ordinal) => {
        if ("repeat" in slot) {
          const o = db.prepare(`SELECT ${EXERCISE_COLUMNS} FROM typing_dictation_exercises WHERE id = ?`).get(slot.repeat) as Record<string, unknown>;
          const prov = db.prepare("SELECT corpus, sentence_id, clip_file, audio_sha256, validation_json FROM typing_dictation_real_provenance WHERE exercise_id = ?").get(slot.repeat) as { corpus: string; sentence_id: string; clip_file: string; audio_sha256: string; validation_json: string } | undefined;
          if (!prov) throw new ApiError(409, "TYPING_DICTATION_AUDIO_CHANGED", "A repeated real recording has lost its provenance");
          const repId = deps.newId();
          db.prepare(`INSERT INTO typing_dictation_exercises(id, lesson_id, ordinal, text_en, translation_ru, topic, target_skill_id, word_count, fingerprint, source, voice_id, voice_name, length_scale, tts_model_sha256, audio_file, audio_ms, asr_model, asr_text, status, job_result_id, created_at, repeat_of)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(repId, id, ordinal, o.text_en, o.translation_ru, o.topic, o.target_skill_id, o.word_count, `${String(o.fingerprint)}:r:${id}`, "real", null, null, null, null, o.audio_file, o.audio_ms, o.asr_model, o.asr_text, "validated", null, asOf, slot.repeat);
          db.prepare("INSERT INTO typing_dictation_real_provenance(exercise_id, corpus, sentence_id, clip_file, audio_sha256, validation_json, created_at) VALUES (?,?,?,?,?,?,?)").run(repId, prov.corpus, prov.sentence_id, prov.clip_file, prov.audio_sha256, prov.validation_json, asOf);
          return;
        }
        const c = slot.clip;
        const exId = deps.newId();
        const filename = `real-${c.sha256}.mp3`;
        const dest = path.join(env.audioDir, filename);
        if (!existsSync(dest)) copyFileSync(path.join(config.audioDir, c.file), dest);
        if (createHash("sha256").update(readFileSync(dest)).digest("hex") !== c.sha256) throw new ApiError(409, "TYPING_DICTATION_AUDIO_CHANGED", "A checked real recording has changed");
        db.prepare(`INSERT INTO typing_dictation_exercises(id, lesson_id, ordinal, text_en, translation_ru, topic, target_skill_id, word_count, fingerprint, source, voice_id, voice_name, length_scale, tts_model_sha256, audio_file, audio_ms, asr_model, asr_text, status, job_result_id, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(exId, id, ordinal, c.text, c.translationRu, "Everyday English", null, tokenize(c.text).length, dictationFingerprint(c.text), "real", null, null, null, null, filename, c.audioMs, c.validation.asrModels.join("+"), c.validation.asrTexts[0], "validated", null, asOf);
        db.prepare("INSERT INTO typing_dictation_real_provenance(exercise_id, corpus, sentence_id, clip_file, audio_sha256, validation_json, created_at) VALUES (?,?,?,?,?,?,?)").run(exId, c.validation.source, c.sentenceId, c.file, c.sha256, JSON.stringify(c.validation), asOf);
      });
      markReadyIfComplete(db, env, id);
      return summary(db, lessonRow(db, id));
    }).immediate();
  }
  const items = buildItems(db, env, { count, seed: level * 7919 + count, topicOffset: level, asOf });
  const a = dictationAvailability(env);
  return db
    .transaction((): DictationLessonSummary => {
      const again = openLesson(db);
      if (again) return summary(db, again);
      const rand = mulberry32(level * 104729 + count);
      // repeats: at most one in REPEAT_EVERY sentences, never in the first two places
      const repeats = repeatCandidates(db, Math.floor(count / REPEAT_EVERY));
      const spots = Array.from({ length: Math.max(0, count - 2) }, (_, k) => k + 2);
      for (let i = spots.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [spots[i], spots[j]] = [spots[j]!, spots[i]!];
      }
      const repeatAt = new Map<number, string>(repeats.map((r, k) => [spots[k]!, r.id] as [number, string]).filter(([o]) => o !== undefined));
      const pool = (db.prepare("SELECT * FROM typing_dictation_pool p WHERE NOT EXISTS (SELECT 1 FROM typing_dictation_pool_use u WHERE u.pool_id = p.id) ORDER BY created_at, rowid").all() as Array<Record<string, unknown> & { id: string; audio_file: string }>).filter((p) => existsSync(audioPathFor(env, p.audio_file)));
      let nextPool = 0;
      const planned = items.map((item) => {
        const repeat = repeatAt.get(item.ordinal);
        if (repeat) return { ...item, from: "repeat" as const, ref: repeat };
        const row = pool[nextPool];
        if (row) {
          nextPool++;
          return { ...item, from: "pool" as const, ref: row.id };
        }
        return item;
      });
      const generate = planned.filter((p) => p.from === "generate");
      if (generate.length > 0 && !a.available) throw new ApiError(409, "TYPING_DICTATION_UNAVAILABLE", `Audio Dictation is not available (${a.reason}). Run: npm run dictation:setup`);
      const id = deps.newId();
      const snapshot = env.voices.snapshot(db, { purpose: "dictation", ...modelShaOpt(env.tts) });
      const plan: LessonPlan = { version: 1, voicesVersion: snapshot.version, voiceWeights: snapshot.weights, items: planned };
      db.prepare("INSERT INTO typing_dictation_lessons(id, level_number, status, exercise_count, settings_revision, settings_json, plan_json, generation_attempt, created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(id, level, "generating", count, settings.revision, JSON.stringify(settings.values), JSON.stringify(plan), 1, asOf);
      const now = asOf;
      for (const p of planned) {
        if (p.from === "pool") {
          const row = pool.find((r) => r.id === p.ref)!;
          const exId = deps.newId();
          db.prepare(
            `INSERT INTO typing_dictation_exercises(id, lesson_id, ordinal, text_en, translation_ru, topic, target_skill_id, word_count, fingerprint, source, voice_id, voice_name, length_scale, tts_model_sha256, audio_file, audio_ms, asr_model, asr_text, status, job_result_id, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ).run(exId, id, p.ordinal, row.text_en, row.translation_ru, row.topic, row.target_skill_id, row.word_count, row.fingerprint, "tts", row.voice_id, row.voice_name, row.length_scale, row.tts_model_sha256, row.audio_file, row.audio_ms, row.asr_model, row.asr_text, "validated", row.job_result_id, now);
          db.prepare("INSERT INTO typing_dictation_pool_use(pool_id, exercise_id, created_at) VALUES (?,?,?)").run(row.id, exId, now);
        } else if (p.from === "repeat") {
          const o = db.prepare(`SELECT ${EXERCISE_COLUMNS} FROM typing_dictation_exercises WHERE id = ?`).get(p.ref) as Record<string, unknown>;
          db.prepare(
            `INSERT INTO typing_dictation_exercises(id, lesson_id, ordinal, text_en, translation_ru, topic, target_skill_id, word_count, fingerprint, source, voice_id, voice_name, length_scale, tts_model_sha256, audio_file, audio_ms, asr_model, asr_text, status, job_result_id, created_at, repeat_of)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ).run(deps.newId(), id, p.ordinal, o.text_en, o.translation_ru, o.topic, o.target_skill_id, o.word_count, `${String(o.fingerprint)}:r:${id}`, "tts", o.voice_id, o.voice_name, o.length_scale, o.tts_model_sha256, o.audio_file, o.audio_ms, o.asr_model, o.asr_text, "validated", o.job_result_id, now, p.ref);
        } else {
          enqueueSentence(db, deps, { id }, p.ordinal, 1);
        }
      }
      markReadyIfComplete(db, env, id);
      return summary(db, lessonRow(db, id));
    })
    .immediate();
}

const audioPathFor = (env: DictationEnv, file: string): string => path.join(env.audioDir, file);

/** ordinals that have no exercise, and exercises whose audio file is gone (a restored backup has no audio) */
function missingWork(db: Db, env: DictationEnv, lesson: LessonRow): { sentences: number[]; audio: number[] } {
  const have = db.prepare("SELECT ordinal, audio_file FROM typing_dictation_exercises WHERE lesson_id = ?").all(lesson.id) as Array<{ ordinal: number; audio_file: string }>;
  const present = new Set(have.map((h) => h.ordinal));
  const sentences: number[] = [];
  for (let o = 0; o < lesson.exercise_count; o++) if (!present.has(o)) sentences.push(o);
  return { sentences, audio: have.filter((h) => !existsSync(audioPathFor(env, h.audio_file))).map((h) => h.ordinal) };
}

/** Runs inside a job's commit: `ready` once every sentence exists and every audio file is on disk. */
export function markReadyIfComplete(db: Db, env: DictationEnv, lessonId: string): void {
  const lesson = lessonRow(db, lessonId);
  if (lesson.status !== "generating") return;
  const work = missingWork(db, env, lesson);
  if (work.sentences.length === 0 && work.audio.length === 0) db.prepare("UPDATE typing_dictation_lessons SET status = 'ready' WHERE id = ?").run(lessonId);
}

/** Only a `failed` lesson: a new attempt number (a repeated key would return the old failed job), jobs only for what is missing. */
export function retryLesson(db: Db, deps: Deps, env: DictationEnv, lessonId: string): DictationLessonSummary {
  const a = dictationAvailability(env);
  if (!a.available) throw new ApiError(409, "TYPING_DICTATION_UNAVAILABLE", `Audio Dictation is not available (${a.reason}). Run: npm run dictation:setup`);
  return db
    .transaction((): DictationLessonSummary => {
      const lesson = lessonRow(db, lessonId);
      if (effectiveStatus(db, lesson) !== "failed") throw new ApiError(409, "TYPING_DICTATION_NOT_FAILED", "Only a lesson whose generation failed can be retried");
      const attempt = lesson.generation_attempt + 1;
      const work = missingWork(db, env, lesson);
      db.prepare("UPDATE typing_dictation_lessons SET generation_attempt = ?, status = 'generating' WHERE id = ?").run(attempt, lesson.id);
      for (const o of work.sentences) enqueueSentence(db, deps, lesson, o, attempt);
      for (const o of work.audio) enqueueSentence(db, deps, lesson, o, attempt, true);
      // nothing is missing any more (the files came back): the lesson is simply ready
      if (work.sentences.length === 0 && work.audio.length === 0) markReadyIfComplete(db, env, lesson.id);
      return summary(db, lessonRow(db, lessonId));
    })
    .immediate();
}

export function startLesson(db: Db, deps: Deps, env: DictationEnv, lessonId: string): DictationState {
  const r = db
    .transaction((): DictationState | "audio_missing" => {
      const lesson = lessonRow(db, lessonId);
      const status = effectiveStatus(db, lesson);
      if (status !== "ready") throw new ApiError(409, "TYPING_DICTATION_NOT_READY", `The lesson is ${status}, not ready`);
      if (readyCount(db, lesson.id) < lesson.exercise_count) throw new ApiError(409, "TYPING_DICTATION_NOT_READY", "The lesson is incomplete");
      const realMissing = db.prepare("SELECT e.audio_file AS audioFile, p.clip_file AS clipFile, p.audio_sha256 AS sha FROM typing_dictation_exercises e JOIN typing_dictation_real_provenance p ON p.exercise_id = e.id WHERE e.lesson_id = ? AND e.source = 'real'").all(lesson.id) as Array<{ audioFile: string; clipFile: string; sha: string }>;
      for (const r of realMissing) {
        const dest = audioPathFor(env, r.audioFile);
        if (existsSync(dest)) continue;
        if (!env.realSpeech || path.basename(r.clipFile) !== r.clipFile) throw new ApiError(409, "TYPING_DICTATION_AUDIO_MISSING", "A real recording is missing and its source is unavailable");
        const source = path.join(env.realSpeech.audioDir, r.clipFile);
        if (!existsSync(source) || createHash("sha256").update(readFileSync(source)).digest("hex") !== r.sha) throw new ApiError(409, "TYPING_DICTATION_AUDIO_MISSING", "The original checked recording is missing or changed");
        mkdirSync(env.audioDir, { recursive: true });
        copyFileSync(source, dest);
      }
      const work = missingWork(db, env, lesson);
      if (work.audio.length > 0) {
        // the audio is not in a database backup: it is voiced again from the saved text, voice and speed (committed, then reported)
        const attempt = lesson.generation_attempt + 1;
        db.prepare("UPDATE typing_dictation_lessons SET generation_attempt = ?, status = 'generating' WHERE id = ?").run(attempt, lesson.id);
        for (const o of work.audio) enqueueSentence(db, deps, lesson, o, attempt, true);
        return "audio_missing";
      }
      if (lesson.started_at === null) db.prepare("UPDATE typing_dictation_lessons SET started_at = ? WHERE id = ?").run(deps.now().toISOString(), lesson.id);
      return buildState(db, lessonRow(db, lessonId));
    })
    .immediate();
  if (r === "audio_missing") throw new ApiError(409, "TYPING_DICTATION_AUDIO_MISSING", "Some audio files are missing; they are being created again");
  return r;
}

/* ------------------------------------------------------------------ state */

interface HintEvent {
  reveal_from: number;
  reveal_to: number;
}

const hintEvents = (db: Db, exerciseId: string): HintEvent[] => db.prepare("SELECT reveal_from, reveal_to FROM typing_dictation_events WHERE exercise_id = ? AND kind = 'hint' ORDER BY rowid").all(exerciseId) as HintEvent[];
// Reconstruct feedback from submitted answers; existing hint events and raw attempts remain unchanged.
function visibleHintWords(db: Db, e: ExerciseRow, hints: HintEvent[]): Set<number> {
  const shown = revealedSet(hints.map((h) => [h.reveal_from, h.reveal_to] as const));
  const attempts = db.prepare("SELECT answer_text FROM typing_dictation_attempts WHERE exercise_id = ? AND correct = 0 AND check_version = 'dictation-check-v2'").all(e.id) as Array<{ answer_text: string }>;
  const words = displayWords(e.text_en);
  for (const attempt of attempts) for (const index of attemptedAnswerWords(words, attempt.answer_text)) shown.add(index);
  return shown;
}
const hasEvent = (db: Db, exerciseId: string, kind: string): boolean => db.prepare("SELECT 1 FROM typing_dictation_events WHERE exercise_id = ? AND kind = ?").get(exerciseId, kind) !== undefined;
const isDone = (db: Db, exerciseId: string): boolean => db.prepare("SELECT 1 FROM typing_dictation_attempts WHERE exercise_id = ? AND correct = 1").get(exerciseId) !== undefined;

function wordsFor(text: string, shown: "all" | Set<number>): DictationWord[] {
  return displayWords(text).map((w, index) => ({ index, text: shown === "all" || shown.has(index) ? w.display : null }));
}

function exerciseState(db: Db, e: ExerciseRow, currentOrdinal: number | null): DictationExerciseState {
  const done = isDone(db, e.id);
  const hints = hintEvents(db, e.id);
  const isCurrent = currentOrdinal === e.ordinal;
  const shown = done ? "all" : isCurrent ? visibleHintWords(db, e, hints) : new Set<number>();
  return {
    id: e.id,
    ordinal: e.ordinal,
    done,
    textEn: e.text_en,
    words: wordsFor(e.text_en, shown),
    hintLevel: hints.length,
    isRepeat: e.repeat_of !== null,
    translationRu: hasEvent(db, e.id, "translation") && e.translation_ru.trim() ? e.translation_ru : null,
    source: e.source,
    attempts: (db.prepare("SELECT COUNT(*) AS n FROM typing_dictation_attempts WHERE exercise_id = ?").get(e.id) as { n: number }).n,
    plays: (db.prepare("SELECT COUNT(*) AS n FROM typing_dictation_events WHERE exercise_id = ? AND kind = 'play'").get(e.id) as { n: number }).n,
    audioMs: e.audio_ms,
    soundFlagged: e.source === "real" ? (db.prepare("SELECT action FROM typing_dictation_real_flags WHERE exercise_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(e.id) as { action: string } | undefined)?.action === "flag" : isSoundFlagged(db, e.id),
  };
}

function currentOrdinalOf(db: Db, lesson: LessonRow): number | null {
  const r = db
    .prepare("SELECT MIN(e.ordinal) AS o FROM typing_dictation_exercises e WHERE e.lesson_id = ? AND NOT EXISTS (SELECT 1 FROM typing_dictation_attempts a WHERE a.exercise_id = e.id AND a.correct = 1)")
    .get(lesson.id) as { o: number | null };
  return lesson.status === "completed" ? null : r.o;
}

function buildState(db: Db, lesson: LessonRow): DictationState {
  const rows = db.prepare("SELECT * FROM typing_dictation_exercises WHERE lesson_id = ? ORDER BY ordinal").all(lesson.id) as ExerciseRow[];
  const current = currentOrdinalOf(db, lesson);
  return { lessonId: lesson.id, level: lesson.level_number, status: effectiveStatus(db, lesson), currentOrdinal: current, activeMs: lesson.active_ms, exercises: rows.map((e) => exerciseState(db, e, current)) };
}

/** no side effects: the state after a reload (what Continue shows) */
export function dictationState(db: Db, lessonId: string): DictationState {
  return buildState(db, lessonRow(db, lessonId));
}

/** the stored file of an exercise, by id only (a request never names a file) */
export function exerciseAudio(db: Db, env: DictationEnv, exerciseId: string): { file: string } {
  const e = exerciseRow(db, exerciseId);
  const file = audioPathFor(env, e.audio_file);
  if (!existsSync(file)) throw new ApiError(409, "TYPING_DICTATION_AUDIO_MISSING", "The audio file is missing");
  if (e.source === "real") {
    const provenance = db.prepare("SELECT audio_sha256 AS sha FROM typing_dictation_real_provenance WHERE exercise_id = ?").get(exerciseId) as { sha: string } | undefined;
    if (!provenance || createHash("sha256").update(readFileSync(file)).digest("hex") !== provenance.sha) throw new ApiError(409, "TYPING_DICTATION_AUDIO_CHANGED", "The checked recording has changed");
  }
  return { file };
}

/* ------------------------------------------------------------------ time, play, translation */

export function recordTime(db: Db, lessonId: string, activeMs: number): { ok: true; applied: boolean } {
  const lesson = lessonRow(db, lessonId);
  // a completed lesson is frozen and a smaller value would trip the counter guard: neither is written
  if (lesson.status === "completed" || activeMs <= lesson.active_ms) return { ok: true, applied: false };
  db.prepare("UPDATE typing_dictation_lessons SET active_ms = ? WHERE id = ?").run(activeMs, lessonId);
  return { ok: true, applied: true };
}

function currentExercise(db: Db, exerciseId: string): { exercise: ExerciseRow; lesson: LessonRow } {
  const e = exerciseRow(db, exerciseId);
  const lesson = lessonRow(db, e.lesson_id);
  if (lesson.status !== "ready" && lesson.status !== "generating") throw new ApiError(409, "TYPING_DICTATION_NOT_CURRENT", "This lesson is not in progress");
  if (currentOrdinalOf(db, lesson) !== e.ordinal) throw new ApiError(409, "TYPING_DICTATION_NOT_CURRENT", "This is not the current sentence");
  return { exercise: e, lesson };
}

export function recordPlay(db: Db, deps: Deps, exerciseId: string, source: "auto" | "manual" | "wrong_answer"): { ok: true } {
  const e = exerciseRow(db, exerciseId);
  if (isDone(db, exerciseId)) return { ok: true };
  if (e.status === "completed") throw new ApiError(409, "TYPING_DICTATION_NOT_CURRENT", "The lesson is completed");
  db.prepare("INSERT INTO typing_dictation_events(id, exercise_id, kind, source, created_at) VALUES (?,?,?,?,?)").run(deps.newId(), exerciseId, "play", source, deps.now().toISOString());
  return { ok: true };
}

export function openTranslation(db: Db, deps: Deps, exerciseId: string): { translationRu: string } {
  return db
    .transaction(() => {
      const existing = exerciseRow(db, exerciseId);
      // Studying a completed sentence must not create a help event or change its awarded credit.
      if (isDone(db, exerciseId)) return { translationRu: existing.translation_ru };
      const { exercise } = currentExercise(db, exerciseId);
      if (!hasEvent(db, exercise.id, "translation")) db.prepare("INSERT INTO typing_dictation_events(id, exercise_id, kind, source, created_at) VALUES (?,?,?,?,?)").run(deps.newId(), exercise.id, "translation", "manual", deps.now().toISOString());
      return { translationRu: exercise.translation_ru };
    })
    .immediate();
}

/* ------------------------------------------------------------------ hints */

/**
 * Manual hints reveal through the first stuck word. An incorrect submitted answer records only its first
 * missing or substituted word; visibleHintWords also reveals the other errors in that answer.
 */
function writeHint(db: Db, deps: Deps, e: ExerciseRow, typedText: string, source: "manual" | "wrong_answer"): boolean {
  const words = displayWords(e.text_en);
  if (source === "wrong_answer") {
    const firstWrong = wrongAnswerWords(words, typedText)[0];
    if (firstWrong === undefined) return false; // an extra typed word has no corresponding answer word to reveal
    // The current answer is already stored, so check recorded events rather than its derived display.
    const recorded = revealedSet(hintEvents(db, e.id).map((h) => [h.reveal_from, h.reveal_to] as const));
    if (recorded.has(firstWrong)) return false;
    db.prepare("INSERT INTO typing_dictation_events(id, exercise_id, kind, source, typed_text, reveal_from, reveal_to, created_at) VALUES (?,?,?,?,?,?,?,?)").run(deps.newId(), e.id, "hint", source, typedText, firstWrong, firstWrong, deps.now().toISOString());
    return true;
  }
  let k = stuckWord(words, tokenize(typedText), rawTokens(typedText));
  if (k === null) {
    return false;
  }
  const hints = hintEvents(db, e.id);
  const shown = visibleHintWords(db, e, hints);
  if (Array.from({ length: k + 1 }, (_, i) => i).every((i) => shown.has(i))) return false;
  db.prepare("INSERT INTO typing_dictation_events(id, exercise_id, kind, source, typed_text, reveal_from, reveal_to, created_at) VALUES (?,?,?,?,?,?,?,?)").run(deps.newId(), e.id, "hint", source, typedText, 0, k, deps.now().toISOString());
  return true;
}

function hintView(db: Db, e: ExerciseRow): { hintLevel: number; words: DictationWord[] } {
  const hints = hintEvents(db, e.id);
  return { hintLevel: hints.length, words: wordsFor(e.text_en, visibleHintWords(db, e, hints)) };
}

export function requestHint(db: Db, deps: Deps, exerciseId: string, typedText: string): DictationHintResponse {
  return db
    .transaction((): DictationHintResponse => {
      const { exercise } = currentExercise(db, exerciseId);
      const wrote = writeHint(db, deps, exercise, typedText, "manual");
      return { applied: wrote, ...hintView(db, exercise) };
    })
    .immediate();
}

/** F5: the whole sentence on request; it still has to be typed, and it earns no credit */
export function revealAnswer(db: Db, deps: Deps, exerciseId: string): DictationHintResponse {
  return db
    .transaction((): DictationHintResponse => {
      const { exercise } = currentExercise(db, exerciseId);
      const done = db.prepare("SELECT 1 FROM typing_dictation_events WHERE exercise_id = ? AND reveal_all = 1").get(exercise.id) !== undefined;
      if (!done) {
        const n = displayWords(exercise.text_en).length;
        db.prepare("INSERT INTO typing_dictation_events(id, exercise_id, kind, source, typed_text, reveal_from, reveal_to, reveal_all, created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(deps.newId(), exercise.id, "hint", "manual", "", 0, n - 1, 1, deps.now().toISOString());
      }
      return { applied: !done, ...hintView(db, exercise) };
    })
    .immediate();
}

/* ------------------------------------------------------------------ answers and XP */

/**
 * Credit for one sentence (0..1), from the raw attempts and events: one word error in a wrong answer costs 1/words of it, a hint asked for
 * with F4 half of that, the Russian translation caps it at one half, showing the whole answer (F5) takes it all.
 */
export function exerciseCoefficient(db: Db, exerciseId: string): number {
  const e = db.prepare("SELECT word_count AS n FROM typing_dictation_exercises WHERE id = ?").get(exerciseId) as { n: number };
  const wrong = (db.prepare("SELECT COALESCE(SUM(word_errors), 0) AS n FROM typing_dictation_attempts WHERE exercise_id = ? AND correct = 0").get(exerciseId) as { n: number }).n;
  const asked = (db.prepare("SELECT COUNT(*) AS n FROM typing_dictation_events WHERE exercise_id = ? AND kind = 'hint' AND source = 'manual' AND reveal_all = 0").get(exerciseId) as { n: number }).n;
  const revealed = db.prepare("SELECT 1 FROM typing_dictation_events WHERE exercise_id = ? AND reveal_all = 1").get(exerciseId) !== undefined;
  if (revealed) return 0;
  const cap = hasEvent(db, exerciseId, "translation") ? DICTATION_TRANSLATION_COEFFICIENT : 1;
  return Math.round(Math.min(cap, Math.max(0, 1 - (wrong + asked * DICTATION_HINT_COST) / e.n)) * 100) / 100;
}

interface AttemptRow {
  id: string;
  exercise_id: string;
  attempt_no: number;
  answer_text: string;
  correct: number;
  word_errors: number;
  hint_level: number;
  translation_seen: number;
}

function answerResponse(db: Db, e: ExerciseRow, attempt: AttemptRow): DictationAnswerResponse {
  const lesson = lessonRow(db, e.lesson_id);
  const view = hintView(db, e);
  const xp = db.prepare("SELECT amount FROM typing_dictation_xp_events WHERE exercise_id = ?").get(e.id) as { amount: number } | undefined;
  const correct = attempt.correct === 1;
  const next = correct ? currentOrdinalOf(db, lesson) : e.ordinal;
  return { correct, xpAwarded: correct ? (xp?.amount ?? 0) : 0, lessonCompleted: correct && lesson.status === "completed", hintLevel: view.hintLevel, words: correct ? wordsFor(e.text_en, "all") : view.words, nextOrdinal: correct ? next : e.ordinal };
}

export function submitAnswer(db: Db, deps: Deps, exerciseId: string, input: { attemptId: string; text: string; activeMs: number; typingMs?: number | undefined; keystrokes?: number | undefined; keyTimes?: ReadonlyArray<{ letter: string; ms: number; timed: number }> | undefined }): DictationAnswerResponse {
  return db
    .transaction((): DictationAnswerResponse => {
      const e = exerciseRow(db, exerciseId);
      const replay = db.prepare("SELECT * FROM typing_dictation_attempts WHERE id = ?").get(input.attemptId) as AttemptRow | undefined;
      if (replay) {
        if (replay.exercise_id !== exerciseId) throw new ApiError(409, "TYPING_DICTATION_ATTEMPT_CONFLICT", "That attempt id belongs to another sentence");
        return answerResponse(db, e, replay);
      }
      const { exercise, lesson } = currentExercise(db, exerciseId);
      if (lesson.status !== "ready") throw new ApiError(409, "TYPING_DICTATION_NOT_CURRENT", "This lesson is not in progress");
      const expected = tokenize(exercise.text_en);
      const typed = tokenize(input.text);
      const errors = wordDistance(expected, typed);
      const correct = errors === 0 && isCorrect(exercise.text_en, input.text);
      const hintLevel = Math.min(3, hintEvents(db, exercise.id).length); // the stored column holds 0..3 ("3" means three or more)
      const translationSeen = hasEvent(db, exercise.id, "translation");
      const attemptNo = (db.prepare("SELECT COALESCE(MAX(attempt_no), 0) + 1 AS n FROM typing_dictation_attempts WHERE exercise_id = ?").get(exercise.id) as { n: number }).n;
      const now = deps.now().toISOString();
      db.prepare("INSERT INTO typing_dictation_attempts(id, exercise_id, attempt_no, answer_text, correct, word_errors, hint_level, translation_seen, check_version, typing_ms, keystrokes, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(
        input.attemptId,
        exercise.id,
        attemptNo,
        input.text,
        correct ? 1 : 0,
        errors,
        hintLevel,
        translationSeen ? 1 : 0,
        DICTATION_CHECK_VERSION,
        input.typingMs ?? null,
        input.keystrokes ?? null,
        now,
      );
      // per-key facts for the Keys analytics: hits and misses from the answer, timing from the page
      const letterFacts = answerLetterFacts(exercise.text_en, input.text);
      const timing = new Map((input.keyTimes ?? []).map((k) => [k.letter, k]));
      const putKey = db.prepare("INSERT INTO typing_dictation_keys(id, attempt_id, letter, hits, misses, total_ms, timed) VALUES (?,?,?,?,?,?,?)");
      for (const letter of new Set([...letterFacts.keys(), ...timing.keys()])) {
        const f = letterFacts.get(letter) ?? { hits: 0, misses: 0 };
        const t = timing.get(letter);
        if (f.hits + f.misses === 0) continue;
        const timed = t ? Math.min(t.timed, f.hits + f.misses) : 0;
        putKey.run(deps.newId(), input.attemptId, letter, f.hits, f.misses, t && t.timed > 0 ? Math.round((t.ms * timed) / t.timed) : 0, timed);
      }
      if (input.activeMs > lesson.active_ms) db.prepare("UPDATE typing_dictation_lessons SET active_ms = ? WHERE id = ?").run(input.activeMs, lesson.id);
      if (!correct) {
        writeHint(db, deps, exercise, input.text, "wrong_answer");
      } else {
        const coefficient = exerciseCoefficient(db, exercise.id);
        const amount = Math.round(DICTATION_XP_PER_EXERCISE * coefficient);
        if (amount > 0) db.prepare("INSERT INTO typing_dictation_xp_events(id, exercise_id, amount, coefficient, rule_version, created_at) VALUES (?,?,?,?,?,?)").run(deps.newId(), exercise.id, amount, coefficient, DICTATION_XP_VERSION, now);
        const remaining = (db.prepare("SELECT COUNT(*) AS n FROM typing_dictation_exercises e WHERE e.lesson_id = ? AND NOT EXISTS (SELECT 1 FROM typing_dictation_attempts a WHERE a.exercise_id = e.id AND a.correct = 1)").get(lesson.id) as { n: number }).n;
        if (remaining === 0 && readyCount(db, lesson.id) === lesson.exercise_count) db.prepare("UPDATE typing_dictation_lessons SET status = 'completed', completed_at = ? WHERE id = ?").run(now, lesson.id);
      }
      const saved = db.prepare("SELECT * FROM typing_dictation_attempts WHERE id = ?").get(input.attemptId) as AttemptRow;
      return answerResponse(db, exercise, saved);
    })
    .immediate();
}
