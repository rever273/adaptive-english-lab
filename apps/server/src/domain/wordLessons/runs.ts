import { randomInt } from "node:crypto";
import { WORD_LESSON_STAGES, type WordLessonAttemptView, type WordLessonEventKind, type WordLessonFeedback, type WordLessonItemState, type WordLessonListResponse, type WordLessonRunState, type WordLessonTaskView, type WordLessonVerdictKind } from "@english-lab/contracts";
import type { Db } from "../../db/open.js";
import { awardModeXp, XP_WORD_LESSON } from "../sessions/modeXp.js";
import { ApiError } from "../../errors.js";
import { enqueue } from "../../queue/jobs.js";
import { getEntry } from "../vocabulary/repository.js";
import { MAX_ANSWER_CHARS, checkRecall, checkSentence } from "./check.js";
import { scoreRun, type ItemEvidence } from "./score.js";
import { eligibleWords, wordLessonCoverage } from "./selection.js";
import { appendVerdict, checkJobKey, itemKeys, loadRun, stageOfKey, taskOf, verdictsOf, type LoadedRun } from "./store.js";
import { normalizeWordLessonText } from "./text.js";

export interface RunDeps {
  now: () => Date;
  newId: () => string;
}

/* ---------------------------------------------------------------------------------------------- the list */

export function listLessons(db: Db, now: Date): WordLessonListResponse {
  const { eligible } = eligibleWords(db);
  const byEntry = new Map(eligible.map((w) => [w.entryId, w]));
  const rows = db.prepare("SELECT id, entry_id AS entryId, lemma FROM word_lessons WHERE status = 'ready' ORDER BY lemma").all() as Array<{ id: string; entryId: string; lemma: string }>;
  const lessons = rows.flatMap((l) => {
    const w = byEntry.get(l.entryId);
    if (!w) return []; // the word was removed (or lost its translation): the lesson waits for it
    const done = db.prepare("SELECT COUNT(*) AS n FROM word_lesson_runs WHERE lesson_id = ? AND status = 'completed'").get(l.id) as { n: number };
    const last = db.prepare("SELECT score, completed_at AS at FROM word_lesson_runs WHERE lesson_id = ? AND status = 'completed' ORDER BY completed_at DESC, rowid DESC LIMIT 1").get(l.id) as { score: number; at: string } | undefined;
    const active = db.prepare("SELECT id FROM word_lesson_runs WHERE lesson_id = ? AND status = 'active'").get(l.id) as { id: string } | undefined;
    return [{ lessonId: l.id, entryId: l.entryId, lemma: l.lemma, translationRu: w.translationRu, completedRuns: done.n, lastScore: last?.score ?? null, lastCompletedAt: last?.at ?? null, activeRunId: active?.id ?? null }];
  });
  const c = wordLessonCoverage(db, now);
  return { lessons, coverage: { ready: c.ready, eligible: c.eligible } };
}

/* ---------------------------------------------------------------------------------------------- starting */

export function startRun(db: Db, deps: RunDeps, lessonId: string, tabId: string): { runId: string; resumed: boolean } {
  return db
    .transaction(() => {
      const l = db.prepare("SELECT id, entry_id AS entryId, status FROM word_lessons WHERE id = ?").get(lessonId) as { id: string; entryId: string; status: string } | undefined;
      if (!l) throw new ApiError(404, "WORD_LESSON_NOT_FOUND", "Unknown lesson");
      if (l.status !== "ready") throw new ApiError(409, "WORD_LESSON_NOT_READY", "This lesson is not ready yet");
      if (!eligibleWords(db).eligible.some((w) => w.entryId === l.entryId)) throw new ApiError(409, "WORD_LESSON_WORD_HIDDEN", "This word was removed from your dictionary");
      const active = db.prepare("SELECT id, tab_id AS tabId FROM word_lesson_runs WHERE lesson_id = ? AND status = 'active'").get(lessonId) as { id: string; tabId: string } | undefined;
      if (active) {
        if (active.tabId !== tabId) db.prepare("UPDATE word_lesson_runs SET tab_id = ? WHERE id = ? AND status = 'active'").run(tabId, active.id);
        return { runId: active.id, resumed: true };
      }
      const id = deps.newId();
      db.prepare("INSERT INTO word_lesson_runs(id, lesson_id, tab_id, seed, status, started_at) VALUES (?,?,?,?,?,?)").run(id, lessonId, tabId, randomInt(1, 2 ** 31 - 1), "active", deps.now().toISOString());
      return { runId: id, resumed: false };
    })
    .immediate();
}

