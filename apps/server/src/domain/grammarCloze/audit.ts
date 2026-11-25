import { randomUUID } from "node:crypto";
import type { ClozeAnalysisResult, ClozeAuditOverview, ClozeAuditResult, ClozeAuditRow } from "@english-lab/contracts";
import type { Db } from "../../db/open.js";
import { ApiError } from "../../errors.js";
import { applyAction, enqueue } from "../../queue/jobs.js";
import { RunnerError, type RunnerContext, type RunnerOutput } from "../../queue/types.js";
import type { ChatClient } from "../ai/clients.js";
import { AI_CONFIG_V3, RESIDENT_NUM_CTX } from "../ai/config.js";
import { ensurePromptVersion, GRAMMAR_CLOZE_AUDIT_V1 } from "../ai/prompts.js";
import { skillCard } from "../skills/cards.js";
import { ACTIVE_SOURCE, type Deps } from "./repository.js";

/**
 * Background check of the Grammar Cloze bank by the local model (one short opinion per sentence revision). The opinion is advisory: it never
 * changes an answer, a statistic or an item status. A finished check whose verdict is not "key_ok" hides the sentence from NEW sessions and
 * keeps it out of the next stage; the learner can restore it in Content Studio (grammar_cloze_audit_overrides). Bad model output is stored
 * as failed and retried once.
 */
export const AUDIT_PROMPT = "grammar-cloze-audit-v1";
/** sentences per background job: short, so a foreground request never waits long and a pause loses little */
export const AUDIT_CHUNK = 10;
const MAX_FAILED = 5;
/** an unreadable sentence is asked again after this long (the model may simply have been switched off), at most MAX_FAILED times in all */
export const RETRY_AFTER_MS = 2 * 60 * 60 * 1000;
const cutoff = (now: Date = new Date()): string => new Date(now.getTime() - RETRY_AFTER_MS).toISOString();
const CYRILLIC = /[Ѐ-ӿ]/;
const VERDICTS = ["key_ok", "several_correct", "key_wrong", "ambiguous", "broken"] as const;
const OPEN_STATES = "('queued','waiting_for_gpu','running','paused')";

export const AUDIT_FORMAT = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "other_correct", "reason_ru", "cues", "names"],
  properties: {
    verdict: { type: "string", enum: [...VERDICTS] },
    other_correct: { type: "array", maxItems: 3, items: { type: "string" } },
    reason_ru: { type: "string" },
    cues: { type: "array", maxItems: 3, items: { type: "string" } },
    names: { type: "array", maxItems: 6, items: { type: "string" } },
  },
} as const;

export interface AuditPayload {
  grammarClozeAudit: 1;
}

/**
 * SQL: 1 when the sentence (alias of grammar_cloze_items) is hidden by a model check or by hand. The learner's latest decision for the
 * current revision wins; otherwise any finished check of the current revision with a verdict other than key_ok hides it.
 */
export const hiddenSql = (i: string): string => `COALESCE(
  (SELECT o.action = 'hide' FROM grammar_cloze_audit_overrides o WHERE o.item_id = ${i}.id AND o.revision_id = ${i}.current_revision_id ORDER BY o.created_at DESC, o.rowid DESC LIMIT 1),
  EXISTS (SELECT 1 FROM grammar_cloze_ai_analyses x WHERE x.revision_id = ${i}.current_revision_id AND x.status = 'done'
           AND COALESCE(json_extract(x.result_json, '$.audit.verdict'), json_extract(x.result_json, '$.analysis.verdict')) <> 'key_ok'))`;

