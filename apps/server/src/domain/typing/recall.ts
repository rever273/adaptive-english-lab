import type { Db } from "../../db/open.js";
import { ApiError } from "../../errors.js";
import { typingRecallWords } from "@english-lab/contracts";
import { blankOut, matchForms } from "../vocabulary/forms.js";
import { currentExamples, currentTranslations } from "../vocabulary/repository.js";
import { loadSettings } from "../sessions/policy.js";
import { learningFactors } from "../vocabulary/difficulty.js";

export const RECALL_RULE_VERSION = "typing-recall-v1";
export const RECALL_WORDS = 3;
export const RECALL_MAX_POINTS = 10;

export interface RecallDeps {
  now: () => Date;
  newId: () => string;
  random?: () => number;
}

export interface RecallWord {
  entryId: string;
  lemma: string;
  translationRu: string;
  /** an example from the dictionary with the word replaced by ____ (null when the word has no usable example) */
  sentence: string | null;
}

/** per word, how the last recall checks went: 0 = typed unaided, 1 = shown or hinted every time (derived from the raw rows) */
export function recallTrouble(db: Db): Map<string, number> {
  const rows = db.prepare("SELECT lemma, revealed, hints, wrong_keys FROM typing_recall_results ORDER BY created_at, rowid").all() as Array<{ lemma: string; revealed: number; hints: number; wrong_keys: number }>;
  const per = new Map<string, number[]>();
  for (const r of rows) (per.get(r.lemma) ?? per.set(r.lemma, []).get(r.lemma)!).push(r.revealed === 1 ? 1 : r.hints > 0 || r.wrong_keys >= 3 ? 0.5 : 0);
  return new Map([...per].map(([lemma, xs]) => [lemma, xs.slice(-3).reduce((a, b) => a + b, 0) / Math.min(3, xs.length)]));
}

