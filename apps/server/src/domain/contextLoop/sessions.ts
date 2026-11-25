import { createHash } from "node:crypto";
import type { ContextLoopAids, ContextLoopCheckOutcome, ContextLoopCheckResult, ContextLoopState, ContextLoopStatus } from "@english-lab/contracts";
import type { Db } from "../../db/open.js";
import { ApiError } from "../../errors.js";
import { learningDate } from "../journey/calendar.js";
import { overlapsRecordedActivity } from "../journey/intervals.js";
import { awardModeXp, XP_CONTEXT_LOOP_CARD, XP_CONTEXT_LOOP_CHECK } from "../sessions/modeXp.js";
import { normalizeWord } from "../vocabulary/forms.js";
import type { SenseSnapshot } from "../wordLessons/runner.js";
import { gapOut, lessonWord } from "../wordLessons/validate.js";
import { buildPlan } from "./plan.js";
import { CONTEXT_LOOP_QUEUE_VERSION, isCheck, nextCard, summarise, type NextCard, type QueueAttempt, type SessionPlan } from "./queue.js";
import { coverage, CURRENT_STATUS, type Deps } from "./sentences.js";

export const CONTEXT_LOOP_RULE_VERSION = "context-loop-v1";

interface SessionRow {
  id: string;
  tabId: string;
  status: "active" | "completed";
  plan: SessionPlan;
  startedAt: string;
  completedAt: string | null;
}

/** the stored plan without sentences the learner hid (or that were flagged) after the session started */
function livePlan(db: Db, plan: SessionPlan): SessionPlan {
  const ids = plan.words.flatMap((w) => w.sentences.map((s) => s.id));
  if (ids.length === 0) return plan;
  const usable = new Set((db.prepare(`SELECT s.id FROM context_loop_sentences s WHERE s.id IN (${ids.map(() => "?").join(",")}) AND ${CURRENT_STATUS} IN ('validated','approved')`).all(...ids) as Array<{ id: string }>).map((r) => r.id));
  return { ...plan, words: plan.words.map((w) => ({ ...w, sentences: w.sentences.filter((s) => usable.has(s.id)), check: w.check && usable.has(w.check.sentenceId) ? w.check : null })) };
}

function loadSession(db: Db, id: string): SessionRow {
  const r = db.prepare("SELECT id, tab_id AS tabId, status, plan_json AS p, started_at AS startedAt, completed_at AS completedAt FROM context_loop_sessions WHERE id = ?").get(id) as (Omit<SessionRow, "plan"> & { p: string }) | undefined;
  if (!r) throw new ApiError(404, "CONTEXT_SESSION_NOT_FOUND", "Unknown Context Loop session");
  return { ...r, plan: livePlan(db, JSON.parse(r.p) as SessionPlan) };
}

const attemptsOf = (db: Db, id: string): QueueAttempt[] =>
  db.prepare("SELECT card_index AS cardIndex, entry_id AS entryId, sentence_id AS sentenceId, outcome FROM context_loop_attempts WHERE session_id = ? ORDER BY card_index").all(id) as QueueAttempt[];

const activeId = (db: Db): string | null => (db.prepare("SELECT id FROM context_loop_sessions WHERE status = 'active' LIMIT 1").get() as { id: string } | undefined)?.id ?? null;

export function contextLoopStatus(db: Db): ContextLoopStatus {
  const c = coverage(db);
  return { playableWords: c.playable, readyWords: c.ready, missingWords: c.missing, activeSessionId: activeId(db) };
}

interface SentenceFacts {
  text: string;
  targetStart: number;
  targetLength: number;
  targetSurface: string;
  translationRu: string | null;
  sense: SenseSnapshot;
}
function sentenceFacts(db: Db, id: string): SentenceFacts {
  const r = db.prepare("SELECT text, target_start AS targetStart, target_length AS targetLength, target_surface AS targetSurface, translation_ru AS translationRu, sense_json AS sense FROM context_loop_sentences WHERE id = ?").get(id) as Omit<SentenceFacts, "sense"> & { sense: string };
  return { ...r, sense: JSON.parse(r.sense) as SenseSnapshot };
}