/** SQL: 1 when the current revision passed the background check (used to prefer checked sentences) */
export const checkedOkSql = (i: string): string =>
  `EXISTS (SELECT 1 FROM grammar_cloze_ai_analyses x WHERE x.revision_id = ${i}.current_revision_id AND x.prompt_version = '${AUDIT_PROMPT}' AND x.status = 'done' AND json_extract(x.result_json, '$.audit.verdict') = 'key_ok')`;

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** the phrase occurs in the sentence as whole words (case-insensitive) and is not inside the gap */
const occurs = (text: string, phrase: string): boolean => {
  const p = phrase.trim();
  if (!p || p.includes("___")) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}'])${escapeRe(p)}($|[^\\p{L}\\p{N}'])`, "iu").test(text);
};

/** the model's JSON, checked by code; null when it cannot be used. Wrong cues or names are dropped, not fatal. */
export function validateAudit(text: string, item: { gapped: string; solution: string; distractors: readonly string[] }): ClozeAuditResult | null {
  let v: Partial<ClozeAuditResult>;
  try {
    v = JSON.parse(text) as Partial<ClozeAuditResult>;
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || !VERDICTS.includes(v.verdict as (typeof VERDICTS)[number])) return null;
  if (typeof v.reason_ru !== "string" || !CYRILLIC.test(v.reason_ru) || v.reason_ru.length > 240) return null;
  if (!Array.isArray(v.other_correct) || !Array.isArray(v.cues) || !Array.isArray(v.names)) return null;
  const distractors = new Map(item.distractors.map((d) => [norm(d), d]));
  const other = [...new Set(v.other_correct.map((o) => distractors.get(norm(String(o)))).filter((o): o is string => o !== undefined))];
  // a "key_ok" that names another fitting option contradicts itself: the conservative reading wins
  const verdict = v.verdict === "key_ok" && other.length > 0 ? "several_correct" : v.verdict!;
  const options = new Set([item.solution, ...item.distractors].map(norm));
  const keep = (list: unknown[], max: number): string[] =>
    [...new Set(list.map((x) => String(x).trim()).filter((x) => x.length > 0 && x.length <= 40 && !options.has(norm(x)) && occurs(item.gapped, x)))].slice(0, max);
  return { verdict, other_correct: other, reason_ru: v.reason_ru.trim(), cues: keep(v.cues, 3), names: keep(v.names, 6) };
}

// ---------------------------------------------------------------------------------------------------------------- control

const openJob = (db: Db): { id: string; state: string } | undefined =>
  db.prepare(`SELECT id, state FROM jobs WHERE kind = 'tutor' AND json_extract(payload_json, '$.grammarClozeAudit') = 1 AND state IN ${OPEN_STATES} ORDER BY created_at DESC, rowid DESC LIMIT 1`).get() as
    | { id: string; state: string }
    | undefined;

const enabledOf = (db: Db): boolean => ((db.prepare("SELECT enabled FROM grammar_cloze_audit_control WHERE id = 1").get() as { enabled: number } | undefined)?.enabled ?? 0) === 1;

/** the sentences still to check, in the order they are wanted: the open session first, then mistakes, then unanswered ones spread over the bank */
function pendingSql(limit: boolean): string {
  return `SELECT i.id AS itemId, i.current_revision_id AS rev, r.gapped_text AS gapped, r.solution, r.distractors_json AS d, r.skill_id AS skill
            FROM grammar_cloze_items i JOIN grammar_cloze_revisions r ON r.id = i.current_revision_id
           WHERE i.source_id = @src AND i.status = 'validated'
             AND NOT EXISTS (SELECT 1 FROM grammar_cloze_exclusions e WHERE e.item_id = i.id)
             AND NOT EXISTS (SELECT 1 FROM grammar_cloze_ai_analyses x WHERE x.revision_id = i.current_revision_id AND x.prompt_version = '${AUDIT_PROMPT}' AND x.status <> 'failed')
             AND (SELECT COUNT(*) FROM grammar_cloze_ai_analyses x WHERE x.revision_id = i.current_revision_id AND x.prompt_version = '${AUDIT_PROMPT}' AND x.status = 'failed') < ${MAX_FAILED}
             AND NOT EXISTS (SELECT 1 FROM grammar_cloze_ai_analyses x WHERE x.revision_id = i.current_revision_id AND x.prompt_version = '${AUDIT_PROMPT}' AND x.status = 'failed' AND x.created_at > @cutoff)
             ${
               limit
                 ? `ORDER BY CASE
                      WHEN EXISTS (SELECT 1 FROM grammar_cloze_session_items s JOIN grammar_cloze_sessions ss ON ss.id = s.session_id AND ss.status = 'active' WHERE s.item_id = i.id) THEN 0
                      WHEN EXISTS (SELECT 1 FROM grammar_cloze_attempts a WHERE a.item_id = i.id AND a.is_correct = 0) THEN 1
                      WHEN NOT EXISTS (SELECT 1 FROM grammar_cloze_attempts a WHERE a.item_id = i.id) THEN 2
                      ELSE 3 END,
                    (i.source_index * 2654435761) % 1000003
                  LIMIT @n`
                 : ""
             }`;
}

export function remainingCount(db: Db): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM (${pendingSql(false)})`).get({ src: ACTIVE_SOURCE, cutoff: cutoff() }) as { n: number }).n;
}

