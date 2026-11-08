import { WordLessonContentSchema, type WordLessonContent, type WordLessonFeedback, type WordLessonVerdictKind } from "@english-lab/contracts";
import type { Db } from "../../db/open.js";
import { ApiError } from "../../errors.js";
import type { SenseSnapshot } from "./runner.js";
import { lessonWord, type LessonWord } from "./validate.js";

export interface LoadedRun {
  id: string;
  lessonId: string;
  entryId: string;
  lemma: string;
  tabId: string;
  seed: number;
  status: "active" | "completed";
  startedAt: string;
  completedAt: string | null;
  score: number | null;
  scoreJson: unknown;
  content: WordLessonContent;
  sense: SenseSnapshot;
  word: LessonWord;
}

export function loadRun(db: Db, runId: string): LoadedRun {
  const r = db
    .prepare(
      `SELECT r.id, r.lesson_id AS lessonId, r.tab_id AS tabId, r.seed, r.status, r.started_at AS startedAt, r.completed_at AS completedAt, r.score, r.score_json AS scoreJson,
              l.entry_id AS entryId, l.lemma, l.content_json AS content, l.sense_json AS sense
         FROM word_lesson_runs r JOIN word_lessons l ON l.id = r.lesson_id WHERE r.id = ?`,
    )
    .get(runId) as (Omit<LoadedRun, "content" | "sense" | "word" | "scoreJson"> & { content: string | null; sense: string; scoreJson: string | null }) | undefined;
  if (!r || !r.content) throw new ApiError(404, "WORD_LESSON_RUN_NOT_FOUND", "Unknown lesson run");
  const content = WordLessonContentSchema.parse(JSON.parse(r.content));
  const sense = JSON.parse(r.sense) as SenseSnapshot;
  return { ...r, scoreJson: r.scoreJson ? JSON.parse(r.scoreJson) : null, content, sense, word: lessonWord(r.lemma, sense.surfaceForms, sense.irregularForms) };
}

/** the tasks of a lesson in order: the passive stage first, then every task the learner answers */
export function itemKeys(c: WordLessonContent): string[] {
  return ["s1", "s2", ...c.stage3.items.map((i) => i.id), "s4", "s5"];
}

export const stageOfKey = (key: string): 1 | 2 | 3 | 4 | 5 => (key === "s1" ? 1 : key === "s2" ? 2 : key.startsWith("s3.") ? 3 : key === "s4" ? 4 : 5);

export interface Task {
  key: string;
  stage: 2 | 3 | 4 | 5;
  /** sentences (stage 3-5) or forms (stage 2) that are right as they stand */
  accepted: string[];
  /** the answer shown after help or an unchecked answer */
  reference: string;
  /** the task as the checking model is told about it */
  brief: Record<string, unknown>;
}

export function taskOf(c: WordLessonContent, key: string): Task {
  if (key === "s2") return { key, stage: 2, accepted: c.stage2.accepted_forms, reference: c.stage2.accepted_forms[0]!, brief: { gapped_en: c.stage2.gapped_en } };
  if (key.startsWith("s3.")) {
    const t = c.stage3.items.find((i) => i.id === key);
    if (!t) throw new ApiError(404, "WORD_LESSON_ITEM_NOT_FOUND", "Unknown task");
    return { key, stage: 3, accepted: t.accepted_en, reference: t.expected_en, brief: { construction: t.construction_en, instruction: t.instruction_en, source_sentence: t.source_en } };
  }
  if (key === "s4") return { key, stage: 4, accepted: c.stage4.accepted_en, reference: c.stage4.expected_en, brief: { construction: c.stage4.construction_en, pattern: c.stage4.pattern, idea_ru: c.stage4.cue_ru } };
  if (key === "s5") return { key, stage: 5, accepted: [], reference: c.stage5.sample_en, brief: { situation: c.stage5.situation_en, suggested_words: c.stage5.suggested_words } };
  throw new ApiError(404, "WORD_LESSON_ITEM_NOT_FOUND", "Unknown task");
}

export const emptyFeedback = (note: string | null = null): WordLessonFeedback => ({ issues: [], correctedEn: null, commentRu: null, note });

export interface VerdictRow {
  id: string;
  sequence: number;
  verdict: WordLessonVerdictKind;
  source: "code" | "model" | "learner";
  feedback: WordLessonFeedback;
  createdAt: string;
}

/** all verdicts of an attempt, oldest first; the last is the current one */
export function verdictsOf(db: Db, attemptId: string): VerdictRow[] {
  return (db.prepare("SELECT id, sequence, verdict, source, feedback_json AS f, created_at AS createdAt FROM word_lesson_verdicts WHERE attempt_id = ? ORDER BY sequence").all(attemptId) as Array<{ id: string; sequence: number; verdict: WordLessonVerdictKind; source: VerdictRow["source"]; f: string; createdAt: string }>).map((v) => ({
    id: v.id,
    sequence: v.sequence,
    verdict: v.verdict,
    source: v.source,
    feedback: JSON.parse(v.f) as WordLessonFeedback,
    createdAt: v.createdAt,
  }));
}

/** appends the next verdict of an attempt (must run inside the caller's transaction) */
export function appendVerdict(db: Db, newId: () => string, now: Date, attemptId: string, v: { verdict: WordLessonVerdictKind; source: VerdictRow["source"]; feedback: WordLessonFeedback; modelVersionId?: string | null; jobResultId?: string | null }): number {
  const seq = (db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS n FROM word_lesson_verdicts WHERE attempt_id = ?").get(attemptId) as { n: number }).n;
  db.prepare("INSERT INTO word_lesson_verdicts(id, attempt_id, sequence, verdict, source, feedback_json, model_version_id, job_result_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(newId(), attemptId, seq, v.verdict, v.source, JSON.stringify(v.feedback), v.modelVersionId ?? null, v.jobResultId ?? null, now.toISOString());
  return seq;
}

export const checkJobKey = (attemptId: string): string => `word-lesson-check:${attemptId}`;