function lastCheckOf(db: Db, sessionId: string): ContextLoopCheckResult | null {
  const r = db
    .prepare(
      `SELECT a.card_index AS cardIndex, a.kind, a.outcome, a.form_match AS formMatch, a.answer_text AS answer, s.target_surface AS expected, s.lemma, s.text AS sentence
         FROM context_loop_attempts a JOIN context_loop_sentences s ON s.id = a.sentence_id WHERE a.session_id = ? ORDER BY a.card_index DESC LIMIT 1`,
    )
    .get(sessionId) as (ContextLoopCheckResult & { kind: string }) | undefined;
  if (!r || r.kind !== "check") return null;
  return { cardIndex: r.cardIndex, outcome: r.outcome, formMatch: r.formMatch, answer: r.answer, expected: r.expected, lemma: r.lemma, sentence: r.sentence };
}

/** the sentence with the word replaced by a gap (code-checked at plan time; the offsets are a fallback) */
function gapped(f: SentenceFacts, lemma: string): string {
  return gapOut(f.text, lessonWord(lemma, f.sense.surfaceForms, f.sense.irregularForms)) ?? `${f.text.slice(0, f.targetStart)}___${f.text.slice(f.targetStart + f.targetLength)}`;
}

export function sessionState(db: Db, id: string, voice = false): ContextLoopState {
  const s = loadSession(db, id);
  const attempts = attemptsOf(db, id);
  const next = s.status === "active" ? nextCard(s.plan, attempts) : null;
  const sum = summarise(s.plan, attempts);
  let card: ContextLoopState["card"] = null;
  if (next) {
    const f = sentenceFacts(db, next.sentenceId);
    card =
      next.kind === "check"
        ? // the English word, the full sentence and the picture stay on the server until the answer is in
          { cardIndex: next.cardIndex, kind: "check", gapped: gapped(f, next.word.lemma), cue: { translationRu: next.word.meaning.translationRu, pos: next.word.meaning.pos }, encounter: next.encounter, voice }
        : {
            cardIndex: next.cardIndex,
            kind: "card",
            entryId: next.word.entryId,
            lemma: next.word.lemma,
            sentence: { id: next.sentenceId, text: f.text, targetStart: f.targetStart, targetLength: f.targetLength, translationRu: f.translationRu },
            meaning: next.word.meaning,
            sameSentenceAgain: next.sameInSession,
            // for the label: a later encounter in a sentence not shown in this session (the stored new_context means "never shown in any session")
            newContext: next.encounter > 1 && !next.sameInSession,
            encounter: next.encounter,
          };
  }
  const checks = attempts.filter((a) => isCheck(a.outcome));
  return {
    sessionId: id,
    status: s.status,
    finished: s.status === "completed" || next === null,
    card,
    lastCheck: lastCheckOf(db, id),
    progress: { cards: attempts.length, maxCards: s.plan.params.maxCards, wordsDone: sum.wordsDone, wordsTotal: s.plan.words.length },
    summary: {
      cards: sum.cards,
      words: sum.wordsStarted,
      firstTry: sum.firstTry,
      newContextSuccess: sum.newContextSuccess,
      checks: { correct: checks.filter((a) => a.outcome === "correct").length, total: checks.filter((a) => a.outcome !== "skipped").length },
      returns: sum.returns,
      needsWork: sum.needsWork,
      perWord: sum.perWord,
    },
  };
}

const seedOf = (id: string): number => parseInt(createHash("sha256").update(id).digest("hex").slice(0, 7), 16);