/** queues the next chunk when the check is on, nothing is queued yet and sentences are left. Must run inside the caller's transaction. */
export function ensureAuditJob(db: Db, deps: Deps, o: { fromPoll?: boolean } = {}): boolean {
  if (!enabledOf(db) || openJob(db)) return false;
  if (o.fromPoll) {
    const last = db.prepare(`SELECT state, finished_at AS at FROM jobs WHERE kind = 'tutor' AND json_extract(payload_json, '$.grammarClozeAudit') = 1 ORDER BY created_at DESC, rowid DESC LIMIT 1`).get() as { state: string; at: string | null } | undefined;
    if (last?.state === "failed" && last.at && deps.now().getTime() - Date.parse(last.at) < 15 * 60 * 1000) return false;
  }
  if (!db.prepare(`${pendingSql(true)}`).get({ src: ACTIVE_SOURCE, n: 1, cutoff: cutoff() })) return false;
  enqueue(db, deps, { kind: "tutor", priority: 3, payload: { grammarClozeAudit: 1 }, idempotencyKey: `grammar-cloze-audit:${deps.newId()}` });
  return true;
}

/** Start/Pause from Content Studio. Pause stops the running chunk at a safe point (its finished sentences are kept). */
export function setAuditEnabled(db: Db, deps: Deps, enabled: boolean): ClozeAuditOverview {
  db.transaction(() => {
    db.prepare("UPDATE grammar_cloze_audit_control SET enabled = ?, updated_at = ? WHERE id = 1").run(enabled ? 1 : 0, deps.now().toISOString());
    const job = openJob(db);
    if (enabled) {
      if (job?.state === "paused") applyAction(db, deps, job.id, "resume");
      else ensureAuditJob(db, deps);
    } else if (job && job.state !== "paused") {
      applyAction(db, deps, job.id, "pause");
    }
  }).immediate();
  return auditOverview(db);
}

