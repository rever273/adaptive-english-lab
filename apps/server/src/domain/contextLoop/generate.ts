import { createHash } from "node:crypto";
import { CONTEXT_LOOP_PER_WORD, CONTEXT_LOOP_WORDS, difficultyLevels, type ContextLoopBatchView, type ContextLoopStudioStatus } from "@english-lab/contracts";
import type { Db } from "../../db/open.js";
import { ApiError } from "../../errors.js";
import { enqueue } from "../../queue/jobs.js";
import { loadSettings } from "../sessions/policy.js";
import { wordEvents } from "../vocabulary/practice.js";
import { getEntry } from "../vocabulary/repository.js";
import { senseOf } from "../wordLessons/generate.js";
import type { SenseSnapshot } from "../wordLessons/runner.js";
import { eligibleWords, rankCandidates } from "../wordLessons/selection.js";
import { CONTEXT_LOOP_AGENT_PROMPT, CONTEXT_LOOP_PROMPT, type TargetInput } from "./prompts.js";
import { CURRENT_STATUS, coverage, insertSentence, loadSentences, type Deps } from "./sentences.js";
import { checkAndAccept, ContextLedger, targetOf, type WordTarget } from "./validate.js";

/** words per model call: about 15 sentences of JSON per call stay well inside a 12B model's answer (3 x 5, 2 x 8, 1 x 15) */
export const chunkWords = (perWord: number): number => (perWord <= 5 ? 3 : perWord <= 8 ? 2 : 1);
const OPEN_BATCH = "status IN ('generating','awaiting_agent')";
const OPEN_JOB = "j.kind = 'generation' AND j.state IN ('queued','waiting_for_gpu','running','paused')";

/** one word of a batch as frozen at creation: the writer gets exactly this, and the finished sentences are checked against it */
export interface BatchWord {
  targetId: string;
  entryId: string;
  lemma: string;
  sense: SenseSnapshot;
  collocations: string[];
  avoidSentences: string[];
}

export interface ContextLoopPayload {
  contextLoopBatchId: string;
  chunk: number;
  attempt: number;
}

export interface BatchRow {
  id: string;
  author: "model" | "agent";
  status: ContextLoopBatchView["status"];
  perWord: number;
  words: BatchWord[];
  promptVersion: string;
  receipt: (ContextLoopBatchView["receipt"] & { requestHash?: string; reviewer?: string }) | null;
}

export function loadBatch(db: Db, id: string): BatchRow {
  const r = db.prepare("SELECT id, author, status, per_word AS perWord, words_json AS w, prompt_version AS promptVersion, receipt_json AS rc FROM context_loop_batches WHERE id = ?").get(id) as (Omit<BatchRow, "words" | "receipt"> & { w: string; rc: string | null }) | undefined;
  if (!r) throw new ApiError(404, "CONTEXT_BATCH_NOT_FOUND", "Unknown Context Loop batch");
  return { id: r.id, author: r.author, status: r.status, perWord: r.perWord, promptVersion: r.promptVersion, words: JSON.parse(r.w) as BatchWord[], receipt: r.rc ? JSON.parse(r.rc) : null };
}

export const targetOfBatchWord = (w: BatchWord): WordTarget => targetOf(w.entryId, w.lemma, w.sense, w.collocations);

export function targetInput(w: BatchWord): TargetInput {
  return {
    target_id: w.targetId,
    word: w.lemma,
    part_of_speech: w.sense.pos,
    meaning_ru: w.sense.translationRu,
    definition_ru: w.sense.definitionRu,
    usage_note: w.collocations.join(", "),
    avoid_words: w.sense.synonyms,
    avoid_sentences: w.avoidSentences,
  };
}

export const levelOf = (db: Db): { min: string; max: string } => {
  const lv = difficultyLevels(loadSettings(db).values);
  return { min: lv?.[0] ?? "B1", max: lv?.[lv.length - 1] ?? "C1" };
};

/** words in an open batch are being written: no second batch takes them */
function wordsInWork(db: Db): Set<string> {
  const out = new Set<string>();
  for (const r of db.prepare(`SELECT words_json AS w FROM context_loop_batches WHERE ${OPEN_BATCH}`).all() as Array<{ w: string }>) for (const w of JSON.parse(r.w) as BatchWord[]) out.add(w.entryId);
  return out;
}

