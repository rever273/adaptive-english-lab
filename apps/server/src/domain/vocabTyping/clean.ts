import type { Db } from "../../db/open.js";
import type { ChatClient } from "../ai/clients.js";
import { runStructured } from "../ai/structured.js";
import { bad, ok, parseObject, str } from "../wordLessons/validate.js";
import { archiveWord } from "./bankEdit.js";
import type { Deps } from "./data.js";

/**
 * Dictionary cleanup by the local model (D165). The model only ADVISES about each entry; the answer is validated by code, softened by conservative rules and
 * appended to `vocab_typing_cleanup`. Nothing is ever deleted and `typing_word_bank` is never touched. The prompt is registered by this version id (kept
 * next to the code: the shared prompt registry belongs to other work in progress).
 */
// v2: an unchanged translation counts as "no change" (the pilot dry runs before it were v1)
export const CLEAN_PROMPT_VERSION = "vt-clean-v2";
export const BATCH_SIZE = 25;
/** `exclude` below this confidence is stored as `needs_review` */
export const MIN_EXCLUDE_CONFIDENCE = 0.7;
/** an entry among the most frequent words is never excluded by the model alone */
export const PROTECTED_RANK = 3000;
export const MAX_TRANSLATION_CHARS = 60;

export interface CleanWord {
  /** 1-based position in the batch (the model refers to it) */
  wordId: number;
  lemma: string;
  pos: string;
  translationRu: string;
  definitionRu: string;
  transcription: string;
  rank: number;
}

export type Decision = "keep" | "exclude" | "needs_review";
export interface CleanDecision {
  lemma: string;
  decision: Decision;
  reason: string;
  confidence: number;
  primaryTranslationRu: string | null;
  secondary: string[];
  transcriptionDoubt: boolean;
  /** the model said `exclude` and a conservative rule changed it */
  softened: boolean;
}

export const CLEAN_SYSTEM = `You help to clean an English-Russian dictionary used by a Russian-speaking adult learner of English. For every entry decide whether it is a useful general-English word to learn.
Decisions:
- "keep": an ordinary word with a normal meaning, including common words that also look like names (may, march, turkey, will, bill, rose, mark, bank).
- "exclude": a proper name or place name without an ordinary meaning, an abbreviation, a fragment, a non-word, an inflected form that is not a word of its own, or an entry that is not English vocabulary.
- "needs_review": you doubt. Prefer it to "exclude" whenever you are not sure.
Also look at the Russian translation. Give "primary_translation_ru" ONLY when the stored translation is wrong or misleading for the most common meaning (when the stored translation is acceptable, use null: never repeat it): one Russian word or a short phrase (at most ${MAX_TRANSLATION_CHARS} characters, Cyrillic, no lists). Give up to 3 "secondary_translations_ru" for other main meanings, or an empty list. Do not correct the transcription: set "transcription_doubt" to true when it looks wrong.
"confidence" is a number from 0 to 1. "reason" is one short English sentence.
Answer with JSON only, one decision for every entry, using the entry's "id".`;

export function cleanUser(words: readonly CleanWord[]): string {
  const rows = words.map((w) => ({ id: w.wordId, word: w.lemma, part_of_speech: w.pos, translation_ru: w.translationRu, definition_ru: w.definitionRu.slice(0, 160), transcription: w.transcription, frequency_rank: w.rank }));
  return `Entries:\n${JSON.stringify(rows)}\n\nAnswer: {"decisions":[{"id":number,"decision":"keep"|"exclude"|"needs_review","reason":string,"confidence":number,"primary_translation_ru":string|null,"secondary_translations_ru":string[],"transcription_doubt":boolean}]}`;
}

export const cleanFormat = {
  type: "object",
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          decision: { type: "string", enum: ["keep", "exclude", "needs_review"] },
          reason: { type: "string" },
          confidence: { type: "number" },
          primary_translation_ru: { type: ["string", "null"] },
          secondary_translations_ru: { type: "array", items: { type: "string" } },
          transcription_doubt: { type: "boolean" },
        },
        required: ["id", "decision", "reason", "confidence"],
      },
    },
  },
  required: ["decisions"],
} as const;