/** the open session continues (this tab takes it over); otherwise a new one from the words that need it most */
export function startSession(db: Db, deps: Deps, tabId: string): { sessionId: string; resumed: boolean } {
  return db
    .transaction(() => {
      const open = activeId(db);
      if (open) {
        db.prepare("UPDATE context_loop_sessions SET tab_id = ? WHERE id = ?").run(tabId, open);
        return { sessionId: open, resumed: true };
      }
      const id = deps.newId();
      const seed = seedOf(id);
      const plan = buildPlan(db, deps.now(), seed);
      if (!plan) throw new ApiError(409, "NO_CONTEXT_SENTENCES", "No word has sentences for Context Loop yet. Prepare them in Content Studio → Vocabulary.");
      db.prepare("INSERT INTO context_loop_sessions(id, tab_id, status, plan_json, seed, queue_version, started_at) VALUES (?,?,?,?,?,?,?)").run(id, tabId, "active", JSON.stringify(plan), seed, CONTEXT_LOOP_QUEUE_VERSION, deps.now().toISOString());
      return { sessionId: id, resumed: false };
    })
    .immediate();
}

export interface AnswerInput {
  id: string;
  tabId: string;
  cardIndex: number;
  outcome: "recalled" | "not_recalled";
  aids: ContextLoopAids;
}

/** one self-assessed card (append-only). The same id again changes nothing; the card must be the current one; XP by D158 in the same transaction. */
export function answerCard(db: Db, deps: Deps, sessionId: string, b: AnswerInput): void {
  db.transaction(() => {
    const prev = db.prepare("SELECT session_id AS s, card_index AS c, outcome AS o FROM context_loop_attempts WHERE id = ?").get(b.id) as { s: string; c: number; o: string } | undefined;
    if (prev) {
      if (prev.s !== sessionId || prev.c !== b.cardIndex || prev.o !== b.outcome) throw new ApiError(409, "ANSWER_ID_CONFLICT", "This answer id was already used for another answer");
      return;
    }
    const s = loadSession(db, sessionId);
    if (s.status !== "active") throw new ApiError(409, "CONTEXT_SESSION_NOT_ACTIVE", "This session is finished");
    if (s.tabId !== b.tabId) throw new ApiError(409, "LEASE_REQUIRED", "This session is open in another tab");
    const next = nextCard(s.plan, attemptsOf(db, sessionId));
    if (!next) throw new ApiError(409, "CONTEXT_SESSION_FINISHED", "There are no more cards in this session");
    if (next.cardIndex !== b.cardIndex) throw new ApiError(409, "CARD_MISMATCH", "This is not the current card");
    if (next.kind !== "card") throw new ApiError(409, "CHECK_EXPECTED", "This card asks you to type or say the word");
    const seenBefore = db.prepare("SELECT 1 FROM context_loop_attempts WHERE sentence_id = ? LIMIT 1").get(next.sentenceId) !== undefined;
    const now = deps.now();
    const aids = { wordAudio: Boolean(b.aids.wordAudio), sentenceAudio: Boolean(b.aids.sentenceAudio), translation: Boolean(b.aids.translation) };
    db.prepare(
      `INSERT INTO context_loop_attempts(id, session_id, card_index, entry_id, sentence_id, kind, encounter, new_context, same_in_session, outcome, aids_json, rule_version, local_date, created_at)
       VALUES (?,?,?,?,?,'card',?,?,?,?,?,?,?,?)`,
    ).run(b.id, sessionId, next.cardIndex, next.word.entryId, next.sentenceId, next.encounter, seenBefore ? 0 : 1, next.sameInSession ? 1 : 0, b.outcome, JSON.stringify(aids), CONTEXT_LOOP_RULE_VERSION, learningDate(now.getTime()), now.toISOString());
    // D158: recalled on the first encounter or in a sentence not shown before in this session; nothing for a repeated sentence or a miss
    if (b.outcome === "recalled" && (next.encounter === 1 || !next.sameInSession)) awardModeXp(db, { id: deps.newId(), source: "contextLoop", sourceId: b.id, amount: XP_CONTEXT_LOOP_CARD, at: now.toISOString() });
  }).immediate();
}