/** §4.2: words not marked learned with fewer usable sentences than asked; no sentences first, then the worst known (the Vocabulary Practice history, read only) */
export function candidates(db: Db, perWord: number, now: Date) {
  const cov = coverage(db);
  const busy = wordsInWork(db);
  const words = eligibleWords(db).eligible.filter((w) => !w.learned && !busy.has(w.entryId) && (cov.byEntry.get(w.entryId) ?? 0) < perWord);
  const ranked = rankCandidates(words, wordEvents(db), now);
  const order = new Map(ranked.map((w, i) => [w.entryId, i]));
  return ranked.sort((a, b) => Math.min(1, cov.byEntry.get(a.entryId) ?? 0) - Math.min(1, cov.byEntry.get(b.entryId) ?? 0) || order.get(a.entryId)! - order.get(b.entryId)!);
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(n)));

function createBatch(db: Db, deps: Deps, author: "model" | "agent", input: { words: number; perWord: number }): { batch: BatchRow; created: number } {
  const perWord = clamp(input.perWord, CONTEXT_LOOP_PER_WORD.min, CONTEXT_LOOP_PER_WORD.max);
  const n = clamp(input.words, CONTEXT_LOOP_WORDS.min, CONTEXT_LOOP_WORDS.max);
  return db
    .transaction(() => {
      const chosen = candidates(db, perWord, deps.now()).slice(0, n);
      if (chosen.length === 0) throw new ApiError(409, "NO_WORDS_TO_PREPARE", "Every word not marked learned already has enough sentences, is being prepared, or waits for a translation.");
      const words: BatchWord[] = chosen.map((w, i) => ({
        targetId: `t${i + 1}`,
        entryId: w.entryId,
        lemma: w.lemma,
        sense: senseOf(db, w),
        collocations: getEntry(db, w.entryId).collocations.items,
        avoidSentences: loadSentences(db, { entryId: w.entryId }).map((s) => s.text).slice(-12),
      }));
      const id = deps.newId();
      db.prepare("INSERT INTO context_loop_batches(id, author, requested_words, per_word, status, words_json, prompt_version, created_at) VALUES (?,?,?,?,?,?,?,?)").run(
        id,
        author,
        n,
        perWord,
        author === "model" ? "generating" : "awaiting_agent",
        JSON.stringify(words),
        author === "model" ? CONTEXT_LOOP_PROMPT : CONTEXT_LOOP_AGENT_PROMPT,
        deps.now().toISOString(),
      );
      if (author === "model") {
        for (let c = 0; c * chunkWords(perWord) < words.length; c++) {
          const payload: ContextLoopPayload = { contextLoopBatchId: id, chunk: c, attempt: 1 };
          enqueue(db, deps, { kind: "generation", priority: 3, payload, idempotencyKey: `context-loop:${id}:${c}:1` });
        }
      }
      return { batch: loadBatch(db, id), created: words.length };
    })
    .immediate();
}

export const startGeneration = (db: Db, deps: Deps, input: { words: number; perWord: number }) => createBatch(db, deps, "model", input);

/** D161: a batch the coding agent writes; no job, no model. The prompt is self-contained (copied by the learner to their agent). */
export function startAgentBatch(db: Db, deps: Deps, input: { words: number; perWord: number }): { batchId: string; prompt: string; created: number } {
  const { batch, created } = createBatch(db, deps, "agent", input);
  return { batchId: batch.id, created, prompt: agentPrompt(batch.id, created, batch.perWord) };
}

export function agentPrompt(id: string, words: number, perWord: number): string {
  return `Write Context Loop sentences for batch ${id} (${words} words x ${perWord} sentences) yourself; no local model is used. Read content/agent-workflows/context-loop.md and common.md, then run npm run content:loop -- prepare ${id} and read author-packet.json in the reported work directory. Write drafts.json, run npm run content:loop -- author ${id} and fix every PROBLEM until none remain. Then run check, have the content-reviewer agent review every final candidate (it must not be you), apply its fixes and re-review only changed sentences, then run finalize. Do not ask me to copy JSON or run commands. Preserve dictionary edits and attempt history. Reply briefly with accepted, corrected and rejected counts, then the reviewer's tokens exactly and your own as an estimate.`;
}

export function cancelAgentBatch(db: Db, deps: Deps, id: string): void {
  db.transaction(() => {
    const b = loadBatch(db, id);
    if (b.author !== "agent" || b.status !== "awaiting_agent") throw new ApiError(409, "CONTEXT_BATCH_NOT_OPEN", "Only an agent batch that waits for the agent can be cancelled");
    db.prepare("UPDATE context_loop_batches SET status = 'failed', error_code = 'cancelled', finished_at = ? WHERE id = ?").run(deps.now().toISOString(), id);
  }).immediate();
}

