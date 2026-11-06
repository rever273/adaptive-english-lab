import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spellNumbers } from "@english-lab/contracts";
import type { Db } from "../../../db/open.js";
import { TtsError } from "../../../adapters/tts/piper.js";
import { RunnerError, type RunnerContext, type RunnerOutput } from "../../../queue/types.js";
import type { ChatClient } from "../../ai/clients.js";
import { runStructured } from "../../ai/structured.js";
import { fingerprintOf, jaccard, normalizeSentence, trigrams } from "../../content/normalize.js";
import { AsrError } from "./asr.js";
import { dictationFingerprint, tokenize, wordDistance } from "./check.js";
import { markReadyIfComplete, type DictationEnv, type Deps, type LessonPlan, type PlanItem } from "./lessons.js";
import type { Voice } from "../../voices/catalog.js";
import { modelShaOpt } from "../../voices/model.js";
import type { VoiceOutcome } from "../../voices/service.js";
import { DICTATION_SYSTEM_V3, dictationFormat, validateDictationOutput } from "./prompt.js";
import { checkSentence, checkWav, type RejectCode } from "./quality.js";

/** one sentence of a lesson */
export interface DictationPayload {
  dictationLessonId: string;
  ordinal: number;
  attempt: number;
  /** the audio file is gone (a restored backup): voice the saved sentence again, no new text, no new check */
  resynthesize?: boolean;
}
/** one prepared track (the "Prepare tracks" button): the same work, stored for later lessons */
export interface DictationPoolPayload {
  dictationPool: 1;
  batch: string;
  index: number;
  item: PlanItem;
}
export type DictationJobPayload = DictationPayload | DictationPoolPayload;

export const NEAR_DUPLICATE_JACCARD = 0.8;
export const SENTENCE_TRIES = 3;
export const VOICES_PER_SENTENCE = 2;

