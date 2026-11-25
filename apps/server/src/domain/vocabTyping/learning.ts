import { createHash } from "node:crypto";
import { vocabTypingSettings, type VtCheckResult, type VtTyping } from "@english-lab/contracts";
import type { Db } from "../../db/open.js";
import { ApiError } from "../../errors.js";
import { learningDate } from "../journey/calendar.js";
import { loadSettings } from "../sessions/policy.js";
import { awardModeXp, XP_VOCAB_TYPING_CHECK, XP_VOCAB_TYPING_CHECK_TYPO, XP_VOCAB_TYPING_SENTENCE } from "../sessions/modeXp.js";
import { wordFacts, type Deps } from "./data.js";
import { FSRS_VERSION } from "./fsrs.js";
import { gapSentence, gradeCloze } from "./grade.js";
import { formsOf } from "./matching.js";
import { wordInfos } from "./overview.js";
import { LEARN_QUEUE_VERSION, QUEUE_DEFAULTS, nextCard, type Answer, type LearnPlan, type NextCard, type PlanWord } from "./queue.js";
import { flagPair, isUsable, seenSentences, sentenceFor, usableSentences } from "./sentences.js";
import { activeSessionId, finish, loadSession, requireActive, typingJson } from "./sessions.js";

const seedOf = (id: string): number => parseInt(createHash("sha256").update(id).digest("hex").slice(0, 7), 16);
const PER_WORD_SENTENCES = 8;

export interface LearningPlanResult {
  plan: LearnPlan;
  settings: Record<string, number>;
}

/**
 * The plan of a new Learning session (D168): due checks first (at most `checksPerSession`), then words being learned that were met before (longest
 * ago first), then new words from the screening (most frequent first, at most `newPerSession`). Checks use up the budget before new words do.
 * Words without a usable sentence are left out (they show as "No examples").
 */
export function buildLearningPlan(db: Db, deps: Deps): LearningPlanResult | null {
  const s = vocabTypingSettings(loadSettings(db).values);
  const today = learningDate(deps.now().getTime());
  const infos = wordInfos(db).filter((w) => w.inPool && w.usable > 0);
  const due = infos.filter((w) => w.nextCheck !== null && w.nextCheck <= today).sort((a, b) => (a.nextCheck! < b.nextCheck! ? -1 : a.nextCheck! > b.nextCheck! ? 1 : a.row.rank - b.row.rank));
  const learning = infos.filter((w) => w.summary.state === "learning");
  const met = (w: (typeof learning)[number]): boolean => w.summary.learnCards > 0 || w.summary.checksFailed > 0;
  const oldOnly = learning.filter(met).sort((a, b) => (a.summary.lastContactAt! < b.summary.lastContactAt! ? -1 : 1));
  const freshOnly = learning.filter((w) => !met(w)).sort((a, b) => a.row.rank - b.row.rank);
  const max = s.learningCards;
  const checks = due.slice(0, Math.min(s.checksPerSession, max));
  let room = max - checks.length;
  const oldTake = oldOnly.slice(0, Math.max(0, room));
  room -= oldTake.length;
  const freshTake = freshOnly.slice(0, Math.max(0, Math.min(s.newPerSession, room)));
  const mk = (lemma: string, kind: "check" | "learn", isNew: boolean): PlanWord => {
    const seen = seenSentences(db, lemma);
    const all = usableSentences(db, lemma);
    const ordered = [...all.filter((x) => !seen.has(x.id)), ...all.filter((x) => seen.has(x.id))].slice(0, PER_WORD_SENTENCES);
    return { lemma, kind, isNew, sentences: ordered.map((x) => ({ id: x.id, seenBefore: seen.has(x.id) })) };
  };
  const words = [...checks.map((w) => mk(w.row.lemma, "check", false)), ...oldTake.map((w) => mk(w.row.lemma, "learn", false)), ...freshTake.map((w) => mk(w.row.lemma, "learn", true))];
  if (words.length === 0) return null;
  return {
    plan: { version: LEARN_QUEUE_VERSION, params: { maxCards: max, gap: QUEUE_DEFAULTS.gap, maxShows: QUEUE_DEFAULTS.maxShows }, words },
    settings: { learningCards: max, checksPerSession: s.checksPerSession, newPerSession: s.newPerSession, firstCheckDays: s.firstCheckDays, retention: s.retention },
  };
}

