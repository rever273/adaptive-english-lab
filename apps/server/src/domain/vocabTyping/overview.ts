import { vocabTypingSettings, type VtOverview, type VtWordFilter, type VtWordRow, type VtWordState } from "@english-lab/contracts";
import type { Db } from "../../db/open.js";
import { ApiError } from "../../errors.js";
import { learningDate } from "../journey/calendar.js";
import { loadSettings } from "../sessions/policy.js";
import { unarchiveWord } from "./bankEdit.js";
import { estimateNow, estimateView, loadFacts, type Deps } from "./data.js";
import { dueDate, loadReviews } from "./fsrs.js";
import { usableCounts } from "./sentences.js";
import { activeSessionId } from "./sessions.js";
import { summarise, type WordSummary } from "./state.js";

interface LexRow {
  lemma: string;
  rank: number;
  band: number;
  eligibility: string;
  translationRu: string;
  contextCount: number;
  /** in the word bank and not archived */
  inBank: number;
  archivedBy: string;
}

/** every lemma of the lexicon, also the ones deleted from the bank (their translation comes from the snapshot kept with the removal) */
const lexRows = (db: Db): LexRow[] =>
  db
    .prepare(
      `SELECT l.lemma, l.freq_rank AS rank, l.band, l.eligibility,
              COALESCE(b.translation_ru, l.primary_translation_ru, '') AS translationRu,
              l.context_count AS contextCount, (b.lemma IS NOT NULL AND b.archived = 0) AS inBank, COALESCE(b.archived_by, '') AS archivedBy
         FROM vocab_typing_lexicon l LEFT JOIN typing_word_bank b ON b.lemma = l.lemma ORDER BY l.freq_rank`,
    )
    .all() as LexRow[];

export interface WordInfo {
  row: LexRow;
  summary: WordSummary;
  usable: number;
  nextCheck: string | null;
  /** in the training pool now: in the bank, not excluded, long enough and beyond the skipped top words (D177) */
  inPool: boolean;
  /** archived (by the cleanup or by the learner) or missing from the bank */
  removed: boolean;
}

/** every word of the dictionary with its current state, usable sentences and next check (derived on request) */
export function wordInfos(db: Db): WordInfo[] {
  const settings = vocabTypingSettings(loadSettings(db).values);
  const facts = loadFacts(db);
  const reviews = loadReviews(db);
  const usable = usableCounts(db);
  return lexRows(db).map((row) => {
    const f = facts.get(row.lemma);
    const summary = f ? summarise(f) : summarise([]);
    const nextCheck = f ? dueDate(summary, reviews.get(row.lemma) ?? [], settings.retention, settings.firstCheckDays) : null;
    const inPool = row.inBank === 1 && row.eligibility !== "excluded" && row.lemma.length >= settings.minLength && row.rank > settings.skipTopRanks;
    return { row, summary, usable: usable.get(row.lemma) ?? 0, nextCheck, inPool, removed: row.inBank !== 1 };
  });
}

export function buildOverview(db: Db, deps: Deps): VtOverview {
  const today = learningDate(deps.now().getTime());
  const all = wordInfos(db);
  const infos = all.filter((w) => w.inPool);
  const facts = loadFacts(db);
  const count = (s: VtWordState): number => infos.filter((w) => w.summary.state === s).length;
  const known = infos.filter((w) => w.summary.originalScreen === "known").length;
  const unknown = infos.filter((w) => w.summary.originalScreen === "unknown").length;
  const notUseful = all.filter((w) => w.summary.state === "excluded_by_learner").length; // archived by the learner
  const learning = infos.filter((w) => w.summary.state === "learning");
  const estimate = estimateView(estimateNow(db, facts));
  return {
    poolSize: infos.length,
    prepared: all.length > 0,
    screening: { screened: known + unknown, remaining: infos.length - known - unknown, known, unknown, notUseful },
    learning: {
      learning: learning.length,
      awaiting: count("awaiting_verification"),
      verified: count("verified"),
      dueNow: infos.filter((w) => w.nextCheck !== null && w.nextCheck <= today && w.usable > 0).length,
      noExamples: learning.filter((w) => w.usable === 0).length,
      playable: learning.filter((w) => w.usable > 0).length,
    },
    estimate,
    activeSessions: { screening: activeSessionId(db, "screening"), learning: activeSessionId(db, "learning") },
  };
}

export function listWords(db: Db, q: { filter?: VtWordFilter; search?: string; limit: number; offset: number }): { total: number; words: VtWordRow[] } {
  const rows = wordInfos(db)
    .filter((w) => w.inPool || w.removed || w.row.eligibility === "excluded")
    .map<VtWordRow>((w) => ({
      lemma: w.row.lemma,
      rank: w.row.rank,
      band: w.row.band,
      translationRu: w.row.translationRu,
      state: w.summary.state === "excluded_by_learner" ? w.summary.state : w.row.eligibility === "excluded" || w.row.archivedBy === "model" ? "excluded_by_cleanup" : w.summary.state,
      noExamples: w.summary.state === "learning" && w.usable === 0,
      contextCount: w.usable,
      nextCheck: w.nextCheck,
      lapses: w.summary.lapses,
      ...(w.removed ? { archived: true } : {}),
    }));
  const needle = (q.search ?? "").trim().toLowerCase();
  const keep = rows.filter((r) => {
    if (needle && !r.lemma.includes(needle) && !r.translationRu.toLowerCase().includes(needle)) return false;
    switch (q.filter) {
      case undefined:
        return true;
      case "excluded":
        return r.state === "excluded_by_cleanup" || r.state === "excluded_by_learner";
      case "no_examples":
        return r.noExamples;
      default:
        return r.state === q.filter;
    }
  });
  return { total: keep.length, words: keep.slice(q.offset, q.offset + q.limit) };
}

/** the learner takes an archived word back (D184): the archive flag is cleared (also for a word the cleanup archived) and a \ row is appended */
export function restoreWord(db: Db, deps: Deps, lemma: string): void {
  db.transaction(() => {
    const f = loadFacts(db).get(lemma);
    const state = f ? summarise(f).state : "unscreened";
    const archived = db.prepare("SELECT archived FROM typing_word_bank WHERE lemma = ?").get(lemma) as { archived: number } | undefined;
    if (state !== "excluded_by_learner" && archived?.archived !== 1) throw new ApiError(409, "NOT_EXCLUDED", "This word is not archived");
    const stamp = deps.now().toISOString();
    unarchiveWord(db, lemma);
    db.prepare("UPDATE vocab_typing_lexicon SET eligibility = 'keep', exclusion_reason = NULL, updated_at = ? WHERE lemma = ? AND eligibility = 'excluded'").run(stamp, lemma);
    db.prepare("INSERT INTO vocab_typing_cleanup(id, run_id, lemma, actor, decision, reason, created_at) VALUES (?,NULL,?,'learner','restore','restored by the learner',?)").run(deps.newId(), lemma, stamp);
  }).immediate();
}
