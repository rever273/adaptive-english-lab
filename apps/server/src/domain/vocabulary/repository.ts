import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Db } from "../../db/open.js";
import { ApiError } from "../../errors.js";
import { applyAction, enqueue } from "../../queue/jobs.js";
import { bankTexts, countOccurrences, isValidWord, matchForms, normalizeWord, shownTexts } from "./forms.js";

export const VOCAB_PROMPT = "vocabulary-v3";
export const CEFR_LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"] as const;
export const POS_VALUES = ["noun", "verb", "adjective", "adverb", "preposition", "conjunction", "pronoun", "determiner", "phrase", "phrasal verb", "idiom", "other"] as const;

interface Deps {
  now: () => Date;
  newId?: () => string;
}
const id = (d: Deps): string => (d.newId ?? randomUUID)();

/** slotId: the task where the word was selected; its sentence is the first context for the translation (D63) */
export const AddWordSchema = z.object({ word: z.string().min(1).max(120), selected: z.string().min(1).max(120).optional(), slotId: z.string().uuid().optional() }).strict();

/** latest removal event wins; a removed word is hidden everywhere until it is saved again (D63, migration 014) */
const isRemoved = (db: Db, entryId: string): boolean =>
  (db.prepare("SELECT kind FROM vocabulary_entry_events WHERE entry_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(entryId) as { kind: string } | undefined)?.kind === "removed";

/** Hide a word from the vocabulary. History (revisions, encounters) stays; saving the word again brings it back. */
export function removeWord(db: Db, deps: Deps, entryId: string): { removed: true } {
  return db
    .transaction((): { removed: true } => {
      entryRow(db, entryId);
      if (!isRemoved(db, entryId)) db.prepare("INSERT INTO vocabulary_entry_events(id, entry_id, kind, created_at) VALUES (?,?,?,?)").run(id(deps), entryId, "removed", deps.now().toISOString());
      return { removed: true };
    })
    .immediate();
}

/** the word was met in this task: remember that (a displayed encounter), so the AI translates the sense used there */
function noteMetIn(db: Db, deps: Deps, entryId: string, slotId: string | undefined): void {
  if (!slotId) return;
  const s = db.prepare("SELECT ss.exercise_revision_id AS revisionId, er.type AS type, er.content_json AS c FROM session_slots ss JOIN exercise_revisions er ON er.id = ss.exercise_revision_id WHERE ss.id = ?").get(slotId) as { revisionId: string; type: string; c: string } | undefined;
  if (!s) return;
  const forms = formsOf(entryRow(db, entryId));
  const texts = bankTexts(JSON.parse(s.c) as { prompt_en: string; payload: Record<string, any> }, s.type);
  if (!texts.some((t) => countOccurrences(t, forms) > 0)) return; // selected outside the exercise text: nothing to remember
  insertEnc(db, deps).run(id(deps), entryId, s.revisionId, slotId, "displayed", 0, deps.now().toISOString());
}
export const PatchWordSchema = z
  .object({
    expectedRevision: z.number().int().min(0).optional(),
    translationRu: z.string().trim().max(300).optional(),
    exampleEn: z.string().trim().max(500).optional(),
    collocations: z.array(z.string().trim().min(1).max(80)).max(10).optional(),
    pos: z.string().trim().min(1).max(30).optional(),
    learned: z.boolean().optional(),
  })
  .strict();

type FieldSource = "user" | "ai_draft" | null;
export interface EntryView {
  id: string;
  lemma: string;
  pos: string;
  posSource: FieldSource | "entry";
  learned: boolean;
  /** the token PATCH must send back */
  userRevision: number;
  surfaceForms: string[];
  translation: { text: string; source: FieldSource };
  example: { text: string; source: FieldSource };
  collocations: { items: string[]; source: FieldSource };
  /** an AI draft exists that was written before the learner's last edit */
  draftPredatesEdit: boolean;
  aiPending: boolean;
  /** Latest failed full enrichment, only when no translation or replacement job is available. */
  aiError: string | null;
  aiExampleOmitted: boolean;
  /** AI draft CEFR level of the word in the sense the learner met it (D64), null until the model has written it */
  level: string | null;
  /** how many vocabulary-practice tasks on this word you have answered (first tries only; a plain count, not a score) */
  practised: number;
  bank: { occurrences: number; revisions: number };
  displayed: { occurrences: number; slots: number };
  lastSeen: string | null;
  createdAt: string;
}

interface EntryRow {
  id: string;
  lemma: string;
  pos: string;
  learned: number;
  user_revision: number;
  surface_forms_json: string;
  created_at: string;
}
interface RevRow {
  revision: number;
  translation_ru: string;
  part_of_speech: string;
  example_en: string;
  collocations_json: string;
  source: string;
  based_on_user_rev: number | null;
}

/** a USER's non-empty field always wins over a model draft; the draft only fills what the learner left empty */
function view(db: Db, e: EntryRow): EntryView {
  const revs = db.prepare("SELECT revision, translation_ru, part_of_speech, example_en, collocations_json, source, based_on_user_rev FROM vocabulary_revisions WHERE entry_id = ? ORDER BY revision DESC").all(e.id) as RevRow[];
  const user = revs.find((r) => r.source === "user");
  const model = revs.find((r) => r.source !== "user");
  const pick = (u: string | undefined, m: string | undefined): { text: string; source: FieldSource } => (u && u.trim() !== "" ? { text: u, source: "user" } : m && m.trim() !== "" ? { text: m, source: "ai_draft" } : { text: "", source: null });
  const colls = (r?: RevRow): string[] => (r ? (JSON.parse(r.collocations_json) as string[]) : []);
  const uc = colls(user);
  const mc = colls(model);
  const pos = e.pos !== "unknown" ? { text: e.pos, source: "entry" as const } : pick(user?.part_of_speech, model?.part_of_speech);
  const bank = db.prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT revision_id) AS r FROM vocabulary_encounters WHERE entry_id = ? AND kind = 'bank'").get(e.id) as { n: number; r: number };
  const shown = db.prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT slot_id) AS s, MAX(created_at) AS last FROM vocabulary_encounters WHERE entry_id = ? AND kind = 'displayed'").get(e.id) as { n: number; s: number; last: string | null };
  const level = db.prepare("SELECT level FROM vocabulary_levels WHERE entry_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(e.id) as { level: string } | undefined;
  const practised = (db
    .prepare(
      `SELECT COUNT(*) AS n FROM attempts t JOIN session_slots ss ON ss.id = t.slot_id JOIN vocabulary_sessions vs ON vs.session_id = ss.session_id
         JOIN exercise_revisions er ON er.id = ss.exercise_revision_id
        WHERE t.attempt_no = 1 AND lower(json_extract(er.content_json, '$.vocabulary.target.lemma')) = ?`,
    )
    .get(e.lemma) as { n: number }).n;
  const pending = db.prepare("SELECT 1 FROM jobs WHERE idempotency_key LIKE ? AND state IN ('queued','waiting_for_gpu','running','paused') LIMIT 1").get(`vocab:${e.id}:%`) !== undefined;
  const translation = pick(user?.translation_ru, model?.translation_ru);
  const modelResult = model ? db.prepare("SELECT jr.schema_version AS schema FROM vocabulary_revisions vr LEFT JOIN job_results jr ON jr.id = vr.job_result_id WHERE vr.entry_id = ? AND vr.revision = ?").get(e.id, model.revision) as { schema: string | null } | undefined : undefined;
  const latestFullJob = db.prepare("SELECT state, error_code AS error FROM jobs WHERE kind = 'vocabulary_enrichment' AND json_extract(payload_json, '$.entryId') = ? AND COALESCE(json_extract(payload_json, '$.levelOnly'), 0) = 0 ORDER BY created_at DESC, rowid DESC LIMIT 1").get(e.id) as { state: string; error: string | null } | undefined;
  return {
    id: e.id,
    lemma: e.lemma,
    pos: pos.text || "unknown",
    posSource: pos.source,
    learned: e.learned === 1,
    userRevision: e.user_revision,
    surfaceForms: JSON.parse(e.surface_forms_json) as string[],
    translation,
    example: pick(user?.example_en, model?.example_en),
    collocations: uc.length > 0 ? { items: uc, source: "user" } : mc.length > 0 ? { items: mc, source: "ai_draft" } : { items: [], source: null },
    draftPredatesEdit: model?.based_on_user_rev != null && model.based_on_user_rev < e.user_revision,
    aiPending: pending,
    aiError: !translation.text && !pending && latestFullJob?.state === "failed" ? latestFullJob.error : null,
    aiExampleOmitted: !user?.example_en && modelResult?.schema === "vocabulary-partial-v1",
    level: level?.level ?? null,
    practised,
    bank: { occurrences: bank.n, revisions: bank.r },
    displayed: { occurrences: shown.n, slots: shown.s },
    lastSeen: shown.last,
    createdAt: e.created_at,
  };
}

const entryRow = (db: Db, entryId: string): EntryRow => {
  const e = db.prepare("SELECT id, lemma, pos, learned, user_revision, surface_forms_json, created_at FROM vocabulary_entries WHERE id = ?").get(entryId) as EntryRow | undefined;
  if (!e) throw new ApiError(404, "WORD_NOT_FOUND", "Unknown word");
  return e;
};
export const getEntry = (db: Db, entryId: string): EntryView => view(db, entryRow(db, entryId));

function formsOf(e: EntryRow): string[] {
  return matchForms(e.lemma, JSON.parse(e.surface_forms_json) as string[]);
}

/** Immediate save. The word is stored first and counted against the bank; the AI draft is only QUEUED (it may never come, and that is fine). */
export function addWord(db: Db, deps: Deps, input: unknown): { entry: EntryView; created: boolean } {
  const p = AddWordSchema.safeParse(input);
  if (!p.success) throw new ApiError(400, "VALIDATION_ERROR", "Request is invalid", p.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const lemma = normalizeWord(p.data.word);
  if (!isValidWord(lemma)) throw new ApiError(422, "WORD_INVALID", "A saved word is a word or a short phrase (up to 4 words) of letters, apostrophes and hyphens");
  const selected = normalizeWord(p.data.selected ?? p.data.word);
  return db
    .transaction((): { entry: EntryView; created: boolean } => {
      const existing = db.prepare("SELECT id, lemma, pos, learned, user_revision, surface_forms_json, created_at FROM vocabulary_entries WHERE lemma = ? AND language = 'en' ORDER BY created_at LIMIT 1").get(lemma) as EntryRow | undefined;
      if (existing) {
        const forms = JSON.parse(existing.surface_forms_json) as string[];
        if (selected !== lemma && !forms.includes(selected) && isValidWord(selected)) {
          db.prepare("UPDATE vocabulary_entries SET surface_forms_json = ? WHERE id = ?").run(JSON.stringify([...forms, selected].sort()), existing.id);
          scanBankForEntry(db, deps, existing.id);
        }
        const wasRemoved = isRemoved(db, existing.id);
        if (wasRemoved) db.prepare("INSERT INTO vocabulary_entry_events(id, entry_id, kind, created_at) VALUES (?,?,?,?)").run(id(deps), existing.id, "restored", deps.now().toISOString());
        noteMetIn(db, deps, existing.id, p.data.slotId);
        return { entry: getEntry(db, existing.id), created: wasRemoved };
      }
      const entryId = id(deps);
      const forms = selected !== lemma && isValidWord(selected) ? [selected] : [];
      db.prepare("INSERT INTO vocabulary_entries(id, lemma, pos, language, learned, user_revision, surface_forms_json, created_at) VALUES (?,?,?,?,?,?,?,?)").run(entryId, lemma, "unknown", "en", 0, 0, JSON.stringify(forms), deps.now().toISOString());
      scanBankForEntry(db, deps, entryId);
      noteMetIn(db, deps, entryId, p.data.slotId);
      enqueue(db, { now: deps.now, newId: deps.newId ?? randomUUID }, { kind: "vocabulary_enrichment", payload: { entryId, expectedUserRevision: 0 }, idempotencyKey: `vocab:${entryId}:0`, priority: 2 });
      return { entry: getEntry(db, entryId), created: true };
    })
    .immediate();
}

export function patchWord(db: Db, deps: Deps, entryId: string, input: unknown): EntryView {
  const p = PatchWordSchema.safeParse(input);
  if (!p.success) throw new ApiError(400, "VALIDATION_ERROR", "Request is invalid", p.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const b = p.data;
  const content = b.translationRu !== undefined || b.exampleEn !== undefined || b.collocations !== undefined || b.pos !== undefined;
  if (!content && b.learned === undefined) throw new ApiError(400, "VALIDATION_ERROR", "Nothing to change");
  return db
    .transaction((): EntryView => {
      const e = entryRow(db, entryId);
      if (content) {
        if (b.expectedRevision === undefined) throw new ApiError(400, "VALIDATION_ERROR", "expectedRevision is required to edit the text");
        if (b.expectedRevision !== e.user_revision) {
          // someone (another tab) edited since this form was loaded: say so, show the current text, change nothing
          throw new ApiError(409, "REVISION_CONFLICT", "This word was edited since you opened it. Your text was NOT saved; here is the current version.", { currentRevision: e.user_revision, current: view(db, e) });
        }
        const lastUser = db.prepare("SELECT translation_ru, part_of_speech, example_en, collocations_json FROM vocabulary_revisions WHERE entry_id = ? AND source = 'user' ORDER BY revision DESC LIMIT 1").get(entryId) as { translation_ru: string; part_of_speech: string; example_en: string; collocations_json: string } | undefined;
        const next = (db.prepare("SELECT COALESCE(MAX(revision), 0) + 1 AS n FROM vocabulary_revisions WHERE entry_id = ?").get(entryId) as { n: number }).n;
        db.prepare(
          "INSERT INTO vocabulary_revisions(id, entry_id, revision, translation_ru, part_of_speech, example_en, collocations_json, source, status, user_edited, based_on_user_rev, job_result_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ).run(id(deps), entryId, next, b.translationRu ?? lastUser?.translation_ru ?? "", b.pos ?? lastUser?.part_of_speech ?? "", b.exampleEn ?? lastUser?.example_en ?? "", JSON.stringify(b.collocations ?? (lastUser ? JSON.parse(lastUser.collocations_json) : [])), "user", "approved", 1, null, null, deps.now().toISOString());
        db.prepare("UPDATE vocabulary_entries SET user_revision = user_revision + 1 WHERE id = ?").run(entryId);
        if (b.pos !== undefined) {
          const clash = db.prepare("SELECT 1 FROM vocabulary_entries WHERE lemma = ? AND pos = ? AND language = 'en' AND id <> ?").get(e.lemma, b.pos, entryId);
          if (clash) throw new ApiError(409, "WORD_EXISTS", "Another entry with the same word and part of speech already exists");
          db.prepare("UPDATE vocabulary_entries SET pos = ? WHERE id = ?").run(b.pos, entryId);
        }
      }
      if (b.learned !== undefined && (e.learned === 1) !== b.learned) {
        db.prepare("UPDATE vocabulary_entries SET learned = ? WHERE id = ?").run(b.learned ? 1 : 0, entryId);
        // the date of the switch, for "marked learned by date" in Vocabulary Analytics (migration 018); no XP, no score
        db.prepare("INSERT INTO vocabulary_learned_events(id, entry_id, learned, created_at) VALUES (?,?,?,?)").run(id(deps), entryId, b.learned ? 1 : 0, deps.now().toISOString());
      }
      return getEntry(db, entryId);
    })
    .immediate();
}

export function listWords(db: Db, o: { q?: string; learned?: boolean; limit?: number } = {}): { words: EntryView[]; total: number } {
  const rows = (db.prepare("SELECT id, lemma, pos, learned, user_revision, surface_forms_json, created_at FROM vocabulary_entries ORDER BY lemma").all() as EntryRow[]).filter((r) => !isRemoved(db, r.id));
  const q = o.q ? normalizeWord(o.q) : "";
  // most recently shown first, then never-shown words by when they were saved (newest first)
  const recent = (v: EntryView) => v.lastSeen ?? "";
  const all = rows
    .map((r) => view(db, r))
    .sort((a, b) => recent(b).localeCompare(recent(a)) || b.createdAt.localeCompare(a.createdAt))
    .filter((v) => (o.learned === undefined || v.learned === o.learned) && (q === "" || v.lemma.includes(q) || v.translation.text.toLowerCase().includes(q) || v.surfaceForms.some((f) => f.includes(q))));
  return { words: all.slice(0, o.limit ?? 500), total: all.length };
}

/**
 * D64: words saved before the CEFR level existed get one level-only job each (idempotent by key). Called at startup; the job goes through the
 * single GPU dispatcher like any other draft and touches nothing the learner wrote.
 */
export function queueMissingLevels(db: Db, deps: Deps): number {
  const missing = db
    .prepare(`SELECT id FROM vocabulary_entries WHERE ${VISIBLE} AND NOT EXISTS (SELECT 1 FROM vocabulary_levels l WHERE l.entry_id = vocabulary_entries.id)`)
    .all() as Array<{ id: string }>;
  let queued = 0;
  for (const { id: entryId } of missing) {
    const hasDraft = db.prepare("SELECT 1 FROM vocabulary_revisions WHERE entry_id = ? AND source = 'model' LIMIT 1").get(entryId) !== undefined;
    // A full translation job also creates the level. Do not run a level-only job that would discard a usable translation.
    if (!hasDraft && db.prepare("SELECT 1 FROM jobs WHERE kind = 'vocabulary_enrichment' AND json_extract(payload_json, '$.entryId') = ? AND COALESCE(json_extract(payload_json, '$.levelOnly'), 0) = 0 LIMIT 1").get(entryId)) continue;
    const rev = (db.prepare("SELECT user_revision AS r FROM vocabulary_entries WHERE id = ?").get(entryId) as { r: number }).r;
    const key = hasDraft ? `vocab:${entryId}:level` : `vocab:${entryId}:${rev}`;
    if (db.prepare("SELECT 1 FROM jobs WHERE idempotency_key = ?").get(key)) continue;
    enqueue(db, { now: deps.now, newId: deps.newId ?? randomUUID }, { kind: "vocabulary_enrichment", payload: { entryId, expectedUserRevision: rev, ...(hasDraft ? { levelOnly: true } : {}) }, idempotencyKey: key, priority: 2 });
    queued++;
  }
  return queued;
}

/** One-time recovery of old validation failures that predate bounded automatic retries. */
export function recoverLegacyVocabularyFailures(db: Db, deps: Deps): number {
  return db.transaction(() => {
    const jobs = db.prepare(`SELECT j.id FROM jobs j JOIN vocabulary_entries e ON e.id = json_extract(j.payload_json, '$.entryId')
      WHERE j.kind = 'vocabulary_enrichment' AND j.state = 'failed' AND j.error_code = 'failed_validation' AND j.retry_count = 0
        AND COALESCE(json_extract(j.payload_json, '$.levelOnly'), 0) = 0
        AND (SELECT kind FROM vocabulary_entry_events ev WHERE ev.entry_id = e.id ORDER BY ev.created_at DESC, ev.rowid DESC LIMIT 1) IS NOT 'removed'
        AND NOT EXISTS (SELECT 1 FROM vocabulary_revisions vr WHERE vr.entry_id = e.id AND length(trim(vr.translation_ru)) > 0)
        AND NOT EXISTS (SELECT 1 FROM job_events je WHERE je.job_id = j.id AND je.reason = 'retry_legacy_validation')
        AND NOT EXISTS (SELECT 1 FROM jobs other WHERE other.id <> j.id AND other.kind = 'vocabulary_enrichment' AND json_extract(other.payload_json, '$.entryId') = e.id AND COALESCE(json_extract(other.payload_json, '$.levelOnly'), 0) = 0 AND other.state IN ('queued','waiting_for_gpu','running','paused'))`).all() as Array<{ id: string }>;
    let recovered = 0;
    for (const job of jobs) {
      // Another failed job for the same entry may have been requeued earlier in this transaction.
      const active = db.prepare(`SELECT 1 FROM jobs other JOIN jobs current ON json_extract(other.payload_json, '$.entryId') = json_extract(current.payload_json, '$.entryId')
        WHERE current.id = ? AND other.id <> current.id AND other.kind = 'vocabulary_enrichment' AND COALESCE(json_extract(other.payload_json, '$.levelOnly'), 0) = 0
          AND other.state IN ('queued','waiting_for_gpu','running','paused') LIMIT 1`).get(job.id);
      if (active) continue;
      applyAction(db, { now: deps.now, newId: deps.newId ?? randomUUID }, job.id, "retry", "retry_legacy_validation");
      recovered++;
    }
    return recovered;
  }).immediate();
}

/** For the popup: is the selected word (or a form of it) already saved? */
export function lookupWord(db: Db, word: string): EntryView | null {
  const w = normalizeWord(word);
  if (!w) return null;
  const rows = (db.prepare("SELECT id, lemma, pos, learned, user_revision, surface_forms_json, created_at FROM vocabulary_entries").all() as EntryRow[]).filter((r) => !isRemoved(db, r.id));
  const hit = rows.find((r) => r.lemma === w || formsOf(r).includes(w));
  return hit ? view(db, hit) : null;
}

export function revisionHistory(db: Db, entryId: string): Array<{ revision: number; source: string; status: string; translationRu: string; exampleEn: string; collocations: string[]; basedOnUserRev: number | null; createdAt: string }> {
  entryRow(db, entryId);
  return (db.prepare("SELECT revision, source, status, translation_ru AS t, example_en AS e, collocations_json AS c, based_on_user_rev AS b, created_at AS at FROM vocabulary_revisions WHERE entry_id = ? ORDER BY revision").all(entryId) as Array<{ revision: number; source: string; status: string; t: string; e: string; c: string; b: number | null; at: string }>).map((r) => ({ revision: r.revision, source: r.source, status: r.status, translationRu: r.t, exampleEn: r.e, collocations: JSON.parse(r.c) as string[], basedOnUserRev: r.b, createdAt: r.at }));
}

// ---------------------------------------------------------------------------------------------------------------- encounters

const insertEnc = (db: Db, deps: Deps) => db.prepare("INSERT OR IGNORE INTO vocabulary_encounters(id, entry_id, revision_id, slot_id, kind, occurrence_index, created_at) VALUES (?,?,?,?,?,?,?)");

function bankRevisions(db: Db): Array<{ id: string; type: string; content: string }> {
  return db.prepare("SELECT er.id AS id, er.type AS type, er.content_json AS content FROM exercise_revisions er JOIN selectable_revisions s ON s.revision_id = er.id WHERE er.bank_role IN ('practice','diagnostic')").all() as Array<{ id: string; type: string; content: string }>;
}

/** BANK encounters of one word: occurrences in approved, released exercises (held-out items are not scanned). Idempotent. */
export function scanBankForEntry(db: Db, deps: Deps, entryId: string): void {
  const e = entryRow(db, entryId);
  const forms = formsOf(e);
  const ins = insertEnc(db, deps);
  for (const r of bankRevisions(db)) {
    const c = JSON.parse(r.content) as { prompt_en: string; payload: Record<string, any> };
    const n = bankTexts(c, r.type).reduce((a, t) => a + countOccurrences(t, forms), 0);
    for (let k = 0; k < n; k++) ins.run(id(deps), entryId, r.id, null, "bank", k, deps.now().toISOString());
  }
}

/** called when revisions are released: every saved word is counted against the new content, in the same transaction */
export function recordBankEncountersForRevisions(db: Db, deps: Deps, revisionIds: readonly string[]): void {
  const entries = db.prepare("SELECT id, lemma, pos, learned, user_revision, surface_forms_json, created_at FROM vocabulary_entries").all() as EntryRow[];
  if (entries.length === 0) return;
  const ins = insertEnc(db, deps);
  for (const rid of revisionIds) {
    const r = db.prepare("SELECT er.type AS type, er.content_json AS content, er.bank_role AS role FROM exercise_revisions er WHERE er.id = ?").get(rid) as { type: string; content: string; role: string } | undefined;
    if (!r || !["practice", "diagnostic"].includes(r.role)) continue;
    const c = JSON.parse(r.content) as { prompt_en: string; payload: Record<string, any> };
    const texts = bankTexts(c, r.type);
    for (const e of entries) {
      const forms = formsOf(e);
      const n = texts.reduce((a, t) => a + countOccurrences(t, forms), 0);
      for (let k = 0; k < n; k++) ins.run(id(deps), e.id, rid, null, "bank", k, deps.now().toISOString());
    }
  }
}

/** DISPLAYED encounters: what the learner was actually shown in this slot. One slot = one encounter per occurrence; a re-render or resume adds nothing. */
export function recordDisplayedEncounters(db: Db, deps: Deps, slotId: string): void {
  const entries = db.prepare("SELECT id, lemma, pos, learned, user_revision, surface_forms_json, created_at FROM vocabulary_entries").all() as EntryRow[];
  if (entries.length === 0) return;
  const s = db.prepare("SELECT ss.exercise_revision_id AS rid, ss.question_id AS q, er.type AS type, er.content_json AS content FROM session_slots ss JOIN exercise_revisions er ON er.id = ss.exercise_revision_id WHERE ss.id = ?").get(slotId) as { rid: string; q: string | null; type: string; content: string } | undefined;
  if (!s) return;
  const texts = shownTexts(JSON.parse(s.content) as { prompt_en: string; payload: Record<string, any> }, s.type, s.q);
  const ins = insertEnc(db, deps);
  for (const e of entries) {
    const forms = formsOf(e);
    const n = texts.reduce((a, t) => a + countOccurrences(t, forms), 0);
    for (let k = 0; k < n; k++) ins.run(id(deps), e.id, s.rid, slotId, "displayed", k, deps.now().toISOString());
  }
}

export interface VocabularyTotals {
  words: number;
  learned: number;
  bankOccurrences: number;
  displayedOccurrences: number;
}
/** entries whose latest event is not a removal (D63) */
const VISIBLE = "(SELECT kind FROM vocabulary_entry_events ev WHERE ev.entry_id = vocabulary_entries.id ORDER BY ev.created_at DESC, ev.rowid DESC LIMIT 1) IS NOT 'removed'";
const VISIBLE_ENC = "entry_id IN (SELECT id FROM vocabulary_entries WHERE " + VISIBLE + ")";

export function vocabularyTotals(db: Db): VocabularyTotals {
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    words: n(`SELECT COUNT(*) AS n FROM vocabulary_entries WHERE ${VISIBLE}`),
    learned: n(`SELECT COUNT(*) AS n FROM vocabulary_entries WHERE learned = 1 AND ${VISIBLE}`),
    bankOccurrences: n(`SELECT COUNT(*) AS n FROM vocabulary_encounters WHERE kind = 'bank' AND ${VISIBLE_ENC}`),
    displayedOccurrences: n(`SELECT COUNT(*) AS n FROM vocabulary_encounters WHERE kind = 'displayed' AND ${VISIBLE_ENC}`),
  };
}