export function learningAnswers(db: Db, sessionId: string): Answer[] {
  const events = db.prepare("SELECT card_index AS cardIndex, lemma, sentence_id AS sentenceId, kind FROM vocab_typing_events WHERE session_id = ? AND stage = 'learning'").all(sessionId) as Array<{ cardIndex: number; lemma: string; sentenceId: string; kind: string }>;
  const reviews = db.prepare("SELECT card_index AS cardIndex, lemma, sentence_id AS sentenceId, rating FROM vocab_typing_reviews WHERE session_id = ?").all(sessionId) as Array<{ cardIndex: number; lemma: string; sentenceId: string; rating: string | null }>;
  return [
    ...events.map<Answer>((e) => ({ cardIndex: e.cardIndex, lemma: e.lemma, sentenceId: e.sentenceId, kind: e.kind === "learn_learned" ? "learned" : "still" })),
    ...reviews.map<Answer>((r) => ({ cardIndex: r.cardIndex, lemma: r.lemma, sentenceId: r.sentenceId, kind: r.rating === "good" ? "check_pass" : r.rating === "again" ? "check_fail" : "check_skipped" })),
  ].sort((a, b) => a.cardIndex - b.cardIndex);
}

/** pairs of the plan the learner hid (or that are no longer usable) since the session started */
export function hiddenPairs(db: Db, plan: LearnPlan): Set<string> {
  const out = new Set<string>();
  for (const w of plan.words) for (const x of w.sentences) if (!isUsable(db, x.id, w.lemma)) out.add(`${w.lemma}:${x.id}`);
  return out;
}

export function currentCard(db: Db, sessionId: string, plan: LearnPlan): NextCard | null {
  return nextCard(plan, learningAnswers(db, sessionId), hiddenPairs(db, plan));
}

/** the open session continues (this tab takes it over); a finished one is closed first. null = nothing to do now */
export function startLearning(db: Db, deps: Deps, tabId: string): { sessionId: string; resumed: boolean } | null {
  return db
    .transaction(() => {
      const open = activeSessionId(db, "learning");
      if (open) {
        const s = loadSession(db, open);
        if (currentCard(db, open, s.plan as LearnPlan)) {
          db.prepare("UPDATE vocab_typing_sessions SET tab_id = ? WHERE id = ?").run(tabId, open);
          return { sessionId: open, resumed: true };
        }
        finish(db, deps, open, "completed");
      }
      const id = deps.newId();
      const seed = seedOf(id);
      const built = buildLearningPlan(db, deps);
      if (!built) return null;
      db.prepare("INSERT INTO vocab_typing_sessions(id, stage, status, plan_json, seed, algorithm_version, settings_json, tab_id, started_at) VALUES (?,?,?,?,?,?,?,?,?)").run(id, "learning", "active", JSON.stringify(built.plan), seed, `${LEARN_QUEUE_VERSION}+${FSRS_VERSION}`, JSON.stringify(built.settings), tabId, deps.now().toISOString());
      return { sessionId: id, resumed: false };
    })
    .immediate();
}

/** why there is nothing to do: no word was ever sent to learning, or everything is done until the next check */
export function emptyReason(db: Db): { reason: "nothing_to_learn" | "all_done"; nextDue: string | null } {
  const infos = wordInfos(db).filter((w) => w.inPool);
  const dues = infos.map((w) => w.nextCheck).filter((d): d is string => d !== null).sort();
  const any = infos.some((w) => ["learning", "awaiting_verification", "verified"].includes(w.summary.state));
  return { reason: any ? "all_done" : "nothing_to_learn", nextDue: dues[0] ?? null };
}

function targetOf(db: Db, sentenceId: string, lemma: string) {
  return sentenceFor(db, sentenceId, lemma);
}