/** the current card of an active session for this tab (caller's transaction) */
function current(db: Db, sessionId: string, tabId: string, cardIndex: number): NextCard {
  const s = loadSession(db, sessionId);
  if (s.status !== "active") throw new ApiError(409, "CONTEXT_SESSION_NOT_ACTIVE", "This session is finished");
  if (s.tabId !== tabId) throw new ApiError(409, "LEASE_REQUIRED", "This session is open in another tab");
  const next = nextCard(s.plan, attemptsOf(db, sessionId));
  if (!next) throw new ApiError(409, "CONTEXT_SESSION_FINISHED", "There are no more cards in this session");
  if (next.cardIndex !== cardIndex) throw new ApiError(409, "CARD_MISMATCH", "This is not the current card");
  return next;
}

/** the first letter of the hidden word (a hint: a right answer after it counts much less, D156) */
export function checkFirstLetter(db: Db, deps: Deps, sessionId: string, tabId: string, cardIndex: number): { letter: string } {
  return db
    .transaction(() => {
      const next = current(db, sessionId, tabId, cardIndex);
      if (next.kind !== "check") throw new ApiError(409, "NOT_A_CHECK", "This card is not a check");
      // recorded here, before the letter leaves the server: the answer counts as helped whatever the page says later (a reload forgets it)
      db.prepare("INSERT INTO context_loop_hints(session_id, card_index, kind, created_at) VALUES (?,?,'first_letter',?) ON CONFLICT DO NOTHING").run(sessionId, cardIndex, deps.now().toISOString());
      return { letter: sentenceFacts(db, next.sentenceId).targetSurface.charAt(0).toLowerCase() };
    })
    .immediate();
}

/**
 * Grading by code only (D159): case, spaces and outer punctuation are ignored. The exact form of the sentence or another form of the same word is
 * right; a listed synonym is "close" (neither right nor a miss); anything else is wrong. "I don't know" is `skipped` (no penalty, no success).
 */
export function gradeCheck(answer: string, expected: string, lemma: string, sense: SenseSnapshot): { outcome: ContextLoopCheckOutcome; formMatch: "exact" | "other_form" | null } {
  const a = normalizeWord(answer);
  if (a === normalizeWord(expected)) return { outcome: "correct", formMatch: "exact" };
  const w = lessonWord(lemma, sense.surfaceForms, sense.irregularForms);
  if (a === w.lemma || w.forms.includes(a)) return { outcome: "correct", formMatch: "other_form" };
  if (sense.synonyms.map(normalizeWord).includes(a)) return { outcome: "synonym", formMatch: null };
  return { outcome: "incorrect", formMatch: null };
}

export interface CheckInput {
  id: string;
  tabId: string;
  cardIndex: number;
  /** null = "I don't know" */
  text: string | null;
  firstLetter: boolean;
  /** a spoken answer: what was recognised and by which model (no audio) */
  voice?: { asrText: string; sttModelId: string };
}