/** up to three saved words for the memory check, weighted towards those that are new, hard in vocabulary practice, or failed before; never the last check's words */
export function pickRecallWords(db: Db, deps: RecallDeps, count: number = RECALL_WORDS): RecallWord[] {
  if (count <= 0) return [];
  const rows = db
    .prepare(
      `SELECT e.id, e.lemma, e.learned, e.surface_forms_json AS forms FROM vocabulary_entries e
        WHERE (SELECT kind FROM vocabulary_entry_events ev WHERE ev.entry_id = e.id ORDER BY ev.created_at DESC, ev.rowid DESC LIMIT 1) IS NOT 'removed'`,
    )
    .all() as Array<{ id: string; lemma: string; learned: number; forms: string }>;
  const plain = rows.filter((r) => /^[a-z]{3,14}$/.test(r.lemma));
  const translations = currentTranslations(db, plain.map((r) => r.id));
  const usable = plain.filter((r) => translations.has(r.id));
  if (usable.length === 0) return [];
  const last = db.prepare("SELECT session_id FROM typing_recall_results ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as { session_id: string } | undefined;
  const recent = new Set(last ? (db.prepare("SELECT entry_id FROM typing_recall_results WHERE session_id = ?").all(last.session_id) as Array<{ entry_id: string }>).map((r) => r.entry_id) : []);
  const factors = learningFactors(db, new Map(usable.map((r) => [r.lemma, r.learned === 1])));
  const trouble = recallTrouble(db);
  const r = deps.random ?? Math.random;
  const keyed = usable
    .map((e) => {
      const weight = (e.learned ? 0.4 : 1) * (factors.get(e.lemma) ?? 1) * (1 + 2 * (trouble.get(e.lemma) ?? 0)) * (recent.has(e.id) ? 0.2 : 1);
      return { e, k: -Math.log(Math.max(r(), 1e-9)) / weight };
    })
    .sort((a, b) => a.k - b.k)
    .slice(0, count);
  const examples = currentExamples(db, keyed.map(({ e }) => e.id));
  return keyed.map(({ e }) => ({ entryId: e.id, lemma: e.lemma, translationRu: translations.get(e.id)!, sentence: blankOut(examples.get(e.id) ?? "", matchForms(e.lemma, JSON.parse(e.forms) as string[])) }));
}

export interface RecallResultInput {
  entryId: string;
  correctKeys: number;
  wrongKeys: number;
  hints: number;
  revealed: boolean;
}

/** 10 points for a word typed from memory; every hint (F4) costs 3, every wrong key half a point; showing the word (F5) gives 0 */
export function recallPoints(r: Pick<RecallResultInput, "wrongKeys" | "hints" | "revealed">): number {
  return r.revealed ? 0 : Math.max(0, Math.round(RECALL_MAX_POINTS - 3 * r.hints - 0.5 * r.wrongKeys));
}

function completedWordsSession(db: Db, sessionId: string): void {
  const row = db.prepare("SELECT mode, status FROM typing_sessions WHERE id = ?").get(sessionId) as { mode: string; status: string } | undefined;
  if (!row) throw new ApiError(404, "TYPING_SESSION_NOT_FOUND", "Unknown typing session");
  if (row.mode !== "words" || row.status !== "completed") throw new ApiError(409, "TYPING_RECALL_NOT_AVAILABLE", "The memory check follows a completed Words level");
}

/** the words of this session's memory check: those already answered (replay-safe) or a fresh pick */
export function recallStart(db: Db, deps: RecallDeps, sessionId: string): { words: RecallWord[]; done: boolean; points: number } {
  completedWordsSession(db, sessionId);
  const done = db.prepare("SELECT entry_id, lemma, points FROM typing_recall_results WHERE session_id = ?").all(sessionId) as Array<{ entry_id: string; lemma: string; points: number }>;
  if (done.length > 0) return { words: [], done: true, points: done.reduce((a, r) => a + r.points, 0) };
  return { words: pickRecallWords(db, deps, typingRecallWords(loadSettings(db).values)), done: false, points: 0 };
}

export function recallSave(db: Db, deps: RecallDeps, sessionId: string, results: readonly RecallResultInput[]): { points: number; results: Array<{ entryId: string; lemma: string; points: number }> } {
  completedWordsSession(db, sessionId);
  if (results.length === 0 || results.length > RECALL_WORDS) throw new ApiError(400, "VALIDATION_ERROR", "Send one to three results");
  return db
    .transaction(() => {
      if (db.prepare("SELECT 1 FROM typing_recall_results WHERE session_id = ?").get(sessionId)) throw new ApiError(409, "TYPING_RECALL_DONE", "The memory check of this level is already saved");
      const now = deps.now().toISOString();
      const put = db.prepare("INSERT INTO typing_recall_results(id, session_id, entry_id, lemma, letters, correct_keys, wrong_keys, hints, revealed, points, rule_version, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
      const saved: Array<{ entryId: string; lemma: string; points: number }> = [];
      for (const r of results) {
        const e = db.prepare("SELECT lemma FROM vocabulary_entries WHERE id = ?").get(r.entryId) as { lemma: string } | undefined;
        if (!e || !/^[a-z]{3,14}$/.test(e.lemma)) throw new ApiError(400, "VALIDATION_ERROR", "Unknown word in the memory check");
        if (saved.some((s) => s.entryId === r.entryId)) throw new ApiError(400, "VALIDATION_ERROR", "A word can be checked once");
        const points = recallPoints(r);
        put.run(deps.newId(), sessionId, r.entryId, e.lemma, e.lemma.length, Math.min(r.correctKeys, e.lemma.length), r.wrongKeys, r.hints, r.revealed ? 1 : 0, points, RECALL_RULE_VERSION, now);
        saved.push({ entryId: r.entryId, lemma: e.lemma, points });
      }
      return { points: saved.reduce((a, s) => a + s.points, 0), results: saved };
    })
    .immediate();
}

/** for the statistics: checks done, words typed without help, average points of a word */
export function recallSummary(db: Db): { checks: number; words: number; withoutHelpRate: number | null; avgPoints: number | null } {
  const r = db.prepare("SELECT COUNT(DISTINCT session_id) AS checks, COUNT(*) AS words, SUM(CASE WHEN revealed = 0 AND hints = 0 THEN 1 ELSE 0 END) AS clean, AVG(points) AS avg FROM typing_recall_results").get() as { checks: number; words: number; clean: number | null; avg: number | null };
  return { checks: r.checks, words: r.words, withoutHelpRate: r.words > 0 ? Math.round(((r.clean ?? 0) / r.words) * 1000) / 10 : null, avgPoints: r.avg === null ? null : Math.round(r.avg * 10) / 10 };
}