/** forms of a lemma as the word bank knows them (regular endings, irregular forms) */
function formsOfLemma(db: Db, lemma: string): string[] {
  const r = db.prepare("SELECT part_of_speech AS pos, past_forms AS past, participle_forms AS participle FROM typing_word_bank WHERE lemma = ?").get(lemma) as { pos: string; past: string; participle: string } | undefined;
  return formsOf({ lemma, pos: r?.pos ?? "", past: r ? (JSON.parse(r.past) as string[]) : [], participle: r ? (JSON.parse(r.participle) as string[]) : [] });
}

function currentFor(db: Db, sessionId: string, tabId: string, cardIndex: number): { next: NextCard; plan: LearnPlan } {
  const s = requireActive(db, sessionId, tabId);
  if (s.stage !== "learning") throw new ApiError(409, "WRONG_STAGE", "This is not a learning session");
  const plan = s.plan as LearnPlan;
  const next = currentCard(db, sessionId, plan);
  if (!next) throw new ApiError(409, "SESSION_FINISHED", "There are no more cards in this session");
  if (next.cardIndex !== cardIndex) throw new ApiError(409, "CARD_MISMATCH", "This is not the current card");
  return { next, plan };
}

export interface LearnInput {
  clientEventId: string;
  tabId: string;
  cardIndex: number;
  kind: "learn_exposure" | "learn_learned";
  typing: VtTyping;
}

/** the learner typed the sentence and chose "Still learning" (Enter) or "Learned" (Tab): append-only, idempotent by client id; XP once per word and sentence in a session */
export function recordLearn(db: Db, deps: Deps, sessionId: string, b: LearnInput): void {
  db.transaction(() => {
    const prev = db.prepare("SELECT session_id AS s, card_index AS c, kind FROM vocab_typing_events WHERE client_event_id = ?").get(b.clientEventId) as { s: string; c: number; kind: string } | undefined;
    if (prev) {
      if (prev.s !== sessionId || prev.c !== b.cardIndex || prev.kind !== b.kind) throw new ApiError(409, "EVENT_ID_CONFLICT", "This event id was already used for another answer");
      return;
    }
    const { next } = currentFor(db, sessionId, b.tabId, b.cardIndex);
    if (next.kind !== "learn") throw new ApiError(409, "CHECK_EXPECTED", "This card asks you to type the missing word");
    const now = deps.now();
    const id = deps.newId();
    const paid = db.prepare("SELECT 1 FROM vocab_typing_events WHERE session_id = ? AND lemma = ? AND sentence_id = ? AND stage = 'learning'").get(sessionId, next.word.lemma, next.sentenceId) !== undefined;
    db.prepare("INSERT INTO vocab_typing_events(id, client_event_id, session_id, lemma, stage, kind, sentence_id, is_probe, card_index, typing_json, local_date, created_at) VALUES (?,?,?,?,'learning',?,?,0,?,?,?,?)").run(id, b.clientEventId, sessionId, next.word.lemma, b.kind, next.sentenceId, next.cardIndex, typingJson(b.typing), learningDate(now.getTime()), now.toISOString());
    if (!paid) awardModeXp(db, { id: deps.newId(), source: "vocabTyping", sourceId: id, amount: XP_VOCAB_TYPING_SENTENCE, at: now.toISOString() });
  }).immediate();
}

export interface CheckInput {
  clientEventId: string;
  tabId: string;
  cardIndex: number;
  /** null = "I don't know" (F6) */
  text: string | null;
}

