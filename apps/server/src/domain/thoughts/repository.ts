import type { Db } from "../../db/open.js";
import { ApiError } from "../../errors.js";
import { difficultyLevels } from "@english-lab/contracts";
import { enqueue } from "../../queue/jobs.js";
import { ensurePromptVersion } from "../ai/prompts.js";
import { draftFormatsText } from "../content/batches/draftFormats.js";
import { planTopic, type ItemPlan } from "../content/batches/plan.js";
import { normalizeSentence } from "../content/normalize.js";
import { taxonomyForNewRevisions } from "../content/repository.js";
import { loadSettings } from "../sessions/policy.js";

export interface ThoughtDeps {
  now: () => Date;
  newId: () => string;
}

export const MAX_THOUGHT_CHARS = 500;

export interface ThoughtView {
  id: string;
  textRu: string;
  createdAt: string;
  /** latest analysis; "pending" until the analysis stage (TASK_026 stage 2) has run */
  status: "pending" | "needs_skills" | "ok" | "ambiguous" | "no_skill" | "failed";
  /** the AI's English reading, only when the analysis is ok; always a draft until reviewed content is published */
  englishDraft: string | null;
}

/**
 * Saves one Russian thought. The same text (case, spacing and final punctuation ignored) returns the existing row, so a double
 * click or a re-send never makes a second thought. Nothing here calls a model.
 */
export function addThought(db: Db, deps: ThoughtDeps, rawText: string): { thought: ThoughtView; created: boolean } {
  const text = rawText.replace(/\s+/g, " ").trim();
  if (text.length === 0) throw new ApiError(422, "THOUGHT_EMPTY", "Write a thought first.");
  if (text.length > MAX_THOUGHT_CHARS) throw new ApiError(422, "THOUGHT_TOO_LONG", `A thought is at most ${MAX_THOUGHT_CHARS} characters.`);
  if (!/\p{Script=Cyrillic}/u.test(text)) throw new ApiError(422, "THOUGHT_NOT_RUSSIAN", "Write the thought in Russian.");
  const key = normalizeSentence(text);
  const tx = db.transaction(() => {
    const existing = db.prepare("SELECT id FROM personal_thoughts WHERE text_key = ?").get(key) as { id: string } | undefined;
    if (existing) return { id: existing.id, created: false };
    const id = deps.newId();
    const now = deps.now().toISOString();
    db.prepare("INSERT INTO personal_thoughts(id, text_ru, text_key, created_at) VALUES (?,?,?,?)").run(id, text, key, now);
    db.prepare("INSERT INTO thought_analyses(id, thought_id, status, created_at) VALUES (?,?,?,?)").run(deps.newId(), id, "pending", now);
    // the model reads the thought later through the single GPU dispatcher; saving never waits for it
    enqueue(db, deps, { kind: "generation", payload: { thoughtId: id }, idempotencyKey: `thought:${id}`, priority: 3 });
    return { id, created: true };
  });
  const r = tx();
  return { thought: getThought(db, r.id)!, created: r.created };
}

function view(r: { id: string; textRu: string; createdAt: string; status: ThoughtView["status"] | null; output: string | null }): ThoughtView {
  let english: string | null = null;
  if ((r.status === "ok" || r.status === "needs_skills") && r.output) {
    try {
      const e = (JSON.parse(r.output) as { english?: unknown }).english;
      if (typeof e === "string") english = e;
    } catch {
      /* a broken output is shown as no English reading */
    }
  }
  return { id: r.id, textRu: r.textRu, createdAt: r.createdAt, status: r.status ?? "pending", englishDraft: english };
}

const SELECT = `SELECT t.id AS id, t.text_ru AS textRu, t.created_at AS createdAt, a.status AS status, a.output_json AS output
  FROM personal_thoughts t
  LEFT JOIN thought_analyses a ON a.id = (SELECT id FROM thought_analyses WHERE thought_id = t.id ORDER BY created_at DESC, rowid DESC LIMIT 1)`;

export function getThought(db: Db, id: string): ThoughtView | undefined {
  const r = db.prepare(`${SELECT} WHERE t.id = ?`).get(id) as Parameters<typeof view>[0] | undefined;
  return r ? view(r) : undefined;
}

const GENERATION_PROMPT_ID = "generation-v10";
/** skill families where "rewrite this sentence" is a natural task (articles, prepositions and agreement are not) */
const BLOCK_FAMILIES = new Set(["word_order", "questions", "tenses", "conditionals", "reported_speech", "modals", "verb_patterns", "passive", "relatives", "linking"]);
const TRANSFORM_FAMILIES = new Set(["tenses", "conditionals", "reported_speech", "modals", "verb_patterns", "linking", "questions", "passive", "relatives"]);
const LATEST = "a.id = (SELECT id FROM thought_analyses WHERE thought_id = a.thought_id ORDER BY created_at DESC, rowid DESC LIMIT 1)";

