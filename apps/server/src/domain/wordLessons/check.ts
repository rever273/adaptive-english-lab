import { WORD_LESSON_CHECK_VERSION, type WordLessonFeedback, type WordLessonVerdictKind } from "@english-lab/contracts";
import type { Db } from "../../db/open.js";
import { RunnerError, type RunnerContext, type RunnerOutput } from "../../queue/types.js";
import type { ChatClient } from "../ai/clients.js";
import { runStructured } from "../ai/structured.js";
import type { Validated } from "../ai/validate.js";
import { comparisonKey } from "../content/grader.js";
import { normalizeWord } from "../vocabulary/forms.js";
import { ensurePromptVersion } from "../ai/prompts.js";
import { WORD_LESSON_CHECK_PROMPT, WORD_LESSON_CHECK_SYSTEM_V1, checkFormat, wordLessonCheckSchemaText } from "./prompts.js";
import { appendVerdict, emptyFeedback, loadRun, taskOf, verdictsOf, type Task } from "./store.js";
import { bad, countTarget, englishIssue, isForm, ok, parseObject, sentenceKey, str, type LessonWord, CYRILLIC } from "./validate.js";

/**
 * The key a lesson answer is compared by (the fast path of stages 3-4): case, spaces, a final stop, typographic quotes, the unambiguous contractions and
 * the marks , ; : do not matter. Articles, tenses, word order and every other word do (the same rule as the exercises, `comparisonKey`).
 */
export const lessonAnswerKey = (s: string): string => comparisonKey(s).replace(/[,;:]/g, " ").replace(/\s+/g, " ").trim();

export const MAX_ANSWER_CHARS = 600;

export interface CodeVerdict {
  verdict: WordLessonVerdictKind;
  feedback: WordLessonFeedback;
  /** true: only the model can judge this answer */
  needsModel: boolean;
}

/** Stage 2 is a form-recall exercise and is judged by code alone: the answer must be one of the forms that fit this sentence. */
export function checkRecall(answer: string, task: Task, word: LessonWord): CodeVerdict {
  const given = normalizeWord(answer);
  if (given && task.accepted.map(normalizeWord).includes(given)) return { verdict: "correct", feedback: emptyFeedback("This is the form the sentence needs."), needsModel: false };
  const sameWord = isForm(given, word);
  return {
    verdict: "incorrect",
    needsModel: false,
    feedback: {
      issues: [{ fragment: answer.trim().slice(0, 80), problemRu: sameWord ? "Это форма того же слова, но здесь нужна другая." : "Это не то слово, которое нужно в этом предложении.", fixEn: "" }],
      correctedEn: null,
      commentRu: "Попробуйте ещё раз; подсказка Hint покажет нужную форму.",
      note: sameWord ? "A different form of the word." : "Not the target word.",
    },
  };
}

/** Stages 3-5 before the model: a missing target word and an approved variant are decided by code. */
export function checkSentence(answer: string, task: Task, word: LessonWord): CodeVerdict {
  const key = lessonAnswerKey(answer);
  if (key && task.accepted.some((a) => lessonAnswerKey(a) === key)) return { verdict: "correct", feedback: emptyFeedback("Matches an approved variant."), needsModel: false };
  if (countTarget(answer, word) < 1) {
    return {
      verdict: "incorrect",
      needsModel: false,
      feedback: {
        issues: [{ fragment: "", problemRu: `В предложении нет слова «${word.lemma}» (в подходящей форме).`, fixEn: word.lemma }],
        correctedEn: task.reference,
        commentRu: "Используйте целевое слово в предложении.",
        note: "The target word is missing.",
      },
    };
  }
  return { verdict: "pending", feedback: emptyFeedback("Not an approved variant: checked by the local model."), needsModel: true };
}

/* ------------------------------------------------------------------------------------------ the local model */

export interface ModelCheck {
  verdict: "correct" | "incorrect";
  issues: Array<{ fragment: string; problem_ru: string; fix_en: string }>;
  corrected_en: string;
  comment_ru: string;
}

export function validateCheck(text: string, answer: string, word: LessonWord): Validated<ModelCheck> {
  const o = parseObject(text);
  if (!o || (o.verdict !== "correct" && o.verdict !== "incorrect")) return bad("SHAPE", "expected {verdict, issues, corrected_en, comment_ru}");
  const comment = str(o.comment_ru);
  if (comment && !CYRILLIC.test(comment)) return bad("COMMENT", "comment_ru must be Russian");
  if (o.verdict === "correct") return ok({ verdict: "correct", issues: [], corrected_en: "", comment_ru: comment });
  const issues = (Array.isArray(o.issues) ? o.issues : []).slice(0, 4).map((i) => {
    const x = i as Record<string, unknown>;
    return { fragment: str(x.fragment), problem_ru: str(x.problem_ru), fix_en: str(x.fix_en) };
  });
  if (issues.length === 0) return bad("NO_ISSUES", "an incorrect answer needs at least one concrete issue");
  if (issues.some((i) => !i.problem_ru || !CYRILLIC.test(i.problem_ru))) return bad("ISSUE_RU", "each issue needs problem_ru written in Russian");
  const corrected = str(o.corrected_en);
  const why = englishIssue(corrected, { min: 3, max: 40 });
  if (why) return bad("CORRECTED", `corrected_en ${why}`);
  if (countTarget(corrected, word) < 1) return bad("CORRECTED_WORD", "corrected_en must use the target word");
  if (sentenceKey(corrected) === sentenceKey(answer)) return bad("CORRECTED_SAME", "corrected_en must differ from the learner's answer");
  return ok({ verdict: "incorrect", issues, corrected_en: corrected, comment_ru: comment });
}

