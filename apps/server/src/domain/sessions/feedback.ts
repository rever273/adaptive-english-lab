import type { FeedbackResponse } from "@english-lab/contracts";
import type { Db } from "../../db/open.js";
import { ApiError } from "../../errors.js";
import { exposeUnits } from "./exposure.js";
import type { SessionDeps } from "./policy.js";
import type { AnalysisV2 } from "../ai/validate.js";
import { NO_MISTAKE_ID, answerKey, nearMatch } from "../content/grader.js";
import { VocabularyPracticeMetadataSchema } from "@english-lab/contracts";
import { buildPrompt } from "./reveal.js";
import { isUnresolved } from "./reviewQueue.js";
import { lookupWord } from "../vocabulary/repository.js";

type Payload = Record<string, any>;

/** a correction is either the corrected segment or the whole corrected sentence; the second is cut back to the segment by removing the unchanged text around it */
export function segmentFixes(segs: Array<{ id: string; text: string }>, wrongId: string, corrections: string[]): string[] {
  const i = segs.findIndex((s) => s.id === wrongId);
  const pre = segs.slice(0, i).map((s) => s.text).join("");
  const post = segs.slice(i + 1).map((s) => s.text).join("");
  const out = corrections.map((c) => (c.startsWith(pre) && c.endsWith(post) && c.length > pre.length + post.length ? c.slice(pre.length, c.length - post.length).trim() : c.trim()));
  return out.filter((x) => x.length > 0);
}

/** the model sometimes answers an empty explanation with the literal word "null": show a plain sentence instead */
export function aiExplanation(judgement: string, text: string | null | undefined): string {
  const t = (text ?? "").trim();
  if (t.length >= 8 && !/^(null|none|n\/a|undefined|нет|-)\.?$/i.test(t)) return t;
  return judgement === "acceptable" ? "Предложение грамматически верно и передаёт смысл задания." : "Локальная модель сочла этот ответ неверным.";
}

function correctAnswer(format: string, content: { payload: Payload }, questionId: string | null): NonNullable<FeedbackResponse["correct"]> {
  const p = content.payload;
  switch (format) {
    case "choose_form":
    case "choose_missing_fragment":
      return { options: (p.options as Array<{ id: string; text: string }>).filter((o) => (p.accepted_option_ids as string[]).includes(o.id)).map((o) => o.text) };
    case "detect_error": {
      if (p.no_mistake) return { noMistake: true };
      const segs = p.segments as Array<{ id: string; text: string }>;
      const wrong = segs.filter((s) => (p.accepted_segment_ids as string[]).includes(s.id));
      const corrections = p.corrections as string[];
      if (p.accept_any) return { segments: [wrong.map((s) => s.text).join("").trim()], corrections, ...((p.fixes as string[] | undefined)?.length ? { fixes: p.fixes as string[] } : {}) };
      return { segments: wrong.map((s) => s.text), corrections, ...(wrong.length === 1 ? { fixes: segmentFixes(segs, wrong[0]!.id, corrections) } : {}) };
    }
    case "context_reading": {
      const q = (p.questions as Array<{ id: string; options: Array<{ id: string; text: string }>; accepted_option_ids: string[] }>).find((x) => x.id === questionId)!;
      return { options: q.options.filter((o) => q.accepted_option_ids.includes(o.id)).map((o) => o.text) };
    }
    default:
      return { answers: p.accepted_answers as string[] };
  }
}

/**
 * Feedback for a slot, delivered only after an answer, a skip or a revealed answer. The accepted-answer sentences are exposed
 * (committed to the global ledger) BEFORE this function returns them. Held-out feedback stays closed. A pending answer is stated
 * as pending - never as wrong - and no model verdict is invented.
 */