/* ---------------------------------------------------------------------------------------------- reading a run */

interface AttemptRow {
  id: string;
  itemKey: string;
  attemptNo: number;
  answerText: string;
  input: "text" | "voice";
  createdAt: string;
}
interface EventRow {
  itemKey: string;
  kind: WordLessonEventKind;
  at: string;
}

const attemptsOf = (db: Db, runId: string): AttemptRow[] =>
  db.prepare("SELECT id, item_key AS itemKey, attempt_no AS attemptNo, answer_text AS answerText, input, created_at AS createdAt FROM word_lesson_attempts WHERE run_id = ? ORDER BY created_at, rowid").all(runId) as AttemptRow[];
const eventsOf = (db: Db, runId: string): EventRow[] => db.prepare("SELECT item_key AS itemKey, kind, created_at AS at FROM word_lesson_events WHERE run_id = ? ORDER BY created_at, rowid").all(runId) as EventRow[];

/** an answer whose check will never come (its job ended without a verdict) becomes "unresolved", so the learner is never stuck */
function settleOrphans(db: Db, deps: RunDeps, run: LoadedRun): void {
  const pending = attemptsOf(db, run.id).filter((a) => verdictsOf(db, a.id).at(-1)?.verdict === "pending");
  const orphans = pending.filter((a) => !db.prepare("SELECT 1 FROM jobs WHERE idempotency_key = ? AND state IN ('queued','waiting_for_gpu','running','paused')").get(checkJobKey(a.id)));
  if (orphans.length === 0) return;
  db.transaction(() => {
    for (const a of orphans) {
      if (verdictsOf(db, a.id).at(-1)?.verdict !== "pending") continue;
      appendVerdict(db, deps.newId, deps.now(), a.id, { verdict: "unresolved", source: "code", feedback: { issues: [], correctedEn: taskOf(run.content, a.itemKey).reference, commentRu: null, note: "The check did not finish." } });
    }
  }).immediate();
}

const lastVerdict = (db: Db, attemptId: string) => verdictsOf(db, attemptId).at(-1);

interface ItemFacts {
  key: string;
  attempts: Array<AttemptRow & { verdict: WordLessonVerdictKind; source: string; feedback: WordLessonFeedback }>;
  events: EventRow[];
}

function factsOf(db: Db, run: LoadedRun, attempts: AttemptRow[], events: EventRow[]): ItemFacts[] {
  return itemKeys(run.content).map((key) => ({
    key,
    attempts: attempts
      .filter((a) => a.itemKey === key)
      .map((a) => {
        const v = lastVerdict(db, a.id)!;
        return { ...a, verdict: v.verdict, source: v.source, feedback: v.feedback };
      }),
    events: events.filter((e) => e.itemKey === key),
  }));
}

/** the learner may leave a task once it is answered right, or answered and explained (a wrong, disputed or unchecked answer shown with its reference) and "continue" was pressed */
function isDone(f: ItemFacts): boolean {
  if (f.key === "s1") return f.events.some((e) => e.kind === "stage_done");
  if (f.attempts.some((a) => a.verdict === "correct")) return true;
  if (f.key === "s2") return false; // recall must end with the right form
  return f.events.some((e) => e.kind === "continue") && canContinue(f);
}

function canContinue(f: ItemFacts): boolean {
  if (f.key === "s1" || f.key === "s2") return false;
  const last = f.attempts.at(-1);
  return !!last && (last.verdict === "incorrect" || last.verdict === "disputed" || last.verdict === "unresolved");
}