/** one cloze check: graded by code, stored append-only with the rating the scheduler will see; XP by D172 */
export function recordCheck(db: Db, deps: Deps, sessionId: string, b: CheckInput): void {
  db.transaction(() => {
    const text = b.text === null ? null : b.text.trim();
    const prev = db.prepare("SELECT session_id AS s, card_index AS c, answer_text AS t FROM vocab_typing_reviews WHERE client_event_id = ?").get(b.clientEventId) as { s: string; c: number; t: string | null } | undefined;
    if (prev) {
      if (prev.s !== sessionId || prev.c !== b.cardIndex || prev.t !== text) throw new ApiError(409, "EVENT_ID_CONFLICT", "This event id was already used for another answer");
      return;
    }
    const { next } = currentFor(db, sessionId, b.tabId, b.cardIndex);
    if (next.kind !== "check") throw new ApiError(409, "NOT_A_CHECK", "This card is not a check");
    if (text !== null && text.length === 0) throw new ApiError(400, "ANSWER_EMPTY", "Type the missing word, or choose I don't know");
    const t = targetOf(db, next.sentenceId, next.word.lemma);
    const g = gradeCloze(text, t.surface, formsOfLemma(db, next.word.lemma));
    const now = deps.now();
    const id = deps.newId();
    db.prepare("INSERT INTO vocab_typing_reviews(id, client_event_id, session_id, lemma, card_index, sentence_id, expected, answer_text, outcome, rating, first_answer_text, algorithm_version, local_date, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, b.clientEventId, sessionId, next.word.lemma, next.cardIndex, next.sentenceId, t.surface, text, g.outcome, g.rating, text, FSRS_VERSION, learningDate(now.getTime()), now.toISOString());
    if (g.rating === "good") awardModeXp(db, { id: deps.newId(), source: "vocabTyping", sourceId: id, amount: g.outcome === "typo" ? XP_VOCAB_TYPING_CHECK_TYPO : XP_VOCAB_TYPING_CHECK, at: now.toISOString() });
  }).immediate();
}

export interface FlagInput {
  clientEventId: string;
  tabId: string;
  cardIndex: number;
}

/** "Bad example" (F8): the pair is hidden for this word for good; a check is consumed as `skipped` (no rating), a learning card is simply replaced */
export function flagCard(db: Db, deps: Deps, sessionId: string, b: FlagInput): void {
  db.transaction(() => {
    const reason = `bad example ${b.clientEventId}`;
    if (db.prepare("SELECT 1 FROM vocab_typing_sentence_status WHERE reason = ?").get(reason) !== undefined) return;
    const { next } = currentFor(db, sessionId, b.tabId, b.cardIndex);
    flagPair(db, deps, next.sentenceId, next.word.lemma, reason);
    if (next.kind === "check") {
      const now = deps.now();
      const t = targetOf(db, next.sentenceId, next.word.lemma);
      db.prepare("INSERT INTO vocab_typing_reviews(id, client_event_id, session_id, lemma, card_index, sentence_id, expected, answer_text, outcome, rating, first_answer_text, algorithm_version, local_date, created_at) VALUES (?,?,?,?,?,?,?,NULL,'skipped',NULL,NULL,?,?,?)").run(deps.newId(), b.clientEventId, sessionId, next.word.lemma, next.cardIndex, next.sentenceId, t.surface, FSRS_VERSION, learningDate(now.getTime()), now.toISOString());
    }
  }).immediate();
}

/** the result of the last answered card when it was a check (the page shows it before the next card) */
export function lastCheckResult(db: Db, sessionId: string): VtCheckResult | null {
  const r = db
    .prepare("SELECT card_index AS cardIndex, lemma, sentence_id AS sentenceId, expected, answer_text AS answer, outcome, rating FROM vocab_typing_reviews WHERE session_id = ? ORDER BY card_index DESC LIMIT 1")
    .get(sessionId) as { cardIndex: number; lemma: string; sentenceId: string; expected: string; answer: string | null; outcome: VtCheckResult["outcome"]; rating: "good" | "again" | null } | undefined;
  if (!r) return null;
  const last = (db.prepare("SELECT MAX(card_index) AS n FROM (SELECT card_index FROM vocab_typing_events WHERE session_id = ? AND card_index IS NOT NULL UNION ALL SELECT card_index FROM vocab_typing_reviews WHERE session_id = ?)").get(sessionId, sessionId) as { n: number }).n;
  if (r.cardIndex !== last) return null;
  const t = targetOf(db, r.sentenceId, r.lemma);
  return { cardIndex: r.cardIndex, outcome: r.outcome, rating: r.rating, answer: r.answer, expected: r.expected, lemma: r.lemma, sentence: t.text, sentenceId: r.sentenceId, textRu: t.textRu, word: wordFacts(db, r.lemma) };
}

export { gapSentence };