const CYRILLIC = /[Ѐ-ӿ]/;
/** one Russian word or short phrase: Cyrillic, short, no list (a comma or semicolon would make it an enumeration) */
export function validTranslation(t: unknown): t is string {
  return typeof t === "string" && t.trim().length > 0 && t.trim().length <= MAX_TRANSLATION_CHARS && CYRILLIC.test(t) && !/[;,\n]/.test(t) && !/[A-Za-z]{3,}/.test(t);
}

/** `exclude` is the only decision that removes a word, so it is the only one that is softened */
export function conservative(d: { decision: Decision; confidence: number }, rank: number): { decision: Decision; softened: boolean } {
  if (d.decision === "exclude" && (d.confidence < MIN_EXCLUDE_CONFIDENCE || rank <= PROTECTED_RANK)) return { decision: "needs_review", softened: true };
  return { decision: d.decision, softened: false };
}

export interface CleanBatchResult {
  decisions: CleanDecision[];
  /** lemma -> machine code; these words stay unprocessed and are retried by --resume */
  errors: Array<{ lemma: string; code: string }>;
}

/** the shape of the whole answer decides whether the call is repaired; a bad item only costs that word */
export function validateClean(text: string, batch: readonly CleanWord[]) {
  const o = parseObject(text);
  if (!o || !Array.isArray(o.decisions)) return bad<CleanBatchResult>("SHAPE", 'expected {"decisions":[...]}');
  const byId = new Map(batch.map((w) => [w.wordId, w]));
  const seen = new Set<number>();
  const result: CleanBatchResult = { decisions: [], errors: [] };
  const fail = (w: CleanWord | undefined, code: string) => {
    if (w) result.errors.push({ lemma: w.lemma, code });
  };
  for (const raw of o.decisions as unknown[]) {
    const it = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const id = typeof it.id === "number" ? it.id : Number.NaN;
    const w = byId.get(id);
    if (!w) continue; // an id that is not in the batch is ignored
    if (seen.has(id)) {
      fail(w, "duplicate_id");
      continue;
    }
    seen.add(id);
    const decision = it.decision;
    if (decision !== "keep" && decision !== "exclude" && decision !== "needs_review") {
      fail(w, "bad_decision");
      continue;
    }
    const confidence = typeof it.confidence === "number" && it.confidence >= 0 && it.confidence <= 1 ? it.confidence : Number.NaN;
    if (Number.isNaN(confidence)) {
      fail(w, "bad_confidence");
      continue;
    }
    const primary = it.primary_translation_ru === null || it.primary_translation_ru === undefined || it.primary_translation_ru === "" ? null : it.primary_translation_ru;
    if (primary !== null && !validTranslation(primary)) {
      fail(w, "bad_translation");
      continue;
    }
    // the model likes to repeat the stored translation: that is no change
    const primarySame = typeof primary === "string" && primary.trim().toLowerCase() === w.translationRu.trim().toLowerCase();
    const secondaryRaw = Array.isArray(it.secondary_translations_ru) ? (it.secondary_translations_ru as unknown[]) : [];
    if (secondaryRaw.length > 3 || secondaryRaw.some((s) => !validTranslation(s))) {
      fail(w, "bad_translation");
      continue;
    }
    const soft = conservative({ decision, confidence }, w.rank);
    const reason = str(it.reason).slice(0, 200);
    result.decisions.push({
      lemma: w.lemma,
      decision: soft.decision,
      reason: soft.softened ? `${reason} (model said exclude; kept for review)`.trim() : reason,
      confidence,
      primaryTranslationRu: primary === null || primarySame ? null : (primary as string).trim(),
      secondary: (secondaryRaw as string[]).map((s) => s.trim()),
      transcriptionDoubt: it.transcription_doubt === true,
      softened: soft.softened,
    });
  }
  for (const w of batch) if (!seen.has(w.wordId)) fail(w, "missing_word");
  return ok(result);
}