/** a model batch is finished once none of its jobs is open: done when it wrote a sentence, failed otherwise (with the last job error) */
export function settleBatches(db: Db, deps: Deps): void {
  const open = db.prepare("SELECT id FROM context_loop_batches WHERE status = 'generating'").all() as Array<{ id: string }>;
  for (const { id } of open) {
    const running = db.prepare(`SELECT 1 FROM jobs j WHERE ${OPEN_JOB} AND json_extract(j.payload_json, '$.contextLoopBatchId') = ? LIMIT 1`).get(id);
    if (running) continue;
    db.transaction(() => {
      const wrote = (db.prepare("SELECT COUNT(*) AS n FROM context_loop_sentences WHERE batch_id = ?").get(id) as { n: number }).n;
      const err = db.prepare("SELECT error_code AS c FROM jobs j WHERE j.kind = 'generation' AND json_extract(j.payload_json, '$.contextLoopBatchId') = ? AND error_code IS NOT NULL ORDER BY COALESCE(j.finished_at, j.created_at) DESC LIMIT 1").get(id) as { c: string } | undefined;
      db.prepare("UPDATE context_loop_batches SET status = ?, error_code = ?, finished_at = ? WHERE id = ? AND status = 'generating'").run(wrote > 0 ? "done" : "failed", wrote > 0 ? null : (err?.c ?? "no_sentences").slice(0, 60), deps.now().toISOString(), id);
    }).immediate();
  }
}

export function studioStatus(db: Db, deps: Deps): ContextLoopStudioStatus {
  settleBatches(db, deps);
  const cov = coverage(db);
  const rows = db
    .prepare("SELECT b.id, b.author, b.status, b.requested_words AS requested, b.per_word AS perWord, b.words_json AS w, b.error_code AS errorCode, b.receipt_json AS rc, b.created_at AS createdAt, (SELECT COUNT(*) FROM context_loop_sentences s WHERE s.batch_id = b.id) AS sentences FROM context_loop_batches b ORDER BY b.created_at DESC, b.rowid DESC LIMIT 8")
    .all() as Array<{ id: string; author: "model" | "agent"; status: ContextLoopBatchView["status"]; requested: number; perWord: number; w: string; errorCode: string | null; rc: string | null; createdAt: string; sentences: number }>;
  const flagged = (db.prepare(`SELECT COUNT(*) AS n FROM context_loop_sentences s WHERE ${CURRENT_STATUS} = 'flagged'`).get() as { n: number }).n;
  return {
    coverage: { ready: cov.ready, playable: cov.playable, missing: cov.missing, stale: cov.stale, eligible: cov.eligible },
    candidates: candidates(db, CONTEXT_LOOP_PER_WORD.default, deps.now()).length,
    generating: rows.filter((r) => r.status === "generating" || r.status === "awaiting_agent").length,
    flagged,
    batches: rows.map((r) => {
      const rc = r.rc ? (JSON.parse(r.rc) as { accepted: number; flagged: number; rejected: number }) : null;
      return { id: r.id, author: r.author, status: r.status, words: (JSON.parse(r.w) as unknown[]).length, perWord: r.perWord, errorCode: r.errorCode, receipt: rc ? { accepted: rc.accepted, flagged: rc.flagged, rejected: rc.rejected } : null, sentences: r.sentences, createdAt: r.createdAt };
    }),
    defaults: { words: CONTEXT_LOOP_WORDS.default, perWord: CONTEXT_LOOP_PER_WORD.default },
    limits: { words: { min: CONTEXT_LOOP_WORDS.min, max: CONTEXT_LOOP_WORDS.max }, perWord: { min: CONTEXT_LOOP_PER_WORD.min, max: CONTEXT_LOOP_PER_WORD.max } },
  };
}

// ---------------------------------------------------------------- agent batches (D161)

export interface AgentCandidate {
  target_id: string;
  text: string;
  target_surface: string;
  context_label: string;
  difficulty: string;
  /** agent v2: the Russian translation, reviewed with the sentence (part of the hash) */
  translation_ru?: string;
  hash: string;
}
export interface AgentReview {
  reviewer: string;
  items: Array<{ hash: string; verdict: "accept" | "flag" | "reject"; reason?: string }>;
}

/** the translation is part of what the reviewer approves; a candidate without one keeps the v1 hash */
export const candidateHash = (c: { target_id: string; text: string; target_surface: string; translation_ru?: string | null }): string =>
  createHash("sha256").update(`${c.target_id}|${c.text}|${c.target_surface}${c.translation_ru ? `|${c.translation_ru}` : ""}`).digest("hex");
