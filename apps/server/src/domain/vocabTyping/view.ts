import { SCREENING_LOOKAHEAD, vocabTypingSettings, type VtCard, type VtEstimateView, type VtSessionState } from "@english-lab/contracts";
import type { Db } from "../../db/open.js";
import { loadSettings } from "../sessions/policy.js";
import { estimateNow, estimateView, loadFacts, wordFacts, type Deps } from "./data.js";
import { gapSentence } from "./grade.js";
import { currentCard, emptyReason, lastCheckResult } from "./learning.js";
import { QUEUE_DEFAULTS, type LearnPlan } from "./queue.js";
import type { ScreeningPlan } from "./screening.js";
import { sentenceFor } from "./sentences.js";
import { loadSession, summaryOf } from "./sessions.js";

function screeningCard(db: Db, plan: ScreeningPlan, sessionId: string): { card: VtCard | null; done: number } {
  const done = new Set((db.prepare("SELECT lemma FROM vocab_typing_events WHERE session_id = ? AND stage = 'screening'").all(sessionId) as Array<{ lemma: string }>).map((r) => r.lemma));
  const k = plan.words.findIndex((w) => !done.has(w.lemma));
  if (k < 0) return { card: null, done: done.size };
  const upcoming = plan.words.slice(k + 1).filter((w) => !done.has(w.lemma)).slice(0, SCREENING_LOOKAHEAD).map((w) => wordFacts(db, w.lemma));
  return { card: { kind: "screen", cardIndex: k, word: wordFacts(db, plan.words[k]!.lemma), upcoming }, done: done.size };
}

/**
 * What the page gets for a session. A check card carries only the gapped sentence, its Russian translation and the part of speech: the word, its
 * transcription and translation, the answer and the audio stay on the server until the answer is in (D169).
 */
export function sessionState(db: Db, sessionId: string): VtSessionState {
  const s = loadSession(db, sessionId);
  const settings = vocabTypingSettings(loadSettings(db).values);
  let card: VtCard | null = null;
  let done = 0;
  let total = 0;
  let estimate: VtEstimateView | null = null;
  let lastCheck: VtSessionState["lastCheck"] = null;
  if (s.stage === "screening") {
    const plan = s.plan as ScreeningPlan;
    const r = screeningCard(db, plan, sessionId);
    card = s.status === "active" ? r.card : null;
    done = r.done;
    total = plan.words.length;
    if (r.card === null) estimate = estimateView(estimateNow(db, loadFacts(db)));
  } else {
    const plan = s.plan as LearnPlan;
    const next = s.status === "active" ? currentCard(db, sessionId, plan) : null;
    done = (db.prepare("SELECT (SELECT COUNT(*) FROM vocab_typing_events WHERE session_id = ? AND card_index IS NOT NULL) + (SELECT COUNT(*) FROM vocab_typing_reviews WHERE session_id = ?) AS n").get(sessionId, sessionId) as { n: number }).n;
    total = Math.min(plan.params.maxCards, plan.words.length * QUEUE_DEFAULTS.maxShows);
    lastCheck = lastCheckResult(db, sessionId);
    if (next) {
      const t = sentenceFor(db, next.sentenceId, next.word.lemma);
      const word = wordFacts(db, next.word.lemma);
      card =
        next.kind === "check"
          ? { kind: "check", cardIndex: next.cardIndex, gapped: gapSentence(t.text, t.start, t.length), textRu: t.textRu, pos: word.pos }
          : { kind: "learn", cardIndex: next.cardIndex, word, sentence: { id: t.id, text: t.text, textRu: t.textRu, targetStart: t.start, targetLength: t.length, seenBefore: next.seenBefore }, show: next.show, maxShows: plan.params.maxShows };
    }
  }
  return {
    sessionId,
    stage: s.stage,
    status: s.status,
    finished: s.status !== "active" || card === null,
    card,
    lastCheck,
    progress: { done, total },
    summary: summaryOf(db, sessionId),
    metrics: s.metrics,
    estimate,
    empty: null,
    settings: { speakWord: settings.speakWord, speakSentence: settings.speakSentence },
  };
}

/** the state of a Learning start that found nothing to do (no session is created) */
export function emptyLearningState(db: Db, _deps: Deps): VtSessionState {
  const settings = vocabTypingSettings(loadSettings(db).values);
  return {
    sessionId: "",
    stage: "learning",
    status: "completed",
    finished: true,
    card: null,
    lastCheck: null,
    progress: { done: 0, total: 0 },
    summary: { screened: 0, known: 0, unknown: 0, notUseful: 0, cards: 0, learned: 0, stillLearning: 0, checksPassed: 0, checksFailed: 0, checksSkipped: 0 },
    metrics: null,
    estimate: null,
    empty: emptyReason(db),
    settings: { speakWord: settings.speakWord, speakSentence: settings.speakSentence },
  };
}