export async function cleanBatch(client: ChatClient, model: string, batch: readonly CleanWord[], signal?: AbortSignal): Promise<{ ok: true; result: CleanBatchResult } | { ok: false; code: string }> {
  const r = await runStructured<CleanBatchResult>({
    client,
    model,
    messages: [{ role: "system", content: CLEAN_SYSTEM }, { role: "user", content: cleanUser(batch) }],
    format: cleanFormat,
    options: { num_ctx: 8192, num_predict: 3000, temperature: 0, seed: 42 },
    validate: (t) => validateClean(t, batch),
    ...(signal ? { signal } : {}),
  });
  if (r.ok) return { ok: true, result: r.value };
  return { ok: false, code: r.code };
}

// ---- storage (apply mode)

export interface RunInfo {
  id: string;
  mode: "dry" | "apply";
  params: Record<string, unknown>;
  model: string;
}

export function startRun(db: Db, deps: Deps, info: Omit<RunInfo, "id">): string {
  const id = deps.newId();
  db.prepare("INSERT INTO vocab_typing_cleanup_runs(id, mode, params_json, model_tag, prompt_version, started_at) VALUES (?,?,?,?,?,?)").run(id, info.mode, JSON.stringify(info.params), info.model, CLEAN_PROMPT_VERSION, deps.now().toISOString());
  return id;
}

export function finishRun(db: Db, deps: Deps, runId: string, totals: Record<string, unknown>): void {
  db.prepare("UPDATE vocab_typing_cleanup_runs SET finished_at = ?, totals_json = ? WHERE id = ?").run(deps.now().toISOString(), JSON.stringify(totals), runId);
}

const ELIGIBILITY: Record<Decision, string> = { keep: "keep", exclude: "excluded", needs_review: "needs_review" };

/**
 * One batch in one transaction (D175, D184): the decisions are appended, the lexicon follows the latest valid one, a refined translation is written
 * straight into typing_word_bank.translation_ru and an "exclude" ARCHIVES the word (archived_by 'model'): it stays in the bank but no practice reads it.
 * The caller must have made a backup first (the old translation is kept only there).
 */
export function applyDecisions(db: Db, deps: Deps, runId: string, model: string, decisions: readonly CleanDecision[]): void {
  const stamp = deps.now().toISOString();
  db.transaction(() => {
    const put = db.prepare("INSERT INTO vocab_typing_cleanup(id, run_id, lemma, actor, decision, reason, primary_translation_ru, secondary_json, confidence, transcription_doubt, model_tag, prompt_version, created_at) VALUES (?,?,?,'model',?,?,?,?,?,?,?,?,?)");
    const set = db.prepare("UPDATE vocab_typing_lexicon SET eligibility = ?, exclusion_reason = ?, primary_translation_ru = ?, secondary_translations_json = ?, cleanup_id = ?, updated_at = ? WHERE lemma = ?");
    const tr = db.prepare("UPDATE typing_word_bank SET translation_ru = ? WHERE lemma = ?");
    for (const d of decisions) {
      const id = deps.newId();
      put.run(id, runId, d.lemma, d.decision, d.reason, d.primaryTranslationRu, d.secondary.length ? JSON.stringify(d.secondary) : null, d.confidence, d.transcriptionDoubt ? 1 : 0, model, CLEAN_PROMPT_VERSION, stamp);
      set.run(ELIGIBILITY[d.decision], d.decision === "exclude" ? d.reason : null, d.primaryTranslationRu, d.secondary.length ? JSON.stringify(d.secondary) : null, id, stamp, d.lemma);
      if (d.decision === "exclude") archiveWord(db, d.lemma, "model", d.reason, stamp);
      else if (d.primaryTranslationRu) tr.run(d.primaryTranslationRu, d.lemma);
    }
  }).immediate();
}

/**
 * An applied cleanup cannot be reverted word by word: it overwrote translations in the word bank and the old ones live only in the backup the script
 * made before it. Archived words can be restored one by one in Analyze.
 */
export function revertRun(_db: Db, _deps: Deps, runId: string): number {
  throw new Error("Run " + runId + " changed translations in the word bank, so it cannot be reverted. Restore the backup made before it (npm run restore); archived words can be restored one by one in the Analyze tab.");
}