export function auditOverview(db: Db): ClozeAuditOverview {
  const job = openJob(db);
  const reason = job ? ((db.prepare("SELECT reason FROM job_events WHERE job_id = ? ORDER BY sequence DESC LIMIT 1").get(job.id) as { reason: string } | undefined)?.reason ?? null) : null;
  // the same pool as Stage 1 before hiding: validated sentences, without those excluded before they were answered
  const base = `FROM grammar_cloze_items i WHERE i.source_id = @src AND i.status = 'validated' AND (NOT EXISTS (SELECT 1 FROM grammar_cloze_exclusions e WHERE e.item_id = i.id) OR EXISTS (SELECT 1 FROM grammar_cloze_attempts a WHERE a.item_id = i.id AND a.stage = 1))`;
  const total = (db.prepare(`SELECT COUNT(*) AS n ${base}`).get({ src: ACTIVE_SOURCE }) as { n: number }).n;
  const verdicts = db
    .prepare(
      `SELECT json_extract(x.result_json, '$.audit.verdict') AS v, COUNT(*) AS n ${base.replace("FROM grammar_cloze_items i", "FROM grammar_cloze_items i JOIN grammar_cloze_ai_analyses x ON x.revision_id = i.current_revision_id AND x.prompt_version = '" + AUDIT_PROMPT + "' AND x.status = 'done'")} GROUP BY v`,
    )
    .all({ src: ACTIVE_SOURCE }) as Array<{ v: string; n: number }>;
  const byVerdict: Record<string, number> = {};
  for (const r of verdicts) byVerdict[r.v] = r.n;
  const checked = verdicts.reduce((a, r) => a + r.n, 0);
  const failed = (db.prepare(`SELECT COUNT(DISTINCT x.revision_id) AS n FROM grammar_cloze_ai_analyses x WHERE x.prompt_version = ? AND x.status = 'failed' AND NOT EXISTS (SELECT 1 FROM grammar_cloze_ai_analyses y WHERE y.revision_id = x.revision_id AND y.prompt_version = x.prompt_version AND y.status = 'done')`).get(AUDIT_PROMPT) as { n: number }).n;
  const hidden = (db.prepare(`SELECT COUNT(*) AS n ${base} AND ${hiddenSql("i")}`).get({ src: ACTIVE_SOURCE }) as { n: number }).n;
  const hiddenAnswered = (db.prepare(`SELECT COUNT(*) AS n ${base} AND ${hiddenSql("i")} AND EXISTS (SELECT 1 FROM grammar_cloze_attempts a WHERE a.item_id = i.id AND a.stage = 1)`).get({ src: ACTIVE_SOURCE }) as { n: number }).n;
  const restored = (
    db
      .prepare(
        `SELECT COUNT(*) AS n ${base} AND (SELECT o.action FROM grammar_cloze_audit_overrides o WHERE o.item_id = i.id AND o.revision_id = i.current_revision_id ORDER BY o.created_at DESC, o.rowid DESC LIMIT 1) = 'restore'`,
      )
      .get({ src: ACTIVE_SOURCE }) as { n: number }
  ).n;
  return { enabled: enabledOf(db), job: job ? { state: job.state, reason } : null, total, checked, ok: byVerdict.key_ok ?? 0, hidden, hiddenAnswered, byVerdict, failed, restored, remaining: remainingCount(db) };
}

