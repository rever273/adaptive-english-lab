import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Db } from "../../db/open.js";
import { ApiError } from "../../errors.js";
import { enqueue } from "../../queue/jobs.js";
import { bankTexts, countOccurrences, isValidWord, matchForms, normalizeWord, shownTexts } from "./forms.js";

export const VOCAB_PROMPT = "vocabulary-v1";
export const POS_VALUES = ["noun", "verb", "adjective", "adverb", "preposition", "conjunction", "pronoun", "determiner", "phrase", "phrasal verb", "idiom", "other"] as const;

interface Deps {
  now: () => Date;
  newId?: () => string;
}
const id = (d: Deps): string => (d.newId ?? randomUUID)();

export const AddWordSchema = z.object({ word: z.string().min(1).max(120), selected: z.string().min(1).max(120).optional() }).strict();
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
  const pending = db.prepare("SELECT 1 FROM jobs WHERE idempotency_key LIKE ? AND state IN ('queued','waiting_for_gpu','running','paused') LIMIT 1").get(`vocab:${e.id}:%`) !== undefined;
  return {
    id: e.id,
    lemma: e.lemma,
    pos: pos.text || "unknown",
    posSource: pos.source,
    learned: e.learned === 1,
    userRevision: e.user_revision,
    surfaceForms: JSON.parse(e.surface_forms_json) as string[],
    translation: pick(user?.translation_ru, model?.translation_ru),
    example: pick(user?.example_en, model?.example_en),
    collocations: uc.length > 0 ? { items: uc, source: "user" } : mc.length > 0 ? { items: mc, source: "ai_draft" } : { items: [], source: null },
    draftPredatesEdit: model?.based_on_user_rev != null && model.based_on_user_rev < e.user_revision,
    aiPending: pending,
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
        return { entry: getEntry(db, existing.id), created: false };
      }
      const entryId = id(deps);
      const forms = selected !== lemma && isValidWord(selected) ? [selected] : [];
      db.prepare("INSERT INTO vocabulary_entries(id, lemma, pos, language, learned, user_revision, surface_forms_json, created_at) VALUES (?,?,?,?,?,?,?,?)").run(entryId, lemma, "unknown", "en", 0, 0, JSON.stringify(forms), deps.now().toISOString());
      scanBankForEntry(db, deps, entryId);
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
      if (b.learned !== undefined) db.prepare("UPDATE vocabulary_entries SET learned = ? WHERE id = ?").run(b.learned ? 1 : 0, entryId);
      return getEntry(db, entryId);
    })
    .immediate();
}

export function listWords(db: Db, o: { q?: string; learned?: boolean; limit?: number } = {}): { words: EntryView[]; total: number } {
  const rows = db.prepare("SELECT id, lemma, pos, learned, user_revision, surface_forms_json, created_at FROM vocabulary_entries ORDER BY lemma").all() as EntryRow[];
  const q = o.q ? normalizeWord(o.q) : "";
  const all = rows.map((r) => view(db, r)).filter((v) => (o.learned === undefined || v.learned === o.learned) && (q === "" || v.lemma.includes(q) || v.translation.text.toLowerCase().includes(q) || v.surfaceForms.some((f) => f.includes(q))));
  return { words: all.slice(0, o.limit ?? 500), total: all.length };
}

/** For the popup: is the selected word (or a form of it) already saved? */
export function lookupWord(db: Db, word: string): EntryView | null {
  const w = normalizeWord(word);
  if (!w) return null;
  const rows = db.prepare("SELECT id, lemma, pos, learned, user_revision, surface_forms_json, created_at FROM vocabulary_entries").all() as EntryRow[];
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
export function vocabularyTotals(db: Db): VocabularyTotals {
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    words: n("SELECT COUNT(*) AS n FROM vocabulary_entries"),
    learned: n("SELECT COUNT(*) AS n FROM vocabulary_entries WHERE learned = 1"),
    bankOccurrences: n("SELECT COUNT(*) AS n FROM vocabulary_encounters WHERE kind = 'bank'"),
    displayedOccurrences: n("SELECT COUNT(*) AS n FROM vocabulary_encounters WHERE kind = 'displayed'"),
  };
}
