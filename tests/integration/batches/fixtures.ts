import { randomUUID } from "node:crypto";
import type { ReviewManifest } from "@english-lab/contracts";
import { REVIEW_CHECKLIST_KEYS } from "@english-lab/contracts";
import { TransportError, type CallStats, type ChatClient, type ChatResult } from "../../../apps/server/src/domain/ai/clients.js";
import { AI_CONFIG_V2 } from "../../../apps/server/src/domain/ai/config.js";
import { AdvisoryJobRunner } from "../../../apps/server/src/domain/content/batches/advisoryRunner.js";
import type { DecisionClient, DecisionResult } from "../../../apps/server/src/domain/ai/clients.js";
import { GenerationJobRunner } from "../../../apps/server/src/domain/content/batches/generationRunner.js";
import type { ItemPlan } from "../../../apps/server/src/domain/content/batches/plan.js";
import { getJob } from "../../../apps/server/src/queue/jobs.js";
import { GpuScheduler } from "../../../apps/server/src/queue/scheduler.js";
import { FakeClock, FakeGpu, flush } from "../../fixtures/queue/fakes.js";
import { makeEnv, rows, type Env } from "../attempts/fixtures.js";

const stats: CallStats = { totalMs: 10, loadMs: null, promptTokens: 5, evalTokens: 5, evalMs: 5 };

/** A distinct alphabetic tag per ordinal, so every generated sentence is globally unique (no accidental duplicates). */
export const tagFor = (n: number): string => `zeta${String.fromCharCode(97 + (n % 26))}${String.fromCharCode(97 + Math.floor(n / 26))}`;

const POOL = ["river","lantern","council","ferry","orchard","library","tram","harbour","bakery","museum","station","garden","market","bridge","theatre","clinic","school","stadium","airport","pharmacy","tunnel","lighthouse","vineyard","workshop","gallery","terminal","reservoir","observatory","depot","pavilion"];
const VERBS = ["reopened","was repaired","has expanded","will close","opened late","was renamed","has moved","needs funding","was inspected","changed hands"];
/** deterministic, mutually dissimilar sentences (large trigram distance) */
export function sentenceFor(n: number): string {
  const w = (k: number) => POOL[(n * 7 + k * 11 + Math.floor(n / 3) * k) % POOL.length]!;
  return `The ${w(1)} near the ${w(2)} ${VERBS[n % VERBS.length]} after the ${w(3)} and the ${w(4)} ${VERBS[(n * 3 + 1) % VERBS.length]} beside ${w(5)} number ${n}.`;
}

export interface UnitRequest {
  batch_id: string;
  format: string;
  count: number;
  items: Array<{ ordinal: number; target_skill: string; topic: string; sentence_must_be?: string }>;
}

const RU_OK = { hint_ru: "Подсказка: обратите внимание на форму слова.", explanation_ru: "Правильная форма определяется контекстом всего предложения." };

/** What a GOOD model sends for one requested item: a small flat draft of the right shape, with text that is unique per ordinal. */
export function goodDraft(format: string, item: UnitRequest["items"][number]): Record<string, unknown> {
  const n = item.ordinal;
  const tag = tagFor(n);
  switch (format) {
    case "choose_form":
      return { sentence: `${tag} council ___ the revised timetable yesterday.`, options: ["published", "has published", "publish"], correct_index: 0, ...RU_OK };
    case "choose_missing_fragment":
      return { sentence: `${tag} organiser asked us to listen ___ the safety announcement.`, options: ["to", "for", "at"], correct_index: 0, ...RU_OK };
    case "detect_error":
      return item.sentence_must_be?.startsWith("fully correct")
        ? { sentence: `${tag} Could you tell me where the nearest tram stop is?`, error_segment: "", correction: "", ...RU_OK }
        : { sentence: `${tag} He suggested to go to the beach after work.`, error_segment: "to go", correction: `${tag} He suggested going to the beach after work.`, ...RU_OK };
    case "guided_short_answer":
      return { cue_ru: "Сотрудник перестал проверять почту после смены. Начни: The employee stopped…", starter_en: "The employee stopped", accepted_answers: [`The employee stopped checking ${tag} emails after the shift.`, `The employee stopped checking ${tag} email after work.`], meaning_ru: "Сотрудник прекратил проверять почту.", marker_ru: "stop + -ing", reject_ru: "Форма stopped to check не принимается.", ...RU_OK };
    case "russian_to_english_short":
      return { cue_ru: "Не могли бы вы сказать, когда закрывается библиотека?", accepted_answers: [`Could you tell me when the ${tag} library closes?`], meaning_ru: "Вежливая просьба сообщить время закрытия.", marker_ru: "прямой порядок слов", reject_ru: "Вопросительный порядок внутри придаточной части не принимается.", ...RU_OK };
    default:
      // reading passages are long, so tag-prefixed copies of one text are (rightly) rejected as near-duplicates: write genuinely different text
      return {
        paragraphs: [0, 1].map((k) => [0, 1].map((m) => sentenceFor(n * 4 + k * 2 + m)).join(" ")),
        questions: [0, 1].map((q) => ({ prompt: `What happened with the ${tag} item number ${q} in the text?`, options: [`${tag} first option ${q} here`, `${tag} second option ${q} there`, `${tag} third option ${q} again`], correct_index: 0 })),
        ...RU_OK,
      };
  }
}

