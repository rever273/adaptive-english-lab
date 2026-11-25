import type { Db } from "../../db/open.js";
import type { Deps } from "./data.js";

/** the latest status row of a (sentence, lemma) pair decides (D166); a row without `lemma` speaks for every lemma of the sentence */
export const TARGET_STATUS = "(SELECT st.status FROM vocab_typing_sentence_status st WHERE st.sentence_id = t.sentence_id AND (st.lemma IS NULL OR st.lemma = t.lemma) ORDER BY st.created_at DESC, st.rowid DESC LIMIT 1)";
const USABLE = `${TARGET_STATUS} = 'validated'`;

/** how many usable sentences each lemma has */
export function usableCounts(db: Db): Map<string, number> {
  return new Map((db.prepare(`SELECT t.lemma, COUNT(*) AS n FROM vocab_typing_sentence_targets t WHERE ${USABLE} GROUP BY t.lemma`).all() as Array<{ lemma: string; n: number }>).map((r) => [r.lemma, r.n]));
}

export interface SentenceCandidate {
  id: string;
  lemma: string;
  text: string;
  textRu: string;
  start: number;
  length: number;
  surface: string;
  ambiguous: boolean;
  rank: number;
}

const COLS = "t.sentence_id AS id, t.lemma, s.text_en AS text, s.text_ru AS textRu, t.start, t.length, t.surface, t.ambiguous, t.rank_for_lemma AS rank";

/** usable sentences of a word, best first (the import ranks them) */
export function usableSentences(db: Db, lemma: string): SentenceCandidate[] {
  return (db.prepare(`SELECT ${COLS} FROM vocab_typing_sentence_targets t JOIN vocab_typing_sentences s ON s.id = t.sentence_id WHERE t.lemma = ? AND ${USABLE} ORDER BY t.rank_for_lemma`).all(lemma) as Array<Omit<SentenceCandidate, "ambiguous"> & { ambiguous: number }>).map((r) => ({ ...r, ambiguous: r.ambiguous === 1 }));
}

export function sentenceFor(db: Db, sentenceId: string, lemma: string): SentenceCandidate {
  const r = db.prepare(`SELECT ${COLS} FROM vocab_typing_sentence_targets t JOIN vocab_typing_sentences s ON s.id = t.sentence_id WHERE t.sentence_id = ? AND t.lemma = ?`).get(sentenceId, lemma) as (Omit<SentenceCandidate, "ambiguous"> & { ambiguous: number }) | undefined;
  if (!r) throw new Error(`unknown sentence ${sentenceId} for ${lemma}`);
  return { ...r, ambiguous: r.ambiguous === 1 };
}

/** is the pair still usable (not flagged after the session started) */
export function isUsable(db: Db, sentenceId: string, lemma: string): boolean {
  return db.prepare(`SELECT 1 FROM vocab_typing_sentence_targets t WHERE t.sentence_id = ? AND t.lemma = ? AND ${USABLE}`).get(sentenceId, lemma) !== undefined;
}

/** "Bad example": the pair is hidden for this word from now on (append-only, the sentence itself is never changed) */
export function flagPair(db: Db, deps: Deps, sentenceId: string, lemma: string, reason: string): void {
  db.prepare("INSERT INTO vocab_typing_sentence_status(id, sentence_id, lemma, status, actor, reason, created_at) VALUES (?,?,?,'flagged','learner',?,?)").run(deps.newId(), sentenceId, lemma, reason, deps.now().toISOString());
}

/** sentence ids already shown (typed, answered or checked) for this word in earlier sessions */
export function seenSentences(db: Db, lemma: string, exceptSession?: string): Set<string> {
  const rows = db
    .prepare("SELECT sentence_id AS id FROM vocab_typing_events WHERE lemma = ? AND stage = 'learning' AND session_id IS NOT ? UNION SELECT sentence_id FROM vocab_typing_reviews WHERE lemma = ? AND session_id IS NOT ?")
    .all(lemma, exceptSession ?? null, lemma, exceptSession ?? null) as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}