/** Thoughts the model has read that wait for an agent to choose the grammar skills of their patterns. */
export function thoughtsNeedingSkills(db: Db): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM thought_analyses a WHERE a.status = 'needs_skills' AND ${LATEST}`).get() as { n: number }).n;
}

/** Thoughts whose latest analysis is "ok" and that no batch has used yet. */
export function thoughtsReady(db: Db): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM thought_analyses a WHERE a.status = 'ok' AND a.batch_id IS NULL AND ${LATEST}`).get() as { n: number }).n;
}

/**
 * One ordinary draft batch (formats: choose the natural phrase, and a rewrite task with a hint) from every analysed thought that has none yet. The model never sees the
 * learner's sentence, only the abstract pattern. Drafts then follow the normal validation and independent review; nothing is published here.
 */
export function createThoughtBatch(db: Db, deps: ThoughtDeps): { batchId: string; items: number; thoughts: number } {
  return db
    .transaction(() => {
      const ready = db
        .prepare(`SELECT a.id AS analysisId, a.thought_id AS thoughtId, a.output_json AS output FROM thought_analyses a WHERE a.status = 'ok' AND a.batch_id IS NULL AND ${LATEST} ORDER BY a.created_at, a.rowid`)
        .all() as Array<{ analysisId: string; thoughtId: string; output: string }>;
      if (ready.length === 0) throw new ApiError(409, "NO_THOUGHTS_READY", "No analysed thoughts are waiting. Save a thought in Practice and wait for it to be read.");
      const tax = taxonomyForNewRevisions(db);
      const levels = difficultyLevels(loadSettings(db).values);
      const batchId = deps.newId();
      const plans: ItemPlan[] = [];
      for (const r of ready) {
        const out = JSON.parse(r.output) as { english: string; constructions: Array<{ pattern: string; skill_id: string | null }> };
        for (const c of out.constructions) {
          if (!c.skill_id || !tax.skills.has(c.skill_id)) continue; // a pattern without a confirmed skill is never drafted
          const ordinal = plans.length;
          const base = { target_skill: c.skill_id, transfer: { thoughtId: r.thoughtId, pattern: c.pattern, source_en: out.english } };
          const at = (n: number) => ({ ordinal: n, topic: planTopic(n), context_id: `thought-${r.thoughtId.slice(0, 8)}-${n}`, ...(levels ? { level: levels[n % levels.length]! } : {}) });
          // format A: choose the natural phrase (existing type). Every confirmed pattern gets one.
          plans.push({ ...base, ...at(ordinal), type: "choose_missing_fragment", dimension: "recognition" });
          // format C: rewrite a sentence in another construction, with a grammar hint. Only for skills where a rewrite is natural; the reviewer can still reject it.
          if (TRANSFORM_FAMILIES.has(c.skill_id.split(".")[0]!)) plans.push({ ...base, ...at(plans.length), type: "guided_short_answer", dimension: "production", variant: "transform" });
          // format B: build the sentence from blocks (type assemble_sentence, only ever made from thoughts). Without a wrong block it would test word order alone, so the draft must carry one (code enforces it).
          if (BLOCK_FAMILIES.has(c.skill_id.split(".")[0]!)) plans.push({ ...base, ...at(plans.length), type: "assemble_sentence", dimension: "recognition" });
        }
      }
      if (plans.length === 0) throw new ApiError(409, "NO_THOUGHTS_READY", "The analysed thoughts have no usable grammar pattern.");
      const promptVersionId = ensurePromptVersion(db, GENERATION_PROMPT_ID, draftFormatsText(GENERATION_PROMPT_ID));
      const now = deps.now().toISOString();
      db.prepare("INSERT INTO batches(id, requested_count, mode, purpose, prompt_version_id, spec_json, created_at) VALUES (?,?,?,?,?,?,?)").run(batchId, plans.length, "manual", "scale", promptVersionId, JSON.stringify({ category: "grammar", source: "thoughts", thoughts: ready.length }), now);
      const insItem = db.prepare("INSERT INTO batch_items(id, batch_id, ordinal, plan_json, state, updated_at) VALUES (?,?,?,?,?,?)");
      for (const p of plans) insItem.run(deps.newId(), batchId, p.ordinal, JSON.stringify(p), "queued", now);
      const setJob = db.prepare("UPDATE batch_items SET job_id = ? WHERE batch_id = ? AND ordinal = ?");
      // one draft per call: each carries its own pattern
      for (const p of plans) {
        const { job } = enqueue(db, deps, { kind: "generation", payload: { batchId, ordinals: [p.ordinal] }, idempotencyKey: `generation:${batchId}:${p.ordinal}`, batchId, priority: 3 });
        setJob.run(job.id, batchId, p.ordinal);
      }
      const mark = db.prepare("UPDATE thought_analyses SET batch_id = ? WHERE id = ?");
      for (const r of ready) mark.run(batchId, r.analysisId);
      return { batchId, items: plans.length, thoughts: ready.length };
    })
    .immediate();
}

export function listThoughts(db: Db, limit = 50): ThoughtView[] {
  return (db.prepare(`${SELECT} ORDER BY t.created_at DESC, t.rowid DESC LIMIT ?`).all(limit) as Array<Parameters<typeof view>[0]>).map(view);
}