export function getFeedback(db: Db, deps: SessionDeps, sessionId: string, slotId: string): FeedbackResponse {
  const f = feedbackCore(db, deps, sessionId, slotId);
  const row = db.prepare("SELECT er.content_json AS c, ss.question_id AS q FROM session_slots ss JOIN exercise_revisions er ON er.id = ss.exercise_revision_id WHERE ss.id = ?").get(slotId) as { c: string; q: string | null };
  const c = JSON.parse(row.c) as { prompt_en: string; payload: Payload };
  const p = c.payload;
  const prompt = p.questions ? ((p.questions as Array<{ id: string; prompt: string }>).find((x) => x.id === row.q)?.prompt ?? null) : p.sentence ?? p.cue_ru ?? c.prompt_en;
  const detail = f.state === "confirmed" && f.verdict === "correct" ? nearMatchOfFirst(db, slotId) : null;
  const vocabulary = f.state === "closed" || f.state === "skipped" ? null : vocabularyFeedback(db, slotId, c as { vocabulary?: unknown; payload: Payload });
  return { ...f, prompt, ...(f.state === "closed" ? {} : { yourAnswer: firstAnswerText(db, slotId) }), ...(detail ? { detail } : {}), ...(vocabulary ? { vocabulary } : {}) };
}

/** vocabulary exercise: the tested word and the reviewed reason for every option (why the right one fits, why each other one does not) */
function vocabularyFeedback(db: Db, slotId: string, c: { vocabulary?: unknown; payload: Payload }): FeedbackResponse["vocabulary"] | null {
  const m = VocabularyPracticeMetadataSchema.safeParse(c.vocabulary);
  if (!m.success) return null;
  const v = m.data;
  const first = db.prepare("SELECT raw_answer_json AS raw FROM attempts WHERE slot_id = ? AND attempt_no = 1").get(slotId) as { raw: string | null } | undefined;
  const chosen = new Set((JSON.parse(first?.raw ?? "null") as { optionIds?: string[] } | null)?.optionIds ?? []);
  const options = v.family === "guided_recall" ? [] : v.options.map((o) => ({ text: o.text, rationaleRu: o.rationaleRu, correct: o.id === v.acceptedOptionId, chosen: chosen.has(o.id) }));
  const entry = lookupWord(db, v.target.lemma);
  const own = entry?.translation.text ? { text: entry.translation.text, source: entry.translation.source === "user" ? ("user" as const) : ("ai_draft" as const) } : v.wordRu ? { text: v.wordRu, source: "exercise" as const } : null;
  // the sentence as it reads once the gap is filled with the right word
  const prompt = (c as { prompt_en?: string }).prompt_en ?? "";
  const filled = v.family === "guided_recall" ? v.acceptedAnswers[0]! : (v.options.find((o) => o.id === v.acceptedOptionId)?.text ?? "");
  const gap = /_{2,}/.exec(prompt);
  const sentence = gap ? { before: prompt.slice(0, gap.index), filled, after: prompt.slice(gap.index + gap[0].length), form: v.target.surfaceForm } : null;
  return { lemma: v.target.lemma, family: v.family, partOfSpeech: v.target.partOfSpeech, translationRu: own?.text ?? null, translationSource: own?.source ?? null, sentence, sentenceRu: v.sentenceRu ?? null, wordRu: v.wordRu ?? null, options };
}

/** D64: the first written answer is a near match (right construction, a different name/number); null for an exact match or any other format */
export function nearMatchOfFirst(db: Db, slotId: string) {
  const a = db.prepare("SELECT t.raw_answer_json AS raw, er.type AS type, er.content_json AS c FROM attempts t JOIN session_slots ss ON ss.id = t.slot_id JOIN exercise_revisions er ON er.id = ss.exercise_revision_id WHERE t.slot_id = ? AND t.attempt_no = 1 AND t.idk = 0").get(slotId) as { raw: string | null; type: string; c: string } | undefined;
  if (!a || (a.type !== "guided_short_answer" && a.type !== "russian_to_english_short")) return null;
  const raw = JSON.parse(a.raw ?? "null") as { kind?: string; text?: string } | null;
  if (raw?.kind !== "text" || typeof raw.text !== "string") return null;
  const p = (JSON.parse(a.c) as { payload: { accepted_answers: string[]; rubric?: { target_markers?: string[] } } }).payload;
  if (p.accepted_answers.map(answerKey).includes(answerKey(raw.text))) return null;
  return nearMatch(raw.text, p.accepted_answers, p.rubric?.target_markers ?? []);
}