const AGENT_ID = /^agent:[A-Za-z0-9._-]{1,60}@[A-Za-z0-9._-]{1,30}$/;

/**
 * Finalise an agent batch in ONE transaction (§4.9): the reviewer is not the author, every candidate passes the code checks again (the script is never
 * trusted) and has a verdict on its exact hash. accept -> `approved`, flag -> `flagged`, reject -> not stored. A refusal writes nothing; the same request
 * again returns the earlier receipt.
 */
export function completeAgentBatch(db: Db, deps: Deps, id: string, body: { author: string; candidates: AgentCandidate[]; review: AgentReview }) {
  const requestHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return db
    .transaction(() => {
      const b = loadBatch(db, id);
      if (b.author !== "agent") throw new ApiError(409, "CONTEXT_BATCH_NOT_AGENT", "This batch is written by the local model");
      if (b.status === "done" && b.receipt?.requestHash === requestHash) return b.receipt;
      if (b.status !== "awaiting_agent") throw new ApiError(409, "CONTEXT_BATCH_NOT_OPEN", "This batch is already finished or cancelled");
      if (!AGENT_ID.test(body.author) || !AGENT_ID.test(body.review.reviewer)) throw new ApiError(400, "AGENT_ID_INVALID", "author and reviewer must look like agent:<identity>@<version>");
      if (body.author === body.review.reviewer) throw new ApiError(409, "REVIEWER_IS_AUTHOR", "The reviewer must be a different agent from the author");
      const byTarget = new Map(b.words.map((w) => [w.targetId, w]));
      const verdicts = new Map(body.review.items.map((v) => [v.hash, v]));
      const ledger = new ContextLedger(db);
      const problems: string[] = [];
      const accepted: Array<{ w: BatchWord; c: AgentCandidate; checked: NonNullable<ReturnType<typeof checkAndAccept> & { ok: true }>["sentence"]; verdict: AgentReview["items"][number] }> = [];
      for (const c of body.candidates) {
        const w = byTarget.get(c.target_id);
        if (!w) { problems.push(`${c.target_id}: unknown target`); continue; }
        if (candidateHash(c) !== c.hash) { problems.push(`${c.target_id}: the hash does not match the sentence`); continue; }
        const v = verdicts.get(c.hash);
        if (!v || !["accept", "flag", "reject"].includes(v.verdict)) { problems.push(`${c.target_id}: no review verdict for "${c.text}"`); continue; }
        if (v.verdict === "reject") continue;
        // a batch opened under agent v2 asks for the translation: the server requires it too (the script is never trusted); older batches may lack it
        if (b.promptVersion === CONTEXT_LOOP_AGENT_PROMPT && !c.translation_ru?.trim()) { problems.push(`${c.target_id}: translation_ru is missing for "${c.text}"`); continue; }
        const r = checkAndAccept(c, targetOfBatchWord(w), ledger);
        if (!r.ok) { problems.push(`${c.target_id}: ${r.message}`); continue; }
        accepted.push({ w, c, checked: r.sentence, verdict: v });
      }
      if (problems.length > 0) throw new ApiError(409, "REVIEW_INCOMPLETE", "The batch cannot be finalised", { problems: problems.slice(0, 40) });
      let ok = 0;
      let flagged = 0;
      for (const a of accepted) {
        const sid = insertSentence(db, deps, {
          target: targetOfBatchWord(a.w),
          checked: a.checked,
          source: "agent",
          authorId: body.author,
          batchId: id,
          promptVersion: b.promptVersion,
          review: { reviewer: body.review.reviewer, verdict: a.verdict.verdict, reason: a.verdict.reason ?? null, hash: a.c.hash },
          status: a.verdict.verdict === "accept" ? "approved" : "flagged",
          actor: "agent",
          reason: a.verdict.verdict === "flag" ? (a.verdict.reason ?? "flagged by the reviewer").slice(0, 300) : null,
        });
        if (sid && a.verdict.verdict === "accept") ok++;
        else if (sid) flagged++;
      }
      const receipt = { accepted: ok, flagged, rejected: body.candidates.length - ok - flagged, words: new Set(accepted.map((a) => a.w.entryId)).size, reviewer: body.review.reviewer, requestHash };
      db.prepare("UPDATE context_loop_batches SET status = 'done', receipt_json = ?, finished_at = ? WHERE id = ?").run(JSON.stringify(receipt), deps.now().toISOString(), id);
      return receipt;
    })
    .immediate();
}
