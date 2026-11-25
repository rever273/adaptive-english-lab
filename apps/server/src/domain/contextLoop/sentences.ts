import { CONTEXT_LOOP_PLAYABLE, CONTEXT_LOOP_READY, type ContextLoopCoverage, type ContextLoopSentenceStatus, type ContextLoopSentenceView } from "@english-lab/contracts";
import type { Db } from "../../db/open.js";
import { ApiError } from "../../errors.js";
import { currentTranslations, getEntry } from "../vocabulary/repository.js";
import { findTarget } from "../wordLessons/validate.js";
import { eligibleWords } from "../wordLessons/selection.js";
import type { SenseSnapshot } from "../wordLessons/runner.js";
import { checkAndAccept, ContextLedger, targetOf, type CheckedSentence, type WordTarget } from "./validate.js";

export interface Deps {
  now: () => Date;
  newId: () => string;
}

/** the latest status row decides (D152) */
export const CURRENT_STATUS = "(SELECT st.status FROM context_loop_sentence_status st WHERE st.sentence_id = s.id ORDER BY st.created_at DESC, st.rowid DESC LIMIT 1)";
const CURRENT_REASON = "(SELECT st.reason FROM context_loop_sentence_status st WHERE st.sentence_id = s.id ORDER BY st.created_at DESC, st.rowid DESC LIMIT 1)";
export const USABLE: readonly ContextLoopSentenceStatus[] = ["validated", "approved"];

export const normTranslation = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");

export interface SentenceRow {
  id: string;
  entryId: string;
  lemma: string;
  sense: SenseSnapshot;
  text: string;
  targetSurface: string;
  targetStart: number;
  targetLength: number;
  contextLabel: string;
  difficulty: ContextLoopSentenceView["difficulty"];
  source: ContextLoopSentenceView["source"];
  status: ContextLoopSentenceStatus;
  reason: string | null;
  /** written for a translation the dictionary no longer has (§3.3) */
  stale: boolean;
  createdAt: string;
}

export function loadSentences(db: Db, where: { entryId?: string; id?: string } = {}): SentenceRow[] {
  const rows = db
    .prepare(
      `SELECT s.id, s.entry_id AS entryId, s.lemma, s.sense_json AS sense, s.text, s.target_surface AS targetSurface, s.target_start AS targetStart, s.target_length AS targetLength,
              s.context_label AS contextLabel, s.difficulty, s.source, ${CURRENT_STATUS} AS status, ${CURRENT_REASON} AS reason, s.created_at AS createdAt
         FROM context_loop_sentences s
        WHERE (@entryId IS NULL OR s.entry_id = @entryId) AND (@id IS NULL OR s.id = @id)
        ORDER BY s.entry_id, s.created_at, s.rowid`,
    )
    .all({ entryId: where.entryId ?? null, id: where.id ?? null }) as Array<Omit<SentenceRow, "sense" | "stale"> & { sense: string }>;
  const translations = currentTranslations(db, [...new Set(rows.map((r) => r.entryId))]);
  return rows.map((r) => {
    const sense = JSON.parse(r.sense) as SenseSnapshot;
    const now = translations.get(r.entryId);
    return { ...r, sense, stale: now === undefined || normTranslation(now) !== normTranslation(sense.translationRu) };
  });
}

/** usable sentences (validated or approved, not stale) per entry */
export function usableByEntry(db: Db): Map<string, SentenceRow[]> {
  const out = new Map<string, SentenceRow[]>();
  for (const s of loadSentences(db)) if (USABLE.includes(s.status) && !s.stale) (out.get(s.entryId) ?? out.set(s.entryId, []).get(s.entryId)!).push(s);
  return out;
}

export function coverage(db: Db): ContextLoopCoverage & { byEntry: Map<string, number>; staleEntries: Set<string> } {
  const words = eligibleWords(db).eligible.filter((w) => !w.learned);
  const all = loadSentences(db);
  const usable = new Map<string, number>();
  const staleEntries = new Set<string>();
  for (const s of all) {
    if (!USABLE.includes(s.status)) continue;
    if (s.stale) staleEntries.add(s.entryId);
    else usable.set(s.entryId, (usable.get(s.entryId) ?? 0) + 1);
  }
  let ready = 0;
  let playable = 0;
  let stale = 0;
  for (const w of words) {
    const n = usable.get(w.entryId) ?? 0;
    if (n >= CONTEXT_LOOP_READY) ready++;
    if (n >= CONTEXT_LOOP_PLAYABLE) playable++;
    if (staleEntries.has(w.entryId)) stale++;
  }
  return { ready, playable, missing: words.length - playable, stale, eligible: words.length, byEntry: usable, staleEntries };
}

