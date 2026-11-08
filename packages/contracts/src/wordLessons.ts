import { z } from "zod";

/** TASK_031: Single Word Context Practice. A lesson is written once by the local model and then played again and again. */
export const WORD_LESSON_SCHEMA = "word-lesson-v1";
export const WORD_LESSON_SCORE_VERSION = "word-lesson-score-v1";
export const WORD_LESSON_CHECK_VERSION = "word-lesson-check-v1";
export const WORD_LESSON_DEFAULT_COUNT = 10;
export const WORD_LESSON_MAX_COUNT = 50;

const text = (max: number) => z.string().trim().min(1).max(max);
const strictObject = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

/** `target` marks the word form in `en` (computed by code, never by the model) so the page can show it in bold without HTML */
const ExampleSchema = strictObject({ id: z.string(), en: text(300), ru: text(300), target: strictObject({ start: z.number().int().min(0), length: z.number().int().min(1) }) });

const TransformationSchema = strictObject({
  id: z.enum(["s3.1", "s3.2", "s3.3"]),
  skill_id: z.string().nullable(),
  construction_en: text(120),
  instruction_en: text(300),
  source_en: text(300),
  expected_en: text(300),
  accepted_en: z.array(text(300)).min(1).max(8),
  hint_partial_en: text(300),
  translation_ru: text(300),
});

export const WordLessonContentSchema = strictObject({
  schema_version: z.literal(WORD_LESSON_SCHEMA),
  lemma: text(60),
  sense_ru: text(300),
  stage1: strictObject({ examples: z.array(ExampleSchema).length(3) }),
  stage2: strictObject({ id: z.literal("s2"), gapped_en: text(300), full_en: text(300), ru: text(300), accepted_forms: z.array(text(60)).min(1).max(6) }),
  stage3: strictObject({ chained: z.boolean(), items: z.array(TransformationSchema).min(2).max(3) }),
  stage4: strictObject({
    id: z.literal("s4"),
    skill_id: z.string().nullable(),
    construction_en: text(120),
    pattern: text(80),
    pattern_example_en: text(300),
    cue_ru: text(300),
    expected_en: text(300),
    accepted_en: z.array(text(300)).min(1).max(8),
    hint_partial_en: text(300),
    translation_ru: text(300),
  }),
  stage5: strictObject({
    id: z.literal("s5"),
    situation_en: text(300),
    situation_ru: text(300),
    suggested_words: z.array(text(40)).min(3).max(5),
    hint_start_en: text(300),
    sample_en: text(300),
    sample_ru: text(300),
  }),
});
export type WordLessonContent = z.infer<typeof WordLessonContentSchema>;

export const WORD_LESSON_STAGES = [
  { n: 1, title: "Context Introduction" },
  { n: 2, title: "Recall the Word" },
  { n: 3, title: "Sentence Transformation" },
  { n: 4, title: "Build a Sentence from Meaning" },
  { n: 5, title: "Free Sentence Creation" },
] as const;

export type WordLessonEventKind = "hint_word" | "hint_partial" | "hint_full" | "translation" | "hint_start" | "continue" | "stage_done";
export type WordLessonVerdictKind = "correct" | "incorrect" | "pending" | "unresolved" | "disputed";

export interface WordLessonFeedback {
  /** concrete remarks (Russian) and the fix for each; empty when the answer is right */
  issues: Array<{ fragment: string; problemRu: string; fixEn: string }>;
  correctedEn: string | null;
  commentRu: string | null;
  /** why the verdict was reached, in English, for the log and the page ("Exact match with an approved variant.") */
  note: string | null;
}

export interface WordLessonListItem {
  lessonId: string;
  entryId: string;
  lemma: string;
  translationRu: string;
  completedRuns: number;
  lastScore: number | null;
  lastCompletedAt: string | null;
  activeRunId: string | null;
}
export interface WordLessonListResponse {
  lessons: WordLessonListItem[];
  coverage: { ready: number; eligible: number };
}

export interface WordLessonStudioStatus {
  ready: number;
  eligible: number;
  waitingTranslation: number;
  candidates: number;
  defaultCount: number;
  maxCount: number;
  generating: number;
  failed: number;
  disputed: number;
  /** why the failed lessons failed: a short code and the reviewer's last remarks (diagnostics, so a failure is never a mystery) */
  failures: Array<{ lemma: string; code: string | null; remarks: string[] }>;
  difficulty: { min: string; max: string };
}

export interface WordLessonAttemptView {
  id: string;
  itemKey: string;
  attemptNo: number;
  answerText: string;
  input: "text" | "voice";
  verdict: WordLessonVerdictKind;
  feedback: WordLessonFeedback;
  disputable: boolean;
  createdAt: string;
}

export interface WordLessonItemState {
  key: string;
  /** done = the learner may move on */
  done: boolean;
  events: WordLessonEventKind[];
  attempts: WordLessonAttemptView[];
  /** revealed by a hint or by feedback only */
  revealed: { word?: string; partial?: string; full?: string; translationRu?: string; start?: string };
}

export interface WordLessonRunState {
  runId: string;
  lessonId: string;
  status: "active" | "completed";
  lemma: string;
  /** the word card of stage 1, live from the dictionary */
  word: { translationRu: string; definitionRu: string; synonyms: string[]; pos: string };
  /** 1..5: the stage the learner is on (5 + done = all finished, ready to complete) */
  stage: number;
  currentKey: string | null;
  transformationCount: number;
  stage1: { examples: Array<{ id: string; en: string; ru: string; target: { start: number; length: number } }> };
  /** the task shown now; answers and hints are filled in `revealed` only when earned */
  task: WordLessonTaskView | null;
  items: WordLessonItemState[];
  result: { score: number; activeMs: number; stages: Array<{ stage: number; title: string; credit: number | null; points: number; max: number; note: string }> } | null;
  voice: boolean;
}

export type WordLessonTaskView =
  | { stage: 2; key: "s2"; gappedEn: string; ru: string }
  | { stage: 3; key: string; index: number; of: number; construction: string; instruction: string; sourceEn: string }
  | { stage: 4; key: "s4"; construction: string; pattern: string; patternExample: string; cueRu: string }
  | { stage: 5; key: "s5"; situationEn: string; situationRu: string; suggestedWords: string[] };
