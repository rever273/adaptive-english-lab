import type { ClozeAnalysisResult, ClozeAnalysisView } from "@english-lab/contracts";
import type { Db } from "../../db/open.js";
import { ApiError } from "../../errors.js";
import { enqueue } from "../../queue/jobs.js";
import { RunnerError, type RunnerContext, type RunnerOutput } from "../../queue/types.js";
import type { ChatClient } from "../ai/clients.js";
import { AI_CONFIG_V3, RESIDENT_NUM_CTX } from "../ai/config.js";
import { ensurePromptVersion, GRAMMAR_CLOZE_ANALYSIS_V2 } from "../ai/prompts.js";
import { skillCard } from "../skills/cards.js";
import type { Deps } from "./repository.js";

export const ANALYSIS_PROMPT = "grammar-cloze-analysis-v2";
/** a request whose job never finished is given up after this long, so "Try again" can ask anew */
const STALE_MS = 3 * 60 * 1000;
const CYRILLIC = /[Ѐ-ӿ]/;

export interface AnalysisPayload {
  grammarClozeAnalysisId: string;
}

export const ANALYSIS_FORMAT = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "options", "rule_en", "explanation_ru", "caution_ru"],
  properties: {
    verdict: { type: "string", enum: ["key_ok", "several_correct", "key_wrong", "ambiguous", "broken"] },
    options: { type: "array", minItems: 2, maxItems: 4, items: { type: "object", additionalProperties: false, required: ["text", "fits", "why_ru"], properties: { text: { type: "string" }, fits: { type: "string", enum: ["yes", "no", "maybe"] }, why_ru: { type: "string" } } } },
    rule_en: { type: "string" },
    explanation_ru: { type: "string" },
    caution_ru: { type: "string" },
  },
} as const;

export function viewOf(db: Db, id: string): ClozeAnalysisView {
  const row = db.prepare("SELECT id, status, result_json AS result, error_code AS errorCode FROM grammar_cloze_ai_analyses WHERE id = ?").get(id) as { id: string; status: "pending" | "done" | "failed"; result: string | null; errorCode: string | null } | undefined;
  if (!row) throw new ApiError(404, "CLOZE_ANALYSIS_NOT_FOUND", "Unknown analysis");
  return { id: row.id, status: row.status, result: row.result ? (JSON.parse(row.result) as { analysis: ClozeAnalysisResult }).analysis : null, errorCode: row.errorCode };
}