export interface DictationRunnerDeps {
  db: Db;
  chat: ChatClient;
  model: { tag: string; digest: string };
  params: { numCtx: number; temperature: number; seed: number };
  env: DictationEnv;
  deps: Deps;
  /** throws a RunnerError when the installed model differs from the pinned one */
  assertModel: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

interface LessonRow {
  id: string;
  status: string;
  exercise_count: number;
  settings_json: string;
  plan_json: string;
}

export { MIN_LENGTH_SCALE, speedFactor, variedLengthScale } from "../../voices/speed.js";

/** no-repeat (D90): earlier dictations and prepared tracks, the whole exercise bank (diagnostic and held-out sentences too), and near-duplicates */
export function duplicateReason(db: Db, text: string): RejectCode | null {
  const fp = dictationFingerprint(text);
  if (db.prepare("SELECT 1 FROM typing_dictation_exercises WHERE fingerprint = ?").get(fp) || db.prepare("SELECT 1 FROM typing_dictation_pool WHERE fingerprint = ?").get(fp)) return "DUPLICATE";
  const normalized = normalizeSentence(text);
  if (db.prepare("SELECT 1 FROM prompt_units WHERE fingerprint = ? LIMIT 1").get(fingerprintOf(normalized))) return "SAME_AS_BANK";
  const grams = trigrams(normalized);
  for (const r of db.prepare("SELECT text_en FROM typing_dictation_exercises UNION SELECT text_en FROM typing_dictation_pool").all() as Array<{ text_en: string }>) {
    if (jaccard(grams, trigrams(normalizeSentence(r.text_en))) >= NEAR_DUPLICATE_JACCARD) return "NEAR_DUPLICATE";
  }
  return null;
}

/** openings that models fall back on; one of them is allowed again only when none of the recent sentences used it */
const CRUTCH_OPENINGS = [/^i decided to\b/, /^i stopped\b/, /^i usually\b/, /^i have always wanted to\b/, /^i['\u2019]ve always wanted to\b/, /^the most important thing is\b/];
const RECENT_FOR_OPENINGS = 40;

/** what the learner would notice first: the same beginning again and again (checked in code against the recent sentences, no extra AI call) */
export function openingIssue(db: Db, text: string): boolean {
  const recent = (db.prepare(`SELECT text_en FROM (SELECT text_en, created_at FROM typing_dictation_exercises UNION ALL SELECT text_en, created_at FROM typing_dictation_pool) ORDER BY created_at DESC LIMIT ${RECENT_FOR_OPENINGS}`).all() as Array<{ text_en: string }>).map((r) => r.text_en.toLowerCase().replace(/[\u2018\u2019]/g, "'").trim());
  const mine = text.toLowerCase().replace(/[\u2018\u2019]/g, "'").trim();
  const words = (t: string) => t.split(/\s+/).slice(0, 2).join(" ");
  if (recent.some((t) => words(t) === words(mine))) return true;
  // the same first word three times in the last ten (not for "the", "a", "my", "our": a subject such as "the teacher" starts that way by nature)
  const first = mine.split(/\s+/)[0]!;
  if (!["the", "a", "an", "my", "our", "their"].includes(first) && recent.slice(0, 10).filter((t) => t.split(/\s+/)[0] === first).length >= 3) return true;
  return CRUTCH_OPENINGS.some((re) => re.test(mine) && recent.some((t) => re.test(t)));
}

/** the topic is the context, not a phrase to say: a topic of several words must not appear in the sentence as written */
export function namesTopic(topic: string, text: string): boolean {
  const t = topic.toLowerCase().trim();
  return t.includes(" ") && text.toLowerCase().replace(/[\u2018\u2019]/g, "'").includes(t);
}

const audioFileName = (text: string, voice: Voice, modelSha: string): string => {
  // the noise settings are part of the name only when they are set, so audio made before they existed keeps its name
  const noise = voice.noiseScale !== null || voice.noiseWScale !== null ? `|${voice.noiseScale ?? ""}|${voice.noiseWScale ?? ""}` : "";
  return `${createHash("sha256").update(`${tokenize(text).join(" ")}|${voice.id}|${voice.lengthScale}|${modelSha}${noise}`).digest("hex")}.wav`;
};

function writeAtomic(dir: string, file: string, wav: Buffer): void {
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, file);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, wav);
  renameSync(tmp, target);
}

function mapTransport(e: unknown): never {
  if (e instanceof RunnerError) throw e;
  if (e instanceof AsrError) throw new RunnerError(e.code, e.message, e.transient);
  if (e instanceof TtsError) throw new RunnerError(e.code, e.message, e.transient);
  throw e;
}

interface Produced {
  textEn: string;
  translationRu: string;
  /** the voice with the pace really used for this sentence */
  voice: Voice;
  file: string;
  audioMs: number;
  tokenCount: number;
  asr: { text: string; model: string };
  modelSha: string;
  calls: number;
  repaired: number;
  rejected: Array<{ code: RejectCode; voice?: string; voiceKey?: string; sentenceTry?: number; asrText?: string }>;
  sentenceTries: number;
  /** every voiced attempt of one sentence shares a group, for the statistics (D127) */
  attemptGroup: string;
}

/** every voiced attempt of this sentence, for the voice statistics: one group per sentence try, so a sentence nobody could say is told apart from one voice's slip (D127) */
function voiceOutcomes(p: Produced): Array<{ key: string; purpose: "dictation"; outcome: VoiceOutcome; attemptGroup: string; heardText?: string }> {
  const out: Array<{ key: string; purpose: "dictation"; outcome: VoiceOutcome; attemptGroup: string; heardText?: string }> = [{ key: p.voice.key, purpose: "dictation", outcome: "ok", attemptGroup: `${p.attemptGroup}:${p.sentenceTries}`, heardText: p.asr.text }];
  for (const r of p.rejected) {
    if (!r.voiceKey || r.sentenceTry === undefined) continue;
    const outcome = r.code === "ASR_MISMATCH" ? "asr_mismatch" : r.code === "WAV_INVALID" ? "wav_invalid" : r.code === "WAV_LENGTH" ? "wav_length" : null;
    if (outcome) out.push({ key: r.voiceKey, purpose: "dictation", outcome, attemptGroup: `${p.attemptGroup}:${r.sentenceTry}`, ...(r.asrText ? { heardText: r.asrText } : {}) });
  }
  return out;
}

/**
 * One finished sentence: Gemma writes it, code checks it (length, characters, repeats, the saved word), Piper voices it and Whisper must
 * hear exactly that text (D97). A voice that fails gets one replacement; a sentence that fails twice is dropped for a new one.
 */
async function produceSentence(
  ctx: RunnerContext<DictationJobPayload>,
  d: DictationRunnerDeps,
  o: { item: PlanItem; recent: string[]; cefrMin: string; cefrMax: string; attempt: number; speedKey: string; progress: (phase: "text" | "audio" | "verify") => void },
): Promise<Produced> {
  const { db, env } = d;
  const tts = env.tts.available();
  if (!tts.ok) throw new RunnerError(tts.reason, `Audio Dictation cannot voice sentences (${tts.reason}); run npm run dictation:setup`, false);
  if (!env.asr.available()) throw new RunnerError("asr_unavailable", "No speech recognition is available to check the audio (set a Groq key or install the local model)", false);
  await d.assertModel();
  const known = env.voices.bySpeaker(db, o.item.voiceId);
  if (!known) throw new RunnerError("bad_plan", "the planned voice is unknown", false);
  const voiceOpts = { purpose: "dictation" as const, ...modelShaOpt(env.tts) };
  // a voice switched off (or no longer meant for dictation) since the plan was made is replaced by another one
  const planned = known.enabled && known.purposes.includes("dictation") ? known : env.voices.pick(db, { ...voiceOpts, seed: o.speedKey, ...(o.item.topicGroup ? { topicGroup: o.item.topicGroup } : {}) });
  if (!planned) throw new RunnerError("bad_plan", "no voice is switched on for Audio Dictation", false);
  const attemptGroup = d.deps.newId();
  const rejected: Produced["rejected"] = [];
  let calls = 0;
  let repaired = 0;
  const forms = (o.item.vocabularyForms ?? []).map((f) => f.toLowerCase());

  for (let sentenceTry = 1; sentenceTry <= SENTENCE_TRIES; sentenceTry++) {
    o.progress("text");
    const result = await runStructured({
      client: d.chat,
      model: d.model.tag,
      messages: [
        { role: "system", content: DICTATION_SYSTEM_V3 },
        { role: "user", content: JSON.stringify({ topic: o.item.topic, cefr_min: o.cefrMin, cefr_max: o.cefrMax, grammar: o.item.grammar ?? o.item.targetSkillLabel ?? null, intent: o.item.intent ?? null, register: o.item.register ?? "neutral", subject: o.item.subject ?? null, target_words: o.item.targetWords ?? 10, must_include_word: o.item.vocabularyLemma ?? null, recent_sentences: o.recent }) },
      ],
      format: dictationFormat(),
      options: { num_ctx: d.params.numCtx, num_predict: 512, temperature: d.params.temperature, seed: d.params.seed + o.attempt * 100 + sentenceTry + ctx.job.retryCount * 10 },
      validate: validateDictationOutput,
      signal: ctx.signal,
      sleep: d.sleep,
    });
    calls += result.usage.calls;
    if (result.usage.repaired) repaired++;
    if (!result.ok) {
      if (result.code === "transport_failed") throw new RunnerError("transport_failed", result.issues.map((i) => `${i.code}: ${i.message}`).join("; ").slice(0, 300), true);
      continue; // the model could not keep to the shape: another sentence
    }
    const { textEn, translationRu } = result.value;
    const expected = tokenize(textEn);
    let issue: RejectCode | null = checkSentence(textEn, translationRu) ?? duplicateReason(db, textEn);
    if (!issue && namesTopic(o.item.topic, textEn)) issue = "TOPIC_NAME";
    if (!issue && openingIssue(db, textEn)) issue = "OPENING_REPEAT";
    if (!issue && forms.length > 0 && !expected.some((t) => forms.includes(t))) issue = "WORD_MISSING";
    if (issue) {
      rejected.push({ code: issue });
      continue;
    }
    const second = env.voices.alternative(db, { ...voiceOpts, failed: [planned.key], seed: `${o.speedKey}:${sentenceTry}`, ...(o.item.topicGroup ? { topicGroup: o.item.topicGroup } : {}) });
    const voices = [planned, second]
      .filter((v): v is Voice => v !== null)
      .slice(0, VOICES_PER_SENTENCE)
      .map((v) => ({ ...v, lengthScale: env.voices.synthesisParams(v, `${o.speedKey}:${sentenceTry}`).lengthScale })); // the stored length_scale is the one really used
    for (const voice of voices) {
      if (ctx.signal.aborted) throw new DOMException("aborted", "AbortError");
      let wav: Buffer;
      let audioMs: number;
      let heard: { text: string; model: string };
      try {
        o.progress("audio");
        const raw = await env.tts.synthesize({ text: textEn, ...env.voices.synthesisParams(voice), signal: ctx.signal });
        const checked = checkWav(raw, expected.length);
        if (!checked.ok) {
          rejected.push({ code: checked.code, voice: voice.name, voiceKey: voice.key, sentenceTry });
          continue;
        }
        wav = checked.wav;
        audioMs = checked.audioMs;
        o.progress("verify");
        heard = await env.asr.transcribe(wav, ctx.signal);
      } catch (e) {
        if (ctx.signal.aborted || (e as Error).name === "AbortError") throw e;
        mapTransport(e);
      }
      // the check may write "10" for the spoken "ten" (D127)
      if (wordDistance(expected, tokenize(spellNumbers(heard.text))) !== 0) {
        rejected.push({ code: "ASR_MISMATCH", voice: voice.name, voiceKey: voice.key, sentenceTry, asrText: heard.text.slice(0, 300) });
        continue;
      }
      const file = audioFileName(textEn, voice, tts.modelSha256);
      writeAtomic(env.audioDir, file, wav);
      return { textEn, translationRu, voice, file, audioMs, tokenCount: expected.length, asr: heard, modelSha: tts.modelSha256, calls, repaired, rejected, sentenceTries: sentenceTry, attemptGroup };
    }
    rejected.push({ code: "SENTENCE_DROPPED" });
  }
  const codes = [...new Set(rejected.map((r) => r.code))];
  throw new RunnerError("failed_validation", `no sentence for ${o.item.topic} passed the checks in ${SENTENCE_TRIES} tries (${codes.join(", ")})`, true, codes);
}

const recentTexts = (db: Db, lessonId: string | null): string[] =>
  (
    db
      .prepare(lessonId ? "SELECT text_en FROM typing_dictation_exercises WHERE lesson_id = ? ORDER BY ordinal DESC LIMIT 10" : "SELECT text_en FROM typing_dictation_pool ORDER BY created_at DESC, rowid DESC LIMIT 10")
      .all(...(lessonId ? [lessonId] : [])) as Array<{ text_en: string }>
  ).map((r) => r.text_en);

const settingsCefr = (json: string): { cefrMin: string; cefrMax: string } => {
  const s = JSON.parse(json) as { difficultyMin?: string; difficultyMax?: string };
  return { cefrMin: s.difficultyMin ?? (s.difficultyMax ? "A2" : "B1"), cefrMax: s.difficultyMax ?? "C1" };
};

/** a prepared track: the same work as a lesson sentence, stored in the pool for the next lessons */
async function runPoolJob(ctx: RunnerContext<DictationPoolPayload>, d: DictationRunnerDeps): Promise<RunnerOutput> {
  const { batch, index, item } = ctx.job.payload;
  const { db } = d;
  const latest = db.prepare("SELECT values_json AS v FROM settings_revisions ORDER BY revision DESC LIMIT 1").get() as { v: string } | undefined;
  const total = (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE json_extract(payload_json, '$.batch') = ?").get(batch) as { n: number }).n;
  const done = (): number => (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE json_extract(payload_json, '$.batch') = ? AND state = 'completed'").get(batch) as { n: number }).n;
  const p = await produceSentence(ctx, d, {
    item,
    recent: recentTexts(db, null),
    ...settingsCefr(latest?.v ?? "{}"),
    attempt: 1,
    speedKey: `pool:${batch}:${index}`,
    progress: (phase) => ctx.checkpoint({ done: done(), total, phase }),
  });
  const id = d.deps.newId();
  const now = d.deps.now().toISOString();
  return {
    schemaVersion: "dictation-v2",
    output: { pool: true, batch, index, voice: p.voice.name, sentenceTries: p.sentenceTries },
    metrics: { calls: p.calls, repaired: p.repaired, rejected: p.rejected, sentenceTries: p.sentenceTries, asrModel: p.asr.model },
    alsoCommit: (tx) => {
      const fp = dictationFingerprint(p.textEn);
      if (tx.prepare("SELECT 1 FROM typing_dictation_pool WHERE fingerprint = ?").get(fp) || tx.prepare("SELECT 1 FROM typing_dictation_exercises WHERE fingerprint = ?").get(fp)) return; // delivered twice
      const jr = tx.prepare("SELECT id FROM job_results WHERE job_id = ?").get(ctx.job.id) as { id: string } | undefined;
      tx.prepare(
        `INSERT INTO typing_dictation_pool(id, text_en, translation_ru, topic, target_skill_id, vocabulary_entry_id, word_count, fingerprint, voice_id, voice_name, length_scale, tts_model_sha256, audio_file, audio_ms, asr_model, asr_text, status, job_result_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(id, p.textEn, p.translationRu, item.topic, item.targetSkillId, item.vocabularyEntryId ?? null, p.tokenCount, fp, p.voice.id, p.voice.name, p.voice.lengthScale, p.modelSha, p.file, p.audioMs, p.asr.model, p.asr.text, "validated", jr?.id ?? null, now);
      d.env.voices.recordChecks(tx, now, voiceOutcomes(p));
    },
  };
}

/** One sentence of a lesson, or one prepared track. Exercise (or pool row) and job result commit together. */
export async function runDictationJob(ctx: RunnerContext<DictationJobPayload>, d: DictationRunnerDeps): Promise<RunnerOutput> {
  if ("dictationPool" in ctx.job.payload) return runPoolJob(ctx as RunnerContext<DictationPoolPayload>, d);
  const payload = ctx.job.payload as DictationPayload;
  const { dictationLessonId: lessonId, ordinal, attempt, resynthesize } = payload;
  const { db, env } = d;
  const lesson = db.prepare("SELECT id, status, exercise_count, settings_json, plan_json FROM typing_dictation_lessons WHERE id = ?").get(lessonId) as LessonRow | undefined;
  const skipped = (reason: string): RunnerOutput => ({ schemaVersion: "dictation-v2", output: { lessonId, ordinal, skipped: reason }, metrics: { calls: 0 } });
  if (!lesson || lesson.status === "completed") return skipped("lesson_closed");
  const existing = db.prepare("SELECT id, text_en, voice_id, length_scale, audio_file, word_count, tts_model_sha256 FROM typing_dictation_exercises WHERE lesson_id = ? AND ordinal = ?").get(lessonId, ordinal) as
    | { id: string; text_en: string; voice_id: number; length_scale: number; audio_file: string; word_count: number; tts_model_sha256: string }
    | undefined;

  const tts = env.tts.available();
  if (!tts.ok) throw new RunnerError(tts.reason, `Audio Dictation cannot voice sentences (${tts.reason}); run npm run dictation:setup`, false);

  if (existing) {
    if (!resynthesize) return skipped("already_done");
    // the audio may have come back by itself meanwhile: the lesson still has to be re-evaluated
    if (existsSync(path.join(env.audioDir, existing.audio_file))) return { ...skipped("already_done"), alsoCommit: (tx) => markReadyIfComplete(tx, env, lessonId) };
    // the stored Whisper check described audio made by that model; a different voice model would be unchecked audio
    if (tts.modelSha256 !== existing.tts_model_sha256) throw new RunnerError("tts_model_changed", "The installed voice model differs from the one that voiced this sentence, so it cannot be voiced again unchecked", false);
    ctx.checkpoint({ done: ordinal, total: lesson.exercise_count, phase: "audio" });
    // the file name says which settings the checked audio was made with (noise settings are part of it only when set): only that exact audio may be remade
    const voiceNow = env.voices.bySpeaker(db, existing.voice_id);
    const asStored = voiceNow ? { ...voiceNow, lengthScale: existing.length_scale } : null;
    const plain = asStored ? { ...asStored, noiseScale: null, noiseWScale: null } : null;
    const noisy = asStored && (asStored.noiseScale !== null || asStored.noiseWScale !== null) ? asStored : null;
    const settings = [plain, noisy].find((v) => v && audioFileName(existing.text_en, v, tts.modelSha256) === existing.audio_file);
    if (!settings) throw new RunnerError("tts_settings_changed", "The voice settings changed since this sentence was checked, so it cannot be voiced again unchecked", false);
    try {
      const raw = await env.tts.synthesize({ text: existing.text_en, ...env.voices.synthesisParams(settings), signal: ctx.signal });
      const wav = checkWav(raw, existing.word_count);
      if (!wav.ok) throw new RunnerError("failed_validation", `the audio was refused (${wav.code})`, true, [wav.code]);
      writeAtomic(env.audioDir, existing.audio_file, wav.wav);
    } catch (e) {
      mapTransport(e);
    }
    return { schemaVersion: "dictation-v2", output: { lessonId, ordinal, resynthesized: true }, metrics: { calls: 0 }, alsoCommit: (tx) => markReadyIfComplete(tx, env, lessonId) };
  }

  const plan = JSON.parse(lesson.plan_json) as LessonPlan;
  const item = plan.items.find((i) => i.ordinal === ordinal);
  if (!item) throw new RunnerError("bad_plan", `the lesson plan has no sentence ${ordinal}`, false);
  const done = (): number => (db.prepare("SELECT COUNT(*) AS n FROM typing_dictation_exercises WHERE lesson_id = ?").get(lessonId) as { n: number }).n;
  const p = await produceSentence(ctx, d, {
    item,
    recent: recentTexts(db, lessonId),
    ...settingsCefr(lesson.settings_json),
    attempt,
    speedKey: `${lessonId}:${ordinal}`,
    progress: (phase) => ctx.checkpoint({ done: done(), total: lesson.exercise_count, phase }),
  });
  const exerciseId = d.deps.newId();
  const now = d.deps.now().toISOString();
  return {
    schemaVersion: "dictation-v2",
    output: { lessonId, ordinal, exerciseId, voice: p.voice.name, sentenceTries: p.sentenceTries },
    metrics: { calls: p.calls, repaired: p.repaired, rejected: p.rejected, sentenceTries: p.sentenceTries, asrModel: p.asr.model },
    alsoCommit: (tx) => {
      const lessonNow = tx.prepare("SELECT status FROM typing_dictation_lessons WHERE id = ?").get(lessonId) as { status: string } | undefined;
      if (!lessonNow || lessonNow.status === "completed") return;
      if (tx.prepare("SELECT 1 FROM typing_dictation_exercises WHERE lesson_id = ? AND ordinal = ?").get(lessonId, ordinal)) return; // delivered twice
      const jr = tx.prepare("SELECT id FROM job_results WHERE job_id = ?").get(ctx.job.id) as { id: string } | undefined;
      tx.prepare(
        `INSERT INTO typing_dictation_exercises(id, lesson_id, ordinal, text_en, translation_ru, topic, target_skill_id, word_count, fingerprint, source, voice_id, voice_name, length_scale, tts_model_sha256, audio_file, audio_ms, asr_model, asr_text, status, job_result_id, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(exerciseId, lessonId, ordinal, p.textEn, p.translationRu, item.topic, item.targetSkillId, p.tokenCount, dictationFingerprint(p.textEn), "tts", p.voice.id, p.voice.name, p.voice.lengthScale, p.modelSha, p.file, p.audioMs, p.asr.model, p.asr.text, "validated", jr?.id ?? null, now);
      env.voices.recordChecks(tx, now, voiceOutcomes(p));
      markReadyIfComplete(tx, env, lessonId);
    },
  };
}