/** The first answer as the learner gave it, in words: option or segment texts as shown, the typed text, "No mistake" or "I don't know". */
function firstAnswerText(db: Db, slotId: string): string | null {
  const a = db.prepare("SELECT idk, raw_answer_json AS raw FROM attempts WHERE slot_id = ? ORDER BY attempt_no ASC LIMIT 1").get(slotId) as { idk: number; raw: string | null } | undefined;
  if (!a) return null;
  if (a.idk) return "I don't know";
  const raw = JSON.parse(a.raw ?? "null") as { kind: string; text?: string; optionIds?: string[] } | null;
  if (!raw) return null;
  if (raw.kind === "text") return raw.text ?? null;
  const ids = raw.optionIds ?? [];
  if (ids.length === 1 && ids[0] === NO_MISTAKE_ID) return "No mistake";
  const s = db.prepare("SELECT er.type AS format, er.content_json AS c, ss.question_id AS q FROM session_slots ss JOIN exercise_revisions er ON er.id = ss.exercise_revision_id WHERE ss.id = ?").get(slotId) as { format: string; c: string; q: string | null };
  const shown = buildPrompt(s.format, s.c, s.q, slotId);
  const items: Array<{ id: string; text: string }> = shown.kind === "choice" ? shown.options : shown.kind === "segments" ? shown.segments : shown.kind === "reading" ? shown.question.options : [];
  const texts = ids.map((id) => items.find((x) => x.id === id)?.text.trim()).filter((t): t is string => Boolean(t));
  return texts.length ? texts.join(" / ") : null;
}