/** Asks the local model (once per revision and prompt version) for an opinion on a sentence that was already answered or excluded. */
export function requestAnalysis(db: Db, deps: Deps, itemId: string, sessionId: string, position: number): ClozeAnalysisView {
  const id = db
    .transaction((): string => {
      const slot = db.prepare("SELECT s.revision_id AS rev FROM grammar_cloze_session_items s WHERE s.session_id = ? AND s.position = ? AND s.item_id = ?").get(sessionId, position, itemId) as { rev: string } | undefined;
      if (!slot) throw new ApiError(404, "CLOZE_POSITION_NOT_FOUND", "That sentence is not in this session");
      const settled = db.prepare("SELECT 1 FROM grammar_cloze_attempts WHERE session_id = ? AND position = ?").get(sessionId, position) || db.prepare("SELECT 1 FROM grammar_cloze_exclusions WHERE item_id = ?").get(itemId);
      if (!settled) throw new ApiError(409, "ANSWER_FIRST", "Answer the sentence first: the analysis would show the key");
      ensurePromptVersion(db, ANALYSIS_PROMPT, JSON.stringify(ANALYSIS_FORMAT));
      const prior = db.prepare("SELECT id, status, created_at AS createdAt FROM grammar_cloze_ai_analyses WHERE revision_id = ? AND prompt_version = ? AND status <> 'failed'").get(slot.rev, ANALYSIS_PROMPT) as { id: string; status: string; createdAt: string } | undefined;
      if (prior) {
        if (prior.status === "pending" && deps.now().getTime() - Date.parse(prior.createdAt) > STALE_MS) db.prepare("UPDATE grammar_cloze_ai_analyses SET status = 'failed', error_code = 'stale', finished_at = ? WHERE id = ?").run(deps.now().toISOString(), prior.id);
        else return prior.id;
      }
      const fresh = deps.newId();
      db.prepare("INSERT INTO grammar_cloze_ai_analyses(id, revision_id, prompt_version, status, created_at) VALUES (?,?,?,'pending',?)").run(fresh, slot.rev, ANALYSIS_PROMPT, deps.now().toISOString());
      enqueue(db, deps, { kind: "tutor", priority: 1, payload: { grammarClozeAnalysisId: fresh }, idempotencyKey: `grammar-cloze-analysis:${fresh}` });
      return fresh;
    })
    .immediate();
  return viewOf(db, id);
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

/** the model's JSON, checked by code; null when it cannot be used */
export function validateAnalysis(text: string, options: string[]): ClozeAnalysisResult | null {
  let v: Partial<ClozeAnalysisResult>;
  try {
    v = JSON.parse(text) as Partial<ClozeAnalysisResult>;
  } catch {
    return null;
  }
  if (!v || !["key_ok", "several_correct", "key_wrong", "ambiguous", "broken"].includes(String(v.verdict))) return null;
  if (!Array.isArray(v.options) || typeof v.rule_en !== "string" || typeof v.explanation_ru !== "string" || typeof v.caution_ru !== "string") return null;
  if (!CYRILLIC.test(v.explanation_ru) || v.explanation_ru.length > 1500 || v.rule_en.length > 400 || v.caution_ru.length > 500) return null;
  const want = options.map(norm).sort();
  const got = v.options.map((o) => norm(String(o?.text ?? ""))).sort();
  if (want.length !== got.length || want.some((w, i) => w !== got[i])) return null;
  if (v.options.some((o) => !["yes", "no", "maybe"].includes(String(o.fits)) || typeof o.why_ru !== "string" || o.why_ru.length > 400)) return null;
  return v as ClozeAnalysisResult;
}

/** The tutor runner hands the job here (the same GPU lease and cancellation apply). Bad output is stored as `failed`, never as an answer. */
export async function runGrammarClozeAnalysis(db: Db, chat: ChatClient, ctx: RunnerContext<AnalysisPayload>): Promise<RunnerOutput> {
  const id = ctx.job.payload.grammarClozeAnalysisId;
  const row = db.prepare("SELECT a.status, r.gapped_text AS gapped, r.solution, r.distractors_json AS d, r.filled_text AS filled, r.skill_id AS skill FROM grammar_cloze_ai_analyses a JOIN grammar_cloze_revisions r ON r.id = a.revision_id WHERE a.id = ?").get(id) as { status: string; gapped: string; solution: string; d: string; filled: string; skill: string | null } | undefined;
  if (!row || row.status !== "pending") return { schemaVersion: "grammar-cloze-analysis-v1", output: { skipped: true } };
  const options = [row.solution, ...(JSON.parse(row.d) as string[])];
  const card = row.skill ? skillCard(row.skill) : undefined;
  const user = JSON.stringify({ sentence_with_gap: row.gapped, full_sentence_with_answer_key: row.filled, answer_key: row.solution, options, ...(card ? { rule_card: { name: card.displayName, rule: card.rule } } : {}) });
  const result = await chat.chat({ model: AI_CONFIG_V3.analysis.tag, messages: [{ role: "system", content: GRAMMAR_CLOZE_ANALYSIS_V2 }, { role: "user", content: user }], format: ANALYSIS_FORMAT, options: { num_ctx: RESIDENT_NUM_CTX, num_predict: 1200, temperature: 0.2 }, signal: ctx.signal });
  if (!result.text.trim()) throw new RunnerError("empty_output", "The model returned nothing", true);
  const parsed = validateAnalysis(result.text, options);
  const at = new Date().toISOString();
  return {
    schemaVersion: "grammar-cloze-analysis-v1",
    output: { analysisId: id, ok: parsed !== null },
    alsoCommit: (tx) => {
      if (parsed) tx.prepare("UPDATE grammar_cloze_ai_analyses SET status = 'done', result_json = ?, finished_at = ? WHERE id = ? AND status = 'pending'").run(JSON.stringify({ analysis: parsed, model: AI_CONFIG_V3.analysis.tag }), at, id);
      else tx.prepare("UPDATE grammar_cloze_ai_analyses SET status = 'failed', error_code = 'invalid_output', finished_at = ? WHERE id = ? AND status = 'pending'").run(at, id);
    },
  };
}
