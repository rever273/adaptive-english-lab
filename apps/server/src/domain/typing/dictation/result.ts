import { DICTATION_METRICS_VERSION, type DictationResult } from "@english-lab/contracts";
import type { Db } from "../../../db/open.js";
import { ApiError } from "../../../errors.js";
import { alignWords, tokenize } from "./check.js";
import { classifyAnswer } from "./errorTypes.js";
import { exerciseCoefficient } from "./lessons.js";

interface Row {
  id: string;
  ordinal: number;
  text_en: string;
  translation_ru: string;
  topic: string;
  target_skill_id: string | null;
  voice_name: string | null;
  source: "tts";
}

/** typing speed from correct characters and the time spent typing; null without timing */
export const wpmOf = (chars: number, ms: number): number | null => (ms > 0 && chars > 0 ? Math.round((chars / 5 / (ms / 60000)) * 10) / 10 : null);
export const cpmOf = (chars: number, ms: number): number | null => (ms > 0 && chars > 0 ? Math.round(chars / (ms / 60000)) : null);

const count = (db: Db, sql: string, ...args: unknown[]): number => (db.prepare(sql).get(...args) as { n: number }).n;

/** Everything is derived on read from the raw attempts and events (never stored): the result of a completed lesson, with the first answer beside the original. */
export function buildDictationResult(db: Db, lessonId: string): DictationResult {
  const lesson = db.prepare("SELECT id, level_number, status, active_ms FROM typing_dictation_lessons WHERE id = ?").get(lessonId) as { id: string; level_number: number; status: string; active_ms: number } | undefined;
  if (!lesson) throw new ApiError(404, "TYPING_DICTATION_LESSON_NOT_FOUND", "Unknown dictation lesson");
  if (lesson.status !== "completed") throw new ApiError(409, "TYPING_DICTATION_NOT_COMPLETED", "The result is available when every sentence is correct");
  const rows = db.prepare("SELECT id, ordinal, text_en, translation_ru, topic, target_skill_id, voice_name, source FROM typing_dictation_exercises WHERE lesson_id = ? ORDER BY ordinal").all(lessonId) as Row[];

  let firstAttemptCorrect = 0;
  let noHelp = 0;
  let partial = 0;
  let fullReveal = 0;
  let wrongSubmissions = 0;
  let plays = 0;
  let manualReplays = 0;
  let coefficientSum = 0;
  const items = rows.map((r) => {
    const first = db.prepare("SELECT answer_text, correct FROM typing_dictation_attempts WHERE exercise_id = ? AND attempt_no = 1").get(r.id) as { answer_text: string; correct: number };
    const attempts = count(db, "SELECT COUNT(*) AS n FROM typing_dictation_attempts WHERE exercise_id = ?", r.id);
    const exercisePlays = count(db, "SELECT COUNT(*) AS n FROM typing_dictation_events WHERE exercise_id = ? AND kind = 'play'", r.id);
    const coefficient = exerciseCoefficient(db, r.id);
    const outcome = coefficient === 1 ? "no_help" : coefficient > 0 ? "partial" : "full_reveal";
    coefficientSum += coefficient;
    if (first.correct === 1) firstAttemptCorrect++;
    if (outcome === "no_help") noHelp++;
    else if (outcome === "partial") partial++;
    else fullReveal++;
    wrongSubmissions += attempts - 1;
    plays += exercisePlays;
    manualReplays += count(db, "SELECT COUNT(*) AS n FROM typing_dictation_events WHERE exercise_id = ? AND kind = 'play' AND source = 'manual'", r.id);
    return {
      ordinal: r.ordinal,
      textEn: r.text_en,
      translationRu: r.translation_ru,
      topic: r.topic,
      targetSkillId: r.target_skill_id,
      voiceName: r.voice_name,
      source: r.source,
      plays: exercisePlays,
      attempts,
      maxHintLevel: count(db, "SELECT COUNT(*) AS n FROM typing_dictation_events WHERE exercise_id = ? AND kind = 'hint'", r.id),
      outcome: outcome as "no_help" | "partial" | "full_reveal",
      firstAnswer: first.answer_text,
      diff: alignWords(tokenize(r.text_en), tokenize(first.answer_text)).ops,
      errorTypes: first.correct === 1 ? [] : classifyAnswer(r.text_en, first.answer_text),
    };
  });
  const speed = db.prepare(
    `SELECT COALESCE(SUM(length(c.answer_text)), 0) AS chars,
            COALESCE(SUM((SELECT COALESCE(SUM(t.typing_ms), 0) FROM typing_dictation_attempts t WHERE t.exercise_id = e.id)), 0) AS ms
       FROM typing_dictation_exercises e JOIN typing_dictation_attempts c ON c.exercise_id = e.id AND c.correct = 1 WHERE e.lesson_id = ?`,
  ).get(lessonId) as { chars: number; ms: number };
  const xp = count(db, "SELECT COALESCE(SUM(x.amount), 0) AS n FROM typing_dictation_xp_events x JOIN typing_dictation_exercises e ON e.id = x.exercise_id WHERE e.lesson_id = ?", lessonId);
  return {
    lessonId,
    level: lesson.level_number,
    sentences: rows.length,
    activeMs: lesson.active_ms,
    score: Math.round((100 * coefficientSum) / rows.length),
    wpm: wpmOf(speed.chars, speed.ms),
    cpm: cpmOf(speed.chars, speed.ms),
    typingMs: Math.round(speed.ms),
    xpAwarded: xp,
    firstAttemptCorrect,
    noHelp,
    partial,
    fullReveal,
    wrongSubmissions,
    plays,
    manualReplays,
    avgPlaysPerSentence: Math.round((plays / rows.length) * 10) / 10,
    metricsVersion: DICTATION_METRICS_VERSION,
    items,
  };
}