function shuffled<T>(list: readonly T[], seed: number): T[] {
  const a = [...list];
  let s = seed >>> 0;
  for (let i = a.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export function activeMsOf(db: Db, runId: string): number {
  return (db.prepare("SELECT COALESCE(SUM(end_ms - start_ms), 0) AS ms FROM word_lesson_activity_intervals WHERE run_id = ?").get(runId) as { ms: number }).ms;
}

export function runState(db: Db, deps: RunDeps, runId: string, voice: boolean): WordLessonRunState {
  let run = loadRun(db, runId);
  if (run.status === "active") settleOrphans(db, deps, run);
  run = loadRun(db, runId);
  const attempts = attemptsOf(db, runId);
  const facts = factsOf(db, run, attempts, eventsOf(db, runId));
  const c = run.content;
  const current = run.status === "active" ? (facts.find((f) => !isDone(f))?.key ?? null) : null;
  const stage = current ? stageOfKey(current) : 5;

  const items: WordLessonItemState[] = facts.map((f) => {
    const kinds = new Set(f.events.map((e) => e.kind));
    const done = isDone(f);
    const last = f.attempts.at(-1);
    const shownRef = !!last && (last.verdict === "disputed" || last.verdict === "unresolved");
    const revealed: WordLessonItemState["revealed"] = {};
    if (f.key === "s2") {
      if (kinds.has("hint_word") || done) revealed.word = c.stage2.accepted_forms[0];
    } else if (f.key.startsWith("s3.") || f.key === "s4") {
      const t = taskOf(c, f.key);
      const sub = f.key === "s4" ? c.stage4 : c.stage3.items.find((i) => i.id === f.key)!;
      if (kinds.has("hint_partial") || kinds.has("hint_full")) revealed.partial = sub.hint_partial_en;
      if (kinds.has("hint_full") || shownRef || done) revealed.full = t.reference;
      if (kinds.has("translation") || (f.key === "s4" && done)) revealed.translationRu = sub.translation_ru;
    } else if (f.key === "s5") {
      if (kinds.has("hint_start")) revealed.start = c.stage5.hint_start_en;
      if (shownRef || done) revealed.full = c.stage5.sample_en;
    }
    const attemptViews: WordLessonAttemptView[] = f.attempts.map((a, i) => ({
      id: a.id,
      itemKey: a.itemKey,
      attemptNo: a.attemptNo,
      answerText: a.answerText,
      input: a.input,
      verdict: a.verdict,
      feedback: a.feedback,
      disputable: run.status === "active" && i === f.attempts.length - 1 && a.verdict === "incorrect" && a.source === "model",
      createdAt: a.createdAt,
    }));
    return { key: f.key, done, events: [...kinds], attempts: attemptViews, revealed };
  });

  let task: WordLessonTaskView | null = null;
  if (current === "s2") task = { stage: 2, key: "s2", gappedEn: c.stage2.gapped_en, ru: c.stage2.ru };
  else if (current?.startsWith("s3.")) {
    const idx = c.stage3.items.findIndex((i) => i.id === current);
    const t = c.stage3.items[idx]!;
    task = { stage: 3, key: current, index: idx + 1, of: c.stage3.items.length, construction: t.construction_en, instruction: t.instruction_en, sourceEn: t.source_en };
  } else if (current === "s4") task = { stage: 4, key: "s4", construction: c.stage4.construction_en, pattern: c.stage4.pattern, patternExample: c.stage4.pattern_example_en, cueRu: c.stage4.cue_ru };
  else if (current === "s5") task = { stage: 5, key: "s5", situationEn: c.stage5.situation_en, situationRu: c.stage5.situation_ru, suggestedWords: c.stage5.suggested_words };

  const entry = getEntry(db, run.entryId);
  const stored = run.scoreJson as { stages?: NonNullable<WordLessonRunState["result"]>["stages"] } | null;
  return {
    runId,
    lessonId: run.lessonId,
    status: run.status,
    // the recall task does not name the word (stage 1 stays readable: it is the study part of the lesson)
    lemma: current === "s2" ? "" : run.lemma,
    word: { translationRu: entry.translation.text || run.sense.translationRu, definitionRu: entry.lexicon?.definitionRu || run.sense.definitionRu, synonyms: entry.lexicon?.synonyms ?? run.sense.synonyms, pos: entry.pos !== "unknown" ? entry.pos : run.sense.pos },
    stage,
    currentKey: current,
    transformationCount: c.stage3.items.length,
    stage1: { examples: shuffled(c.stage1.examples, run.seed).map((e) => ({ id: e.id, en: e.en, ru: e.ru, target: e.target })) },
    task,
    items,
    result: run.status === "completed" && run.score !== null ? { score: run.score, activeMs: activeMsOf(db, runId), stages: stored?.stages ?? [] } : null,
    voice,
  };
}

/** every task is finished: the learner may press the last button */
export const allDone = (db: Db, run: LoadedRun): boolean => factsOf(db, run, attemptsOf(db, run.id), eventsOf(db, run.id)).every(isDone);

/* ---------------------------------------------------------------------------------------------- acting in a run */

function activeRun(db: Db, runId: string): LoadedRun {
  const run = loadRun(db, runId);
  if (run.status !== "active") throw new ApiError(409, "WORD_LESSON_RUN_COMPLETED", "This lesson run is already finished");
  return run;
}

function currentFacts(db: Db, run: LoadedRun, key: string): ItemFacts {
  const facts = factsOf(db, run, attemptsOf(db, run.id), eventsOf(db, run.id));
  const f = facts.find((x) => x.key === key);
  if (!f) throw new ApiError(404, "WORD_LESSON_ITEM_NOT_FOUND", "Unknown task");
  const open = facts.find((x) => !isDone(x));
  if (!open || open.key !== key) throw new ApiError(409, "WORD_LESSON_ITEM_NOT_CURRENT", "Finish the current task first");
  return f;
}

const ALLOWED: Record<string, WordLessonEventKind[]> = {
  s1: ["stage_done"],
  s2: ["hint_word"],
  s3: ["hint_partial", "hint_full", "translation", "continue"],
  s4: ["hint_partial", "hint_full", "continue"],
  s5: ["hint_start", "continue"],
};

export function recordEvent(db: Db, deps: RunDeps, runId: string, b: { id: string; itemKey: string; kind: WordLessonEventKind }): void {
  db.transaction(() => {
    const run = activeRun(db, runId);
    const prev = db.prepare("SELECT run_id AS runId, item_key AS itemKey, kind FROM word_lesson_events WHERE id = ?").get(b.id) as { runId: string; itemKey: string; kind: string } | undefined;
    if (prev) {
      if (prev.runId !== runId || prev.itemKey !== b.itemKey || prev.kind !== b.kind) throw new ApiError(409, "EVENT_ID_CONFLICT", "That event id was already used");
      return;
    }
    const f = currentFacts(db, run, b.itemKey);
    const group = b.itemKey.startsWith("s3.") ? "s3" : b.itemKey;
    if (!ALLOWED[group]?.includes(b.kind)) throw new ApiError(409, "EVENT_NOT_ALLOWED", "That help is not part of this task");
    if (f.events.some((e) => e.kind === b.kind)) return; // already open: nothing new to record
    if (b.kind === "hint_full" && !f.events.some((e) => e.kind === "hint_partial")) throw new ApiError(409, "HINT_ORDER", "Open the first hint before the full answer");
    if (b.kind === "continue" && !canContinue(f)) throw new ApiError(409, "CONTINUE_NOT_ALLOWED", "Answer first; you can continue after the feedback");
    db.prepare("INSERT INTO word_lesson_events(id, run_id, item_key, kind, created_at) VALUES (?,?,?,?,?)").run(b.id, runId, b.itemKey, b.kind, deps.now().toISOString());
  }).immediate();
}

export interface AttemptInput {
  id: string;
  itemKey: string;
  text: string;
  input: "text" | "voice";
  voice?: { asrText: string; sttModelId: string };
}

export function submitAttempt(db: Db, deps: RunDeps, runId: string, b: AttemptInput): { attemptId: string; queued: boolean } {
  return db
    .transaction(() => {
      const run = activeRun(db, runId);
      const prev = db.prepare("SELECT run_id AS runId, item_key AS itemKey, answer_text AS text FROM word_lesson_attempts WHERE id = ?").get(b.id) as { runId: string; itemKey: string; text: string } | undefined;
      if (prev) {
        if (prev.runId !== runId || prev.itemKey !== b.itemKey) throw new ApiError(409, "ATTEMPT_ID_CONFLICT", "That attempt id was already used");
        return { attemptId: b.id, queued: false };
      }
      if (b.itemKey === "s1") throw new ApiError(409, "WORD_LESSON_NOT_AN_ANSWER", "This stage has nothing to answer");
      const f = currentFacts(db, run, b.itemKey);
      const text = normalizeWordLessonText(b.text);
      if (!text) throw new ApiError(400, "ANSWER_EMPTY", "Type or say your answer first");
      if (text.length > MAX_ANSWER_CHARS) throw new ApiError(400, "ANSWER_TOO_LONG", "That answer is too long");
      const last = f.attempts.at(-1);
      if (last?.verdict === "pending") throw new ApiError(409, "ATTEMPT_PENDING", "Wait for the check of your last answer");
      const task = taskOf(run.content, b.itemKey);
      db.prepare("INSERT INTO word_lesson_attempts(id, run_id, item_key, attempt_no, answer_text, input, asr_text, edited, stt_model_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(
        b.id,
        runId,
        b.itemKey,
        f.attempts.length + 1,
        text,
        b.input,
        b.voice ? b.voice.asrText : null,
        b.voice ? Number(b.voice.asrText.trim() !== text) : null,
        b.voice ? b.voice.sttModelId : null,
        deps.now().toISOString(),
      );
      const code = task.stage === 2 ? checkRecall(text, task, run.word) : checkSentence(text, task, run.word);
      appendVerdict(db, deps.newId, deps.now(), b.id, { verdict: code.verdict, source: "code", feedback: code.feedback });
      if (code.needsModel) enqueue(db, deps, { kind: "free_text_analysis", priority: 1, payload: { wordLessonAttemptId: b.id }, idempotencyKey: checkJobKey(b.id) });
      return { attemptId: b.id, queued: code.needsModel };
    })
    .immediate();
}

/** the page gave up waiting: the answer is "unresolved" (the reference is shown); a late verdict of the model is still saved */
export function giveUpWaiting(db: Db, deps: RunDeps, runId: string, attemptId: string): void {
  db.transaction(() => {
    const run = activeRun(db, runId);
    const a = db.prepare("SELECT run_id AS runId, item_key AS itemKey FROM word_lesson_attempts WHERE id = ?").get(attemptId) as { runId: string; itemKey: string } | undefined;
    if (!a || a.runId !== runId) throw new ApiError(404, "ATTEMPT_NOT_FOUND", "Unknown answer");
    if (lastVerdict(db, attemptId)?.verdict !== "pending") return;
    appendVerdict(db, deps.newId, deps.now(), attemptId, { verdict: "unresolved", source: "code", feedback: { issues: [], correctedEn: taskOf(run.content, a.itemKey).reference, commentRu: null, note: "The check took too long." } });
  }).immediate();
}

export function disputeAttempt(db: Db, deps: RunDeps, runId: string, attemptId: string, reason: string | undefined): void {
  db.transaction(() => {
    activeRun(db, runId);
    const a = db.prepare("SELECT run_id AS runId FROM word_lesson_attempts WHERE id = ?").get(attemptId) as { runId: string } | undefined;
    if (!a || a.runId !== runId) throw new ApiError(404, "ATTEMPT_NOT_FOUND", "Unknown answer");
    const v = verdictsOf(db, attemptId);
    const last = v.at(-1);
    if (last?.verdict === "disputed") throw new ApiError(409, "ALREADY_DISPUTED", "You already disagreed with this check");
    if (last?.verdict !== "incorrect" || last.source !== "model") throw new ApiError(409, "NOT_DISPUTABLE", "Only the local model's remarks can be disputed");
    appendVerdict(db, deps.newId, deps.now(), attemptId, { verdict: "disputed", source: "learner", feedback: { ...last.feedback, note: reason ? `Disputed by the learner: ${reason.slice(0, 500)}` : "Disputed by the learner." } });
  }).immediate();
}

/* ---------------------------------------------------------------------------------------------- finishing */

export function evidenceOf(db: Db, run: LoadedRun): ItemEvidence[] {
  return factsOf(db, run, attemptsOf(db, run.id), eventsOf(db, run.id))
    .filter((f) => f.key !== "s1")
    .map((f) => ({ key: f.key, stage: stageOfKey(f.key) as 2 | 3 | 4 | 5, attempts: f.attempts.map((a) => ({ at: a.createdAt, verdict: a.verdict })), events: f.events.map((e) => ({ at: e.at, kind: e.kind })) }));
}

export function completeRun(db: Db, deps: RunDeps, runId: string): { score: number } {
  return db
    .transaction(() => {
      const run = loadRun(db, runId);
      if (run.status === "completed") return { score: run.score! };
      if (!allDone(db, run)) throw new ApiError(409, "WORD_LESSON_NOT_FINISHED", "Finish all five stages first");
      const result = scoreRun(evidenceOf(db, run));
      const stages = result.stages.map((s) => ({ ...s, title: WORD_LESSON_STAGES[s.stage - 1]!.title }));
      db.prepare("UPDATE word_lesson_runs SET status = 'completed', completed_at = ?, score = ?, score_version = ?, score_json = ? WHERE id = ? AND status = 'active'").run(deps.now().toISOString(), result.score, result.version, JSON.stringify({ ...result, stages, activeMs: activeMsOf(db, runId) }), runId);
      const xp = Math.round((result.score / 100) * XP_WORD_LESSON);
      if (xp > 0) awardModeXp(db, { id: deps.newId(), source: "wordLesson", sourceId: runId, amount: xp, at: deps.now().toISOString() });
      return { score: result.score };
    })
    .immediate();
}