function feedbackCore(db: Db, deps: SessionDeps, sessionId: string, slotId: string): FeedbackResponse {
  return db
    .transaction((): FeedbackResponse => {
      const slot = db
        .prepare(
          `SELECT ss.id AS slotId, ss.question_id AS questionId, ss.exercise_revision_id AS revisionId, er.type AS format, er.content_json AS content, s.purpose AS purpose, s.status AS sessionStatus
             FROM session_slots ss JOIN sessions s ON s.id = ss.session_id JOIN exercise_revisions er ON er.id = ss.exercise_revision_id
            WHERE ss.id = ? AND ss.session_id = ?`,
        )
        .get(slotId, sessionId) as { slotId: string; questionId: string | null; revisionId: string; format: string; content: string; purpose: string; sessionStatus: string } | undefined;
      if (!slot) throw new ApiError(404, "SLOT_NOT_FOUND", "Slot does not belong to this session");
      const events = (db.prepare("SELECT event_type AS t FROM session_events WHERE slot_id = ?").all(slotId) as Array<{ t: string }>).map((e) => e.t);
      const attempt = db.prepare("SELECT id, idk FROM attempts WHERE slot_id = ? ORDER BY attempt_no DESC LIMIT 1").get(slotId) as { id: string; idk: number } | undefined;
      const answerSeen = events.includes("show_answer");
      const skipped = events.includes("skip");
      if (!attempt && !answerSeen && !skipped) throw new ApiError(409, "FEEDBACK_NOT_AVAILABLE", "Answer, skip or show the answer first");
      // diagnostic blocks and held-out checks give feedback AFTER the block (spec/04, spec/08): per-task feedback would teach the answer to the next task
      if ((slot.purpose === "heldout" || slot.purpose === "diagnostic") && slot.sessionStatus === "active") {
        return { slotId, state: "closed", verdict: null, confirmation: null, explanation_ru: null, correct: null, message: "Feedback opens when the block is finished." };
      }
      const content = JSON.parse(slot.content) as { explanation_ru: string; payload: Payload };

      if (skipped && !attempt && !answerSeen) {
        return { slotId, state: "skipped", verdict: null, confirmation: null, explanation_ru: null, correct: null, message: "Skipped. It stays in your history and is not counted as a mistake." };
      }
      const a = attempt
        ? (db.prepare("SELECT verdict, confirmation, source, rationale FROM assessment_revisions WHERE attempt_id = ? ORDER BY sequence DESC LIMIT 1").get(attempt.id) as { verdict: string; confirmation: string; source: string; rationale: string })
        : null;

      // This is a model draft, never a confirmed grade or evidence of task meaning.
      const annotation = attempt && a && ["pending", "ambiguous", "correct", "incorrect"].includes(a.verdict) && a.confirmation !== "confirmed"
        ? (db.prepare("SELECT findings_json AS value FROM ai_annotations WHERE attempt_id = ? AND json_extract(findings_json, '$.superseded') = 0 ORDER BY rowid DESC LIMIT 1").get(attempt.id) as { value: string } | undefined)
        : undefined;
      let aiReview: FeedbackResponse["aiReview"];
      if (annotation) {
        const output = (JSON.parse(annotation.value) as { output: AnalysisV2 }).output;
        if (output?.schema_version === "analysis-v2") aiReview = { judgement: output.judgement, explanation_ru: aiExplanation(output.judgement, output.explanation_ru), findings: output.findings.map((f) => ({ original: f.original, suggestion: f.suggestion, explanation_ru: f.explanation_ru })) };
      }

      if (a && (a.verdict === "pending" || a.verdict === "ambiguous")) {
        exposeUnits(db, deps, slotId, slot.revisionId, "answer");
        // D65: the AI check is over (abstained, ambiguous, invalid output or failed) -> unresolved: it waits for the agent review queue
        const unresolved = attempt !== undefined && isUnresolved(a.verdict, (db.prepare("SELECT state FROM jobs WHERE idempotency_key = ?").get(`free_text_analysis:${attempt.id}`) as { state: string } | undefined)?.state);
        return {
          slotId,
          state: "pending",
          verdict: a.verdict,
          confirmation: a.confirmation,
          explanation_ru: null,
          ...(aiReview ? { aiReview } : {}),
          correct: correctAnswer(slot.format, content, slot.questionId),
          ...(unresolved ? { unresolved: true } : {}),
          message: unresolved ? "Could not be checked automatically — it will be reviewed later. This is not marked wrong. Approved examples are shown for comparison." : "Saved — AI review after this session. This is not marked wrong. Approved examples are shown for comparison.",
        };
      }
      if (a && a.verdict === "disputed") {
        return { slotId, state: "pending", verdict: a.verdict, confirmation: a.confirmation, explanation_ru: null, correct: null, message: "This assessment is disputed and is being reviewed." };
      }
      if (a && a.confirmation !== "confirmed") {
        // D65: a decided local-AI verdict is shown at once, labelled as such; it counts provisionally and is never "confirmed"
        if (a.source === "model" && (a.verdict === "correct" || a.verdict === "incorrect")) {
          exposeUnits(db, deps, slotId, slot.revisionId, "answer");
          const reason = aiReview?.explanation_ru ?? a.rationale.replace(/^AI draft \([^)]*\):\s*/, "");
          return { slotId, state: "pending", verdict: a.verdict, confirmation: a.confirmation, explanation_ru: null, correct: correctAnswer(slot.format, content, slot.questionId), aiChecked: true, ...(aiReview ? { aiReview } : {}), message: `${a.verdict === "correct" ? "Correct" : "Incorrect"} (checked by AI) — ${reason}` };
        }
        return { slotId, state: "pending", verdict: a.verdict, confirmation: a.confirmation, explanation_ru: null, correct: null, ...(aiReview ? { aiReview } : {}), message: "AI suggestion — needs review. It is not confirmed." };
      }

      exposeUnits(db, deps, slotId, slot.revisionId, "answer"); // committed before the answer is returned
      const verdict = a?.verdict ?? null;
      return {
        slotId,
        state: "confirmed",
        verdict,
        confirmation: a?.confirmation ?? null,
        explanation_ru: content.explanation_ru,
        correct: correctAnswer(slot.format, content, slot.questionId),
        message:
          verdict === "correct"
            ? "Correct."
            : verdict === "idk"
              ? "No problem — this is the answer. It counts as a failed first attempt, not as a skip."
              : verdict === "incorrect"
                ? "Not this time. You can try again if you like, or continue."
                : "Here is the answer. Viewing it means later attempts do not count as independent.",
      };
    })
    .immediate();
}