export interface CheckRunnerDeps {
  db: Db;
  chat: ChatClient;
  model: { tag: string; digest: string; numCtx: number; temperature: number; seed: number; numPredict: number };
  modelVersionId: string | null;
  installedDigest: (tag: string) => Promise<string | null>;
  deps: { now: () => Date; newId: () => string };
  sleep?: (ms: number) => Promise<void>;
}

export interface WordLessonCheckPayload {
  wordLessonAttemptId: string;
}

/** The job behind `free_text_analysis` with a `wordLessonAttemptId`: one answer of a lesson, judged by the local model (D129). */
export async function runWordLessonCheck(ctx: RunnerContext<WordLessonCheckPayload>, o: CheckRunnerDeps): Promise<RunnerOutput> {
  const attemptId = ctx.job.payload.wordLessonAttemptId;
  const a = o.db.prepare("SELECT run_id AS runId, item_key AS itemKey, answer_text AS answer FROM word_lesson_attempts WHERE id = ?").get(attemptId) as { runId: string; itemKey: string; answer: string } | undefined;
  if (!a) throw new RunnerError("attempt_missing", "the attempt no longer exists", false);
  const current = verdictsOf(o.db, attemptId).at(-1);
  if (current && current.verdict !== "pending" && current.verdict !== "unresolved") return { schemaVersion: WORD_LESSON_CHECK_VERSION, output: { attemptId, skipped: "already_judged" }, metrics: { calls: 0 } };
  const installed = await o.installedDigest(o.model.tag);
  if (installed !== o.model.digest) throw new RunnerError("model_digest_mismatch", `installed digest of ${o.model.tag} differs from the pinned one`, false);
  ensurePromptVersion(o.db, WORD_LESSON_CHECK_PROMPT, wordLessonCheckSchemaText());
  const run = loadRun(o.db, a.runId);
  const task = taskOf(run.content, a.itemKey);
  const input = {
    stage: task.stage,
    target_word: run.lemma,
    sense_ru: run.sense.translationRu,
    task: task.brief,
    model_answer: task.reference,
    other_accepted_answers: task.accepted.filter((x) => x !== task.reference),
    learner_answer: a.answer,
  };
  const result = await runStructured<ModelCheck>({
    client: o.chat,
    model: o.model.tag,
    messages: [
      { role: "system", content: WORD_LESSON_CHECK_SYSTEM_V1 },
      { role: "user", content: JSON.stringify(input) },
    ],
    format: checkFormat(),
    options: { num_ctx: o.model.numCtx, num_predict: Math.min(o.model.numPredict, 900), temperature: 0.2, seed: o.model.seed },
    validate: (t) => validateCheck(t, a.answer, run.word),
    signal: ctx.signal,
    sleep: o.sleep,
  });
  if (!result.ok) {
    if (result.code === "transport_failed") throw new RunnerError("transport_failed", result.issues.map((i) => `${i.code}: ${i.message}`).join("; ").slice(0, 300), true);
    // an answer the model could not judge is "unresolved", never wrong: the learner sees the reference answer and may continue
    return {
      schemaVersion: WORD_LESSON_CHECK_VERSION,
      output: { attemptId, verdict: "unresolved" },
      metrics: { calls: result.usage.calls },
      alsoCommit: (db) => settle(db, o, ctx.job.id, attemptId, "unresolved", { ...emptyFeedback("The local model could not judge this answer."), correctedEn: task.reference }),
    };
  }
  const v = result.value;
  const feedback: WordLessonFeedback =
    v.verdict === "correct"
      ? { issues: [], correctedEn: null, commentRu: v.comment_ru || null, note: "Judged correct by the local model." }
      : { issues: v.issues.map((i) => ({ fragment: i.fragment, problemRu: i.problem_ru, fixEn: i.fix_en })), correctedEn: v.corrected_en, commentRu: v.comment_ru || null, note: "Judged by the local model." };
  return {
    schemaVersion: WORD_LESSON_CHECK_VERSION,
    output: { attemptId, verdict: v.verdict },
    metrics: { calls: result.usage.calls, repaired: result.usage.repaired },
    alsoCommit: (db) => settle(db, o, ctx.job.id, attemptId, v.verdict, feedback),
  };
}

/** inside the job's own transaction: the model's verdict is appended once, and only if the attempt is still waiting (or was given up on) */
function settle(db: Db, o: CheckRunnerDeps, jobId: string, attemptId: string, verdict: WordLessonVerdictKind, feedback: WordLessonFeedback): void {
  const latest = verdictsOf(db, attemptId).at(-1);
  if (!latest || (latest.verdict !== "pending" && latest.verdict !== "unresolved")) return; // judged or disputed meanwhile
  if (latest.verdict === "unresolved" && verdict === "unresolved") return;
  const jr = db.prepare("SELECT id FROM job_results WHERE job_id = ?").get(jobId) as { id: string } | undefined;
  appendVerdict(db, o.deps.newId, o.deps.now(), attemptId, { verdict, source: "model", feedback, modelVersionId: o.modelVersionId, jobResultId: jr?.id ?? null });
}