export type Behaviour = (call: number, unit: UnitRequest) => string | Error;

export class FakeModel implements ChatClient {
  calls = 0;
  units: UnitRequest[] = [];
  /** override per test; default = a clean batch of drafts for every requested ordinal */
  behave: Behaviour = (_c, u) => JSON.stringify({ drafts: u.items.map((i) => goodDraft(u.format, i)) });
  async chat(req: { messages: Array<{ role: string; content: string }> }): Promise<ChatResult> {
    const unit = JSON.parse(req.messages[1]!.content) as UnitRequest;
    this.calls++;
    this.units.push(unit);
    const out = this.behave(this.calls, unit);
    if (out instanceof Error) throw out;
    return { text: out, stats };
  }
}
/** Stand-in for Nimble: the score of a sentence is chosen by the test. Default: everything reads fine (score 0.01). */
export class FakeNimble implements DecisionClient {
  calls = 0;
  score: (text: string) => number = () => 0.01;
  async decide(req: { text: string }): Promise<DecisionResult> {
    this.calls++;
    const p = this.score(req.text);
    return { choice: p >= 0.5 ? "review" : "no_issue", confidence: 0.9, probabilities: { review: p, no_issue: 1 - p }, stats };
  }
}
export const transient = () => new TransportError("ollama_unreachable", "down", true);

export interface Rig {
  env: Env;
  clock: FakeClock;
  gpu: FakeGpu;
  model: FakeModel;
  runner: GenerationJobRunner;
  sched: GpuScheduler;
  deps: { now: () => Date; newId: () => string };
  digest: { current: string | null };
  nimble: FakeNimble;
  nimbleDigest: { current: string | null };
}

const open: Rig[] = [];
export const closeRigs = () => {
  for (const r of open.splice(0)) r.env.cleanup();
};

export async function makeRig(opts: { advisory?: boolean } = {}): Promise<Rig> {
  const env = await makeEnv();
  const clock = new FakeClock();
  const gpu = new FakeGpu(clock);
  const model = new FakeModel();
  const digest = { current: AI_CONFIG_V2.analysis.digest as string | null };
  const deps = { now: () => clock.now(), newId: randomUUID };
  const runner = new GenerationJobRunner({ db: env.db, chat: model, installedDigest: async () => digest.current, runtimeVersion: async () => "test", deps, sleep: async () => {} });
  const nimble = new FakeNimble();
  const nimbleDigest = { current: AI_CONFIG_V2.triage.digest as string | null };
  const advisory = new AdvisoryJobRunner({ db: env.db, decision: nimble, installedDigest: async (tag) => (tag === AI_CONFIG_V2.triage.tag ? nimbleDigest.current : digest.current), runtimeVersion: async () => "test", deps });
  const sched = new GpuScheduler({ db: env.db, newId: randomUUID, clock, telemetry: gpu, control: gpu, runners: opts.advisory ? [runner, advisory] : [runner], instanceId: "A", config: { admission: "spike", idleUnloadMs: 600_000 } });
  const rig: Rig = { env, clock, gpu, model, runner, sched, deps, digest, nimble, nimbleDigest };
  open.push(rig);
  await runner.prepare();
  if (opts.advisory) await advisory.prepare();
  return rig;
}

export async function drive(r: Rig, until: () => boolean, max = 400): Promise<void> {
  for (let i = 0; i < max; i++) {
    await r.sched.tick();
    await flush();
    await flush();
    if (until()) return;
    r.clock.advance(1500);
  }
  throw new Error("condition not reached within the tick budget");
}

/** every job of the batch has left queued/running/waiting */
export const batchJobsSettled = (r: Rig, batchId: string): boolean =>
  rows<{ id: string }>(r.env.db, "SELECT id FROM jobs WHERE batch_id = ?", batchId).every((j) => ["completed", "failed", "cancelled"].includes(getJob(r.env.db, j.id)!.state));

export const checklistAllTrue = () => Object.fromEntries(REVIEW_CHECKLIST_KEYS.map((k) => [k, true])) as ReviewManifest["items"][number]["checklist"];

export interface BatchRevision {
  revisionId: string;
  hash: string;
  ordinal: number;
  type: string;
}
export const batchRevisions = (r: Rig, batchId: string): BatchRevision[] =>
  rows<{ rid: string; hash: string; ordinal: number; type: string }>(
    r.env.db,
    "SELECT bi.revision_id AS rid, er.content_hash AS hash, bi.ordinal AS ordinal, er.type AS type FROM batch_items bi JOIN exercise_revisions er ON er.id = bi.revision_id WHERE bi.batch_id = ? ORDER BY bi.ordinal",
    batchId,
  ).map((x) => ({ revisionId: x.rid, hash: x.hash, ordinal: x.ordinal, type: x.type }));

export function manifest(items: Array<{ rev: BatchRevision; verdict: "approved" | "flagged" | "rejected" }>, reviewer = "agent:test-reviewer@1"): ReviewManifest {
  return {
    schema_version: "content-review-v1",
    reviewer,
    review_version: "pass-1",
    items: items.map(({ rev, verdict }) => ({ revision_id: rev.revisionId, content_hash: rev.hash, verdict, checklist: checklistAllTrue(), reason: `${verdict} in test` })),
  };
}
