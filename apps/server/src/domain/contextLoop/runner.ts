import type { Db } from "../../db/open.js";
import { RunnerError, type RunnerContext, type RunnerOutput } from "../../queue/types.js";
import type { ChatClient } from "../ai/clients.js";
import { ensurePromptVersion } from "../ai/prompts.js";
import { runStructured } from "../ai/structured.js";
import { bad, ok, parseObject, str } from "../wordLessons/validate.js";
import { chunkWords, levelOf, loadBatch, targetInput, targetOfBatchWord, type BatchWord, type ContextLoopPayload } from "./generate.js";
import { CONTEXT_LOOP_PROMPT, CONTEXT_LOOP_REVIEW_PROMPT, CONTEXT_LOOP_REVIEW_SYSTEM_V2, CONTEXT_LOOP_SYSTEM_V1, generationFormat, generationSchemaText, generationUser, reviewFormat, reviewSchemaText } from "./prompts.js";
import { insertSentence } from "./sentences.js";
import { checkAndAccept, ContextLedger, type CheckedSentence } from "./validate.js";

export interface ContextLoopRunnerDeps {
  db: Db;
  chat: ChatClient;
  model: { tag: string; digest: string };
  params: { numCtx: number; temperature: number; seed: number };
  deps: { now: () => Date; newId: () => string };
  assertModel: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

/** one first call and at most this many more for the words that still lack sentences */
export const EXTRA_CALLS = 2;

type RawItems = Array<{ target_id: string; sentences: Array<Record<string, unknown>> }>;

/** the shape only; every sentence is judged by the code checks afterwards (an unknown id or a bad sentence is dropped, never a reason to fail the call) */
export function generationValidate(text: string) {
  const o = parseObject(text);
  if (!o || !Array.isArray(o.items)) return bad<RawItems>("SHAPE", 'expected {"items":[...]}');
  const items: RawItems = [];
  for (const it of o.items as Array<Record<string, unknown>>) {
    if (!it || typeof it !== "object" || !Array.isArray(it.sentences)) continue;
    items.push({ target_id: str(it.target_id), sentences: (it.sentences as unknown[]).filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null) });
  }
  return ok(items);
}

/** verdicts by sentence id; a missing verdict is decided by the caller (flagged) */
export function reviewValidate(text: string, ids: ReadonlySet<string>) {
  const o = parseObject(text);
  if (!o || !Array.isArray(o.verdicts)) return bad<Map<string, { ok: boolean; problem: string }>>("SHAPE", 'expected {"verdicts":[...]}');
  const out = new Map<string, { ok: boolean; problem: string }>();
  for (const v of o.verdicts as Array<Record<string, unknown>>) {
    const id = str(v?.id);
    if (!ids.has(id) || typeof v.ok !== "boolean") continue;
    out.set(id, { ok: v.ok, problem: str(v.problem).slice(0, 300) });
  }
  return ok(out);
}

/**
 * One chunk of a model batch (§4.3): write, check by code, ask again for missing sentences, one review call, then store in the job's own transaction.
 * Passed the review -> `validated`; a remark or a missing verdict -> `flagged`. Nothing is `approved` here.
 */