/** sentences with a doubtful check (or a decision by hand), newest first */
export function auditRows(db: Db, o: { limit: number; offset: number }): ClozeAuditRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT i.id AS itemId, r.gapped_text AS gapped, r.solution, r.distractors_json AS d,
                (SELECT x.result_json FROM grammar_cloze_ai_analyses x WHERE x.revision_id = i.current_revision_id AND x.status = 'done'
                  ORDER BY COALESCE(json_extract(x.result_json, '$.audit.verdict'), json_extract(x.result_json, '$.analysis.verdict')) = 'key_ok', x.finished_at DESC LIMIT 1) AS res,
                COALESCE((SELECT MAX(x.finished_at) FROM grammar_cloze_ai_analyses x WHERE x.revision_id = i.current_revision_id AND x.status = 'done'),
                         (SELECT MAX(o.created_at) FROM grammar_cloze_audit_overrides o WHERE o.item_id = i.id)) AS at,
                (SELECT o.action FROM grammar_cloze_audit_overrides o WHERE o.item_id = i.id AND o.revision_id = i.current_revision_id ORDER BY o.created_at DESC, o.rowid DESC LIMIT 1) AS ov,
                ${hiddenSql("i")} AS hidden
           FROM grammar_cloze_items i JOIN grammar_cloze_revisions r ON r.id = i.current_revision_id
          WHERE i.source_id = @src AND i.status = 'validated')
        WHERE hidden = 1 OR ov IS NOT NULL
        ORDER BY at DESC, itemId LIMIT @limit OFFSET @offset`,
    )
    .all({ src: ACTIVE_SOURCE, limit: o.limit, offset: o.offset }) as Array<{ itemId: string; gapped: string; solution: string; d: string; res: string | null; at: string; ov: "restore" | "hide" | null; hidden: number }>;
  return rows.map((r) => {
    const options = [r.solution, ...(JSON.parse(r.d) as string[])];
    const res = r.res ? (JSON.parse(r.res) as { audit?: ClozeAuditResult; analysis?: ClozeAnalysisResult }) : null;
    const opinion = res?.audit
      ? { verdict: res.audit.verdict, otherCorrect: res.audit.other_correct, reasonRu: res.audit.reason_ru }
      : res?.analysis
        ? {
            verdict: res.analysis.verdict,
            otherCorrect: res.analysis.options.filter((x) => x.fits === "yes" && x.text.toLowerCase() !== r.solution.toLowerCase()).map((x) => x.text),
            reasonRu: res.analysis.caution_ru || res.analysis.rule_en,
          }
        : { verdict: "by_hand", otherCorrect: [], reasonRu: "" };
    return { itemId: r.itemId, gappedText: r.gapped, solution: r.solution, options, ...opinion, override: r.ov, hidden: r.hidden === 1, checkedAt: r.at };
  });
}

/** the learner restores a hidden sentence (or hides one by hand); the model's opinion stays as it was */
export function setOverride(db: Db, deps: Deps, itemId: string, action: "restore" | "hide"): { hidden: boolean } {
  return db
    .transaction(() => {
      const item = db.prepare("SELECT current_revision_id AS rev FROM grammar_cloze_items WHERE id = ?").get(itemId) as { rev: string } | undefined;
      if (!item) throw new ApiError(404, "CLOZE_ITEM_NOT_FOUND", "Unknown sentence");
      db.prepare("INSERT INTO grammar_cloze_audit_overrides(id, item_id, revision_id, action, created_at) VALUES (?,?,?,?,?)").run(deps.newId(), itemId, item.rev, action, deps.now().toISOString());
      return { hidden: (db.prepare(`SELECT ${hiddenSql("i")} AS h FROM grammar_cloze_items i WHERE i.id = ?`).get(itemId) as { h: number }).h === 1 };
    })
    .immediate();
}

/** the finished check of a revision (cues, names, reason) for the practice screen */
export function auditOf(db: Db, revisionId: string): ClozeAuditResult | null {
  const row = db.prepare(`SELECT result_json AS r FROM grammar_cloze_ai_analyses WHERE revision_id = ? AND prompt_version = ? AND status = 'done'`).get(revisionId, AUDIT_PROMPT) as { r: string } | undefined;
  return row ? (JSON.parse(row.r) as { audit: ClozeAuditResult }).audit : null;
}

// ---------------------------------------------------------------------------------------------------------------- runner

interface Target {
  itemId: string;
  rev: string;
  gapped: string;
  solution: string;
  d: string;
  skill: string | null;
}
interface Checkpoint {
  targets?: Target[];
  results?: Array<{ rev: string; result: ClozeAuditResult | null }>;
}

/**
 * One background chunk (the tutor runner hands it here, under the same GPU lease, model pin and cancellation). Progress is checkpointed after
 * every sentence, so a pause or a practice preemption loses at most one model call. The chunk ends early when a foreground model job waits,
 * and the next chunk is queued with the results while the check is on.
 */
export async function runGrammarClozeAudit(db: Db, chat: ChatClient, ctx: RunnerContext<AuditPayload>, modelVersionId: string | null): Promise<RunnerOutput> {
  ensurePromptVersion(db, AUDIT_PROMPT, JSON.stringify(AUDIT_FORMAT));
  const prior = (ctx.job.checkpoint ?? {}) as Checkpoint;
  const targets = prior.targets ?? (db.prepare(pendingSql(true)).all({ src: ACTIVE_SOURCE, n: AUDIT_CHUNK, cutoff: cutoff() }) as Target[]);
  const results = [...(prior.results ?? [])];
  const done = new Set(results.map((r) => r.rev));
  ctx.checkpoint({ targets, results, done: results.length, total: targets.length });
  let calls = 0;
  let lastFailed = false;
  for (const t of targets) {
    if (done.has(t.rev)) continue;
    // switched off while the job waited (e.g. paused by practice): keep what is done, ask nothing more
    if (!enabledOf(db)) break;
    // a foreground model request (tutor, analysis, checks) is waiting: give the GPU back after the sentences already done
    if (calls > 0 && db.prepare("SELECT 1 FROM jobs WHERE state IN ('queued','waiting_for_gpu') AND priority < 3 AND cancel_requested = 0 LIMIT 1").get()) break;
    const distractors = JSON.parse(t.d) as string[];
    const card = t.skill ? skillCard(t.skill) : undefined;
    const user = JSON.stringify({ sentence_with_gap: t.gapped, answer_key: t.solution, other_options: distractors, ...(card ? { rule_card: { name: card.displayName, rule: card.rule } } : {}) });
    let r: { text: string };
    try {
      r = await chat.chat({
      model: AI_CONFIG_V3.analysis.tag,
      messages: [
        { role: "system", content: GRAMMAR_CLOZE_AUDIT_V1 },
        { role: "user", content: user },
      ],
      format: AUDIT_FORMAT,
      options: { num_ctx: RESIDENT_NUM_CTX, num_predict: 400, temperature: 0 },
      signal: ctx.signal,
      });
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      if (lastFailed) throw new RunnerError("model_unavailable", "The local model failed twice in a row", true);
      // this sentence breaks the call: record it as unreadable (retried after RETRY_AFTER_MS), so the chain never loops on it
      lastFailed = true;
      calls++;
      results.push({ rev: t.rev, result: null });
      done.add(t.rev);
      ctx.checkpoint({ targets, results, done: results.length, total: targets.length });
      continue;
    }
    lastFailed = false;
    calls++;
    results.push({ rev: t.rev, result: r.text.trim() ? validateAudit(r.text, { gapped: t.gapped, solution: t.solution, distractors }) : null });
    done.add(t.rev);
    ctx.checkpoint({ targets, results, done: results.length, total: targets.length });
  }
  if (calls === 0 && results.length === 0 && targets.length > 0 && enabledOf(db)) throw new RunnerError("audit_no_progress", "No sentence was checked", true);
  const tag = AI_CONFIG_V3.analysis.tag;
  return {
    schemaVersion: "grammar-cloze-audit-v1",
    output: { checked: results.length, ok: results.filter((r) => r.result?.verdict === "key_ok").length, failed: results.filter((r) => !r.result).length },
    metrics: { calls },
    alsoCommit: (tx) => {
      const at = new Date().toISOString();
      const ins = tx.prepare(
        "INSERT OR IGNORE INTO grammar_cloze_ai_analyses(id, revision_id, prompt_version, status, result_json, model_version_id, error_code, created_at, finished_at) VALUES (?,?,?,?,?,?,?,?,?)",
      );
      for (const r of results) {
        if (r.result) ins.run(randomUUID(), r.rev, AUDIT_PROMPT, "done", JSON.stringify({ audit: r.result, model: tag }), modelVersionId, null, at, at);
        else ins.run(randomUUID(), r.rev, AUDIT_PROMPT, "failed", null, modelVersionId, "invalid_output", at, at);
      }
      // the next chunk; this job is still open while its result commits, so the open-job guard is skipped here on purpose
      if (enabledOf(tx) && tx.prepare(pendingSql(true)).get({ src: ACTIVE_SOURCE, n: 1, cutoff: cutoff() }))
        enqueue(tx, { now: () => new Date(), newId: randomUUID }, { kind: "tutor", priority: 3, payload: { grammarClozeAudit: 1 }, idempotencyKey: `grammar-cloze-audit:${randomUUID()}` });
    },
  };
}