/** one typed or spoken check (append-only, idempotent by id); XP by D158 in the same transaction */
export function answerCheck(db: Db, deps: Deps, sessionId: string, b: CheckInput): void {
  db.transaction(() => {
    const text = b.text === null ? null : b.text.trim();
    const prev = db.prepare("SELECT session_id AS s, card_index AS c, answer_text AS t FROM context_loop_attempts WHERE id = ?").get(b.id) as { s: string; c: number; t: string | null } | undefined;
    if (prev) {
      if (prev.s !== sessionId || prev.c !== b.cardIndex || prev.t !== text) throw new ApiError(409, "ANSWER_ID_CONFLICT", "This answer id was already used for another answer");
      return;
    }
    const next = current(db, sessionId, b.tabId, b.cardIndex);
    if (next.kind !== "check") throw new ApiError(409, "NOT_A_CHECK", "This card is not a check");
    if (text !== null && !text) throw new ApiError(400, "ANSWER_EMPTY", "Type or say the word, or choose I don't know");
    const f = sentenceFacts(db, next.sentenceId);
    const hinted = b.firstLetter || db.prepare("SELECT 1 FROM context_loop_hints WHERE session_id = ? AND card_index = ?").get(sessionId, next.cardIndex) !== undefined;
    const g = text === null ? { outcome: "skipped" as const, formMatch: null } : gradeCheck(text, f.targetSurface, next.word.lemma, f.sense);
    const now = deps.now();
    const voice = text !== null && b.voice ? b.voice : null;
    db.prepare(
      `INSERT INTO context_loop_attempts(id, session_id, card_index, entry_id, sentence_id, kind, encounter, new_context, same_in_session, outcome, input, answer_text, asr_text, asr_edited, stt_model_id, form_match, first_letter_hint, aids_json, rule_version, local_date, created_at)
       VALUES (?,?,?,?,?,'check',?,0,?,?,?,?,?,?,?,?,?,'{}',?,?,?)`,
    ).run(
      b.id,
      sessionId,
      next.cardIndex,
      next.word.entryId,
      next.sentenceId,
      next.encounter,
      next.sameInSession ? 1 : 0,
      g.outcome,
      text === null ? null : voice ? "voice" : "text",
      text,
      voice?.asrText ?? null,
      voice ? (voice.asrText.trim() !== text ? 1 : 0) : null,
      voice?.sttModelId ?? null,
      g.formMatch,
      hinted ? 1 : 0,
      CONTEXT_LOOP_RULE_VERSION,
      learningDate(now.getTime()),
      now.toISOString(),
    );
    if (g.outcome === "correct") awardModeXp(db, { id: deps.newId(), source: "contextLoop", sourceId: b.id, amount: hinted ? XP_CONTEXT_LOOP_CARD : XP_CONTEXT_LOOP_CHECK, at: now.toISOString() });
  }).immediate();
}

export function completeSession(db: Db, deps: Deps, sessionId: string): void {
  db.transaction(() => {
    const s = loadSession(db, sessionId);
    if (s.status === "active") db.prepare("UPDATE context_loop_sessions SET status = 'completed', completed_at = ? WHERE id = ?").run(deps.now().toISOString(), sessionId);
  }).immediate();
}

export interface Interval {
  id: string;
  tabId: string;
  startMs: number;
  endMs: number;
}

/** visible time of a session: short intervals, written once, never overlapping any recorded activity (D157) */
export function recordActivity(db: Db, deps: Deps, sessionId: string, b: Interval): { recorded: boolean } {
  return db
    .transaction(() => {
      const prev = db.prepare("SELECT session_id AS s, tab_id AS t, start_ms AS a, end_ms AS e FROM context_loop_activity_intervals WHERE id = ?").get(b.id) as { s: string; t: string; a: number; e: number } | undefined;
      if (prev) {
        if (prev.s !== sessionId || prev.t !== b.tabId || prev.a !== b.startMs || prev.e !== b.endMs) throw new ApiError(409, "ACTIVITY_ID_CONFLICT", "Activity interval id already used");
        return { recorded: false };
      }
      const s = loadSession(db, sessionId);
      const now = deps.now().getTime();
      if (b.endMs <= b.startMs || b.endMs - b.startMs > 15000 || b.startMs < Date.parse(s.startedAt) || b.endMs > now + 2000 || (s.completedAt && b.endMs > Date.parse(s.completedAt) + 2000)) throw new ApiError(400, "ACTIVITY_INVALID", "Invalid activity interval");
      if (s.status === "active" && s.tabId !== b.tabId) throw new ApiError(409, "LEASE_REQUIRED", "This session is open in another tab");
      if (overlapsRecordedActivity(db, b.startMs, b.endMs)) throw new ApiError(409, "ACTIVITY_OVERLAP", "Activity interval overlaps a recorded interval");
      db.prepare("INSERT INTO context_loop_activity_intervals(id, session_id, tab_id, start_ms, end_ms, recorded_at) VALUES (?,?,?,?,?,?)").run(b.id, sessionId, b.tabId, b.startMs, b.endMs, deps.now().toISOString());
      return { recorded: true };
    })
    .immediate();
}