export async function runContextLoopJob(ctx: RunnerContext<ContextLoopPayload>, o: ContextLoopRunnerDeps): Promise<RunnerOutput> {
  const { contextLoopBatchId: batchId, chunk } = ctx.job.payload;
  const { db } = o;
  const batch = loadBatch(db, batchId);
  const words = batch.words.slice(chunk * chunkWords(batch.perWord), (chunk + 1) * chunkWords(batch.perWord));
  if (batch.status !== "generating" || words.length === 0) return { schemaVersion: CONTEXT_LOOP_PROMPT, output: { batchId, chunk, skipped: "not_current" }, metrics: { calls: 0 } };
  await o.assertModel();
  ensurePromptVersion(db, CONTEXT_LOOP_PROMPT, generationSchemaText());
  ensurePromptVersion(db, CONTEXT_LOOP_REVIEW_PROMPT, reviewSchemaText());
  const level = levelOf(db);
  const ledger = new ContextLedger(db);
  const got = new Map<string, Array<{ w: BatchWord; s: CheckedSentence }>>(words.map((w) => [w.targetId, []]));
  const refused = new Map<string, string[]>(words.map((w) => [w.targetId, []]));
  let calls = 0;
  const seedBase = o.params.seed + ctx.job.retryCount * 101 + chunk * 17;
  const options = (seed: number, predict: number) => ({ num_ctx: o.params.numCtx, num_predict: predict, temperature: o.params.temperature, seed });

  for (let t = 0; t <= EXTRA_CALLS; t++) {
    const pending = words.filter((w) => got.get(w.targetId)!.length < batch.perWord);
    if (pending.length === 0) break;
    const need = Math.max(...pending.map((w) => batch.perWord - got.get(w.targetId)!.length));
    const targets = pending.map((w) => ({ ...targetInput(w), avoid_sentences: [...w.avoidSentences, ...got.get(w.targetId)!.map((x) => x.s.text), ...refused.get(w.targetId)!].slice(-16) }));
    const r = await runStructured({
      client: o.chat,
      model: o.model.tag,
      messages: [
        { role: "system", content: CONTEXT_LOOP_SYSTEM_V1 },
        { role: "user", content: generationUser(need, level, targets) },
      ],
      format: generationFormat(),
      options: options(seedBase + t * 7, 2800), // v3: the translations about double the answer
      validate: generationValidate,
      signal: ctx.signal,
      sleep: o.sleep,
    });
    calls += r.usage.calls;
    if (!r.ok) {
      if (r.code === "transport_failed") throw new RunnerError("transport_failed", r.issues.map((i) => `${i.code}: ${i.message}`).join("; ").slice(0, 300), true);
      continue; // unreadable answer: the next try asks again
    }
    for (const item of r.value) {
      const w = pending.find((x) => x.targetId === item.target_id);
      if (!w) continue; // an id we did not ask for
      for (const d of item.sentences) {
        if (got.get(w.targetId)!.length >= batch.perWord) break;
        const c = checkAndAccept(d as never, targetOfBatchWord(w), ledger);
        if (c.ok) got.get(w.targetId)!.push({ w, s: c.sentence });
        else if (typeof d.text === "string") refused.get(w.targetId)!.push(d.text.slice(0, 160));
      }
    }
    if (ctx.signal.aborted) throw new RunnerError("aborted", "stopped", true);
  }

  const all = [...got.values()].flat().map((x, i) => ({ ...x, id: `s${i + 1}` }));
  if (all.length === 0) throw new RunnerError("context_loop_empty", "no sentence passed the code checks", false, ["CONTEXT_LOOP_EMPTY"]);

  const review = await runStructured({
    client: o.chat,
    model: o.model.tag,
    messages: [
      { role: "system", content: CONTEXT_LOOP_REVIEW_SYSTEM_V2 },
      { role: "user", content: JSON.stringify({ items: all.map((x) => ({ id: x.id, word: x.w.lemma, part_of_speech: x.w.sense.pos, meaning_ru: x.w.sense.translationRu, sentence: x.s.text, translation_ru: x.s.translationRu ?? "" })) }) },
    ],
    format: reviewFormat(),
    options: options(seedBase + 900, 900),
    validate: (text) => reviewValidate(text, new Set(all.map((x) => x.id))),
    signal: ctx.signal,
    sleep: o.sleep,
  });
  calls += review.usage.calls;
  if (!review.ok && review.code === "transport_failed") throw new RunnerError("transport_failed", "review call failed", true);
  const verdicts = review.ok ? review.value : new Map<string, { ok: boolean; problem: string }>();
  const { deps } = o;
  return {
    schemaVersion: CONTEXT_LOOP_PROMPT,
    output: { batchId, chunk, written: all.length, validated: all.filter((x) => verdicts.get(x.id)?.ok === true).length },
    metrics: { calls },
    alsoCommit: (tx) => {
      for (const x of all) {
        const v = verdicts.get(x.id);
        const passed = v?.ok === true;
        insertSentence(tx, deps, {
          target: targetOfBatchWord(x.w),
          checked: x.s,
          source: "model",
          batchId,
          promptVersion: CONTEXT_LOOP_PROMPT,
          modelTag: o.model.tag,
          review: v ? { ok: v.ok, problem: v.problem } : { ok: null, problem: "no review verdict" },
          status: passed ? "validated" : "flagged",
          actor: "model",
          reason: passed ? null : (v?.problem || "the review gave no clear verdict").slice(0, 300),
        });
      }
    },
  };
}