export const viewOf = (s: SentenceRow): ContextLoopSentenceView => ({
  id: s.id,
  entryId: s.entryId,
  lemma: s.lemma,
  text: s.text,
  targetStart: s.targetStart,
  targetLength: s.targetLength,
  contextLabel: s.contextLabel,
  difficulty: s.difficulty,
  source: s.source,
  status: s.status,
  reason: s.reason,
  stale: s.stale,
  createdAt: s.createdAt,
});

export interface InsertSentence {
  target: WordTarget;
  checked: CheckedSentence;
  source: "model" | "agent" | "learner";
  authorId?: string | null;
  batchId?: string | null;
  parentId?: string | null;
  promptVersion?: string | null;
  modelTag?: string | null;
  review?: unknown;
  status: Exclude<ContextLoopSentenceStatus, "rejected">;
  actor: "code" | "model" | "agent" | "learner";
  reason?: string | null;
}

/** one sentence and its first status (caller's transaction); returns the id, or null when the word already has this exact sentence */
export function insertSentence(db: Db, deps: Deps, x: InsertSentence): string | null {
  const now = deps.now().toISOString();
  const id = deps.newId();
  const c = x.checked;
  const r = db
    .prepare(
      `INSERT INTO context_loop_sentences(id, entry_id, lemma, sense_json, text, target_surface, target_start, target_length, context_label, difficulty, fingerprint, source, author_id, batch_id, parent_id, prompt_version, model_tag, review_json, created_at, translation_ru)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(entry_id, fingerprint) DO NOTHING`,
    )
    .run(id, x.target.entryId, x.target.lemma, JSON.stringify(x.target.sense), c.text, c.targetSurface, c.targetStart, c.targetLength, c.contextLabel, c.difficulty, c.fingerprint, x.source, x.authorId ?? null, x.batchId ?? null, x.parentId ?? null, x.promptVersion ?? null, x.modelTag ?? null, x.review === undefined ? null : JSON.stringify(x.review), now, c.translationRu);
  if (r.changes === 0) return null;
  appendStatus(db, deps, id, x.status, x.actor, x.reason ?? null);
  return id;
}

export function appendStatus(db: Db, deps: Deps, sentenceId: string, status: ContextLoopSentenceStatus, actor: "code" | "model" | "agent" | "learner", reason: string | null): void {
  db.prepare("INSERT INTO context_loop_sentence_status(id, sentence_id, status, actor, reason, created_at) VALUES (?,?,?,?,?,?)").run(deps.newId(), sentenceId, status, actor, reason, deps.now().toISOString());
}

function one(db: Db, id: string): SentenceRow {
  const s = loadSentences(db, { id })[0];
  if (!s) throw new ApiError(404, "CONTEXT_SENTENCE_NOT_FOUND", "Unknown sentence");
  return s;
}

/** the learner hides a sentence or puts it back into practice ("Use anyway" for a flagged one) */
export function setStatusByLearner(db: Db, deps: Deps, id: string, status: "validated" | "rejected"): ContextLoopSentenceView {
  return db
    .transaction(() => {
      const s = one(db, id);
      if (s.status !== status && !(status === "validated" && s.status === "approved")) appendStatus(db, deps, id, status, "learner", status === "rejected" ? "hidden by the learner" : "restored by the learner");
      return viewOf(one(db, id));
    })
    .immediate();
}

/** an edit is a new sentence (the text of a sentence never changes); the old one is retired with the reason `edited` */
export function editByLearner(db: Db, deps: Deps, id: string, text: string): ContextLoopSentenceView {
  return db
    .transaction(() => {
      const s = one(db, id);
      const entry = getEntry(db, s.entryId);
      const target = targetOf(s.entryId, s.lemma, s.sense, entry.collocations.items);
      const r = checkAndAccept({ text, target_surface: findTarget(text, target.word)?.form ?? "", context_label: s.contextLabel, difficulty: s.difficulty }, target, new ContextLedger(db));
      if (!r.ok) throw new ApiError(400, "CONTEXT_SENTENCE_INVALID", r.message, { code: r.code });
      const newId = insertSentence(db, deps, { target, checked: r.sentence, source: "learner", parentId: s.id, status: "validated", actor: "learner", reason: "edited by the learner" });
      if (!newId) throw new ApiError(409, "CONTEXT_SENTENCE_EXISTS", "This word already has that sentence");
      appendStatus(db, deps, s.id, "rejected", "learner", "edited");
      return viewOf(one(db, newId));
    })
    .immediate();
}

