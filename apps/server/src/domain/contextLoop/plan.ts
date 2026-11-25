import { contextLoopCards, contextLoopChecks, CONTEXT_LOOP_PLAYABLE } from "@english-lab/contracts";
import { learningDate } from "../journey/calendar.js";
import { gapOut, lessonWord, wordCount } from "../wordLessons/validate.js";
import type { Db } from "../../db/open.js";
import { loadSettings } from "../sessions/policy.js";
import { normalizeWord } from "../vocabulary/forms.js";
import { rng, wordState, type WordEvent, type WordState } from "../vocabulary/schedule.js";
import { eligibleWords } from "../wordLessons/selection.js";
import { CONTEXT_LOOP_QUEUE_VERSION, QUEUE_DEFAULTS, type PlanWord, type SessionPlan } from "./queue.js";
import { usableByEntry } from "./sentences.js";

/** at most this many words never practised in Context Loop per session (the rest are due or not-yet-due words) */
export const NEW_WORDS_PER_SESSION = 4;

/**
 * The scheduling events of one word from earlier Context Loop sessions (D154): only the FIRST encounter of a word in a session counts (later ones
 * in the same session are practice), plus the typed/spoken checks. A "recalled" on a sentence seen before is not independent (the streak does not grow).
 * Vocabulary Practice keeps its own events; nothing here feeds vocabulary-selection-v4.
 */
export function contextLoopEvents(db: Db): Map<string, WordEvent[]> {
  const rows = db
    .prepare(
      `SELECT a.entry_id AS entryId, a.session_id AS sessionId, a.card_index AS slot, a.sentence_id AS sentenceId, a.kind, a.encounter, a.new_context AS newContext, a.outcome, a.first_letter_hint AS hint, a.created_at AS at
         FROM context_loop_attempts a ORDER BY a.created_at, a.rowid`,
    )
    .all() as Array<{ entryId: string; sessionId: string; slot: number; sentenceId: string; kind: "card" | "check"; encounter: number; newContext: number; outcome: string; hint: number; at: string }>;
  const out = new Map<string, WordEvent[]>();
  for (const r of rows) {
    let e: WordEvent | null = null;
    const base = { at: r.at, revisionId: r.sentenceId, slotId: `${r.sessionId}:${r.slot}` };
    if (r.kind === "card" && r.encounter === 1) e = r.outcome === "recalled" ? { ...base, outcome: "success", independent: r.newContext === 1 } : { ...base, outcome: "miss" };
    else if (r.kind === "check" && (r.outcome === "correct" || r.outcome === "incorrect")) e = r.outcome === "correct" ? (r.hint ? { ...base, outcome: "assisted" } : { ...base, outcome: "success" }) : { ...base, outcome: "miss" };
    if (e) (out.get(r.entryId) ?? out.set(r.entryId, []).get(r.entryId)!).push(e);
  }
  return out;
}

/** §5.1: due words by priority, then up to four new words, then not-yet-due words, then more new words; at most eight words. */
export function buildPlan(db: Db, now: Date, seed: number): SessionPlan | null {
  const usable = usableByEntry(db);
  const words = eligibleWords(db).eligible.filter((w) => !w.learned && (usable.get(w.entryId)?.length ?? 0) >= CONTEXT_LOOP_PLAYABLE);
  if (words.length === 0) return null;
  const events = contextLoopEvents(db);
  const rand = rng(`context-loop:${seed}`);
  const jitter = new Map(words.map((w) => [w.entryId, rand()]));
  const states = new Map<string, WordState>(words.map((w) => [w.entryId, wordState(normalizeWord(w.lemma), events.get(w.entryId) ?? [], false, now)]));
  const st = (id: string) => states.get(id)!;
  const tie = (a: string, b: string) => jitter.get(a)! - jitter.get(b)!;
  const ids = words.map((w) => w.entryId);
  const due = ids.filter((id) => st(id).state !== "new" && st(id).due).sort((a, b) => st(b).priority - st(a).priority || tie(a, b));
  const fresh = ids.filter((id) => st(id).state === "new").sort(tie);
  const later = ids.filter((id) => st(id).state !== "new" && !st(id).due).sort((a, b) => st(b).ratio - st(a).ratio || tie(a, b));
  const order = [...due, ...fresh.slice(0, NEW_WORDS_PER_SESSION), ...later, ...fresh.slice(NEW_WORDS_PER_SESSION)].slice(0, QUEUE_DEFAULTS.maxWords);

  // which sentences the learner has already seen (any session), and when last
  const lastSeen = new Map((db.prepare("SELECT sentence_id AS id, MAX(created_at) AS at FROM context_loop_attempts GROUP BY sentence_id").all() as Array<{ id: string; at: string }>).map((r) => [r.id, r.at]));
  const byId = new Map(words.map((w) => [w.entryId, w]));
  const planWords: PlanWord[] = order.map((id) => {
    const list = usable.get(id)!;
    const unseen = list.filter((s) => !lastSeen.has(s.id)).sort((a, b) => (a.id < b.id ? -1 : 1));
    for (let i = unseen.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [unseen[i], unseen[j]] = [unseen[j]!, unseen[i]!];
    }
    const seen = list.filter((s) => lastSeen.has(s.id)).sort((a, b) => lastSeen.get(a.id)!.localeCompare(lastSeen.get(b.id)!));
    const sense = list[0]!.sense;
    return {
      entryId: id,
      lemma: byId.get(id)!.lemma,
      wasReview: st(id).state === "review",
      sentences: [...unseen.map((s) => ({ id: s.id, seen: false })), ...seen.map((s) => ({ id: s.id, seen: true }))],
      meaning: { translationRu: byId.get(id)!.translationRu, definitionRu: sense.definitionRu, pos: sense.pos },
    };
  });
  // D159: up to `contextLoopChecks` words recalled on an earlier day get one typed/spoken check, on a sentence they recalled before
  const today = learningDate(now.getTime());
  let checks = contextLoopChecks(loadSettings(db).values);
  const recalled = db.prepare("SELECT sentence_id AS id, created_at AS at FROM context_loop_attempts WHERE entry_id = ? AND outcome = 'recalled' ORDER BY created_at DESC, rowid DESC");
  for (const w of planWords) {
    if (checks <= 0) break;
    const list = usable.get(w.entryId)!;
    const word = lessonWord(w.lemma, list[0]!.sense.surfaceForms, list[0]!.sense.irregularForms);
    const before = (recalled.all(w.entryId) as Array<{ id: string; at: string }>).filter((r) => learningDate(Date.parse(r.at)) < today);
    const pick = before.map((r) => list.find((s) => s.id === r.id)).find((s) => {
      const gapped = s ? gapOut(s.text, word) : null;
      return gapped !== null && wordCount(gapped) >= 4;
    });
    if (pick) {
      w.check = { sentenceId: pick.id };
      checks--;
    }
  }
  const p = QUEUE_DEFAULTS;
  return {
    version: CONTEXT_LOOP_QUEUE_VERSION,
    params: { missGap: p.missGap, missSpread: p.missSpread, verifyGap: p.verifyGap, sameSentenceMisses: p.sameSentenceMisses, maxEncounters: p.maxEncounters, maxCards: contextLoopCards(loadSettings(db).values) },
    words: planWords,
  };
}
