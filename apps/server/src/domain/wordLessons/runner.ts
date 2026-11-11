import { WORD_LESSON_SCHEMA, WordLessonContentSchema, type WordLessonContent } from "@english-lab/contracts";
import type { Db } from "../../db/open.js";
import { enqueue } from "../../queue/jobs.js";
import { RunnerError, type RunnerContext, type RunnerOutput } from "../../queue/types.js";
import type { ChatClient } from "../ai/clients.js";
import { runStructured } from "../ai/structured.js";
import type { Validated } from "../ai/validate.js";
import type { LessonPlan, PlanSkill } from "./plan.js";
import { ensurePromptVersion } from "../ai/prompts.js";
import { WORD_LESSON_KEEP_PROMPT, WORD_LESSON_KEEP_SYSTEM_V1, keepFormat, wordLessonKeepSchemaText, WORD_LESSON_SENSE_PROMPT, WORD_LESSON_SENSE_SYSTEM_V1, senseFormat, wordLessonSenseSchemaText, WORD_LESSON_PAIRS_PROMPT, WORD_LESSON_PAIRS_SYSTEM_V1, WORD_LESSON_PROMPT, WORD_LESSON_REVIEW_PROMPT, WORD_LESSON_REVIEW_SYSTEM_V1, pairsFormat, wordLessonPairsSchemaText, wordLessonReviewSchemaText, wordLessonSchemaText, WORD_LESSON_SYSTEM_V1, reviewFormat, stage12Format, stage3Format, stage4Format, stage5Format } from "./prompts.js";
import { keepPairs, pairsOf, senseSentences, reviewInput, reviewSentences, stageInput, stageOfReviewId, validateStage12, validateStage3, validateStage4, validateStage5, type Stage12, type Stage3, type Stage4, type Stage5, type WordFacts } from "./stages.js";
import { SentenceLedger, bad, findTarget, lessonWord, ok, parseObject, sentenceKey, sentencesOfContent, str } from "./validate.js";

export interface WordLessonPayload {
  wordLessonId: string;
  attempt: number;
  /** how many more times the lesson is written again by itself when the checks reject it (the learner is not asked to retry by hand); missing = AUTO_ATTEMPTS */
  autoLeft?: number;
  /** constructions that made an earlier try fail (skill id, or its label when it has none): the next try uses another construction in their place */
  avoidSkills?: string[];
}

/** a rejected lesson is written again up to this many more times before it is shown as failed */
export const AUTO_ATTEMPTS = 2;

export interface WordLessonRunnerDeps {
  db: Db;
  chat: ChatClient;
  model: { tag: string; digest: string };
  params: { numCtx: number; temperature: number; seed: number };
  deps: { now: () => Date; newId: () => string };
  /** throws a RunnerError when the installed model differs from the pinned one */
  assertModel: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

/** how many times one stage is asked for again (each call already has its own transport retries and one repair) */
export const STAGE_TRIES = 3;
/** how many times the reviewer's remarks lead to a rewritten stage */
export const REVIEW_ROUNDS = 3;

export interface SenseSnapshot {
  translationRu: string;
  definitionRu: string;
  pos: string;
  synonyms: string[];
  surfaceForms: string[];
  irregularForms: string[];
}

interface Checkpoint {
  s12?: Stage12;
  s3?: Stage3;
  s4?: Stage4;
  s5?: Stage5;
  notes?: Partial<Record<"stage12" | "stage3" | "stage4" | "stage5", string[]>>;
  reviews?: number;
}

type StageName = "stage12" | "stage3" | "stage4" | "stage5";

interface LessonRow {
  id: string;
  entry_id: string;
  lemma: string;
  sense_json: string;
  plan_json: string;
  status: string;
  generation_attempt: number;
  settings_revision: number;
}

/** plain constructions a model can apply to almost any sentence; they stand in for a construction that failed */
const SAFE_SKILLS: readonly PlanSkill[] = [
  { id: null, label: "Passive voice" },
  { id: null, label: "Present perfect vs past simple" },
  { id: null, label: "Reported speech" },
  { id: null, label: "Question word + statement order (indirect question)" },
];
export const skillKey = (s: PlanSkill | undefined): string => (s ? (s.id ?? s.label) : "");

/**
 * Constructions that cannot be shown with this kind of word: an indirect question or a verb pattern around a conjunction or a preposition ("whereas"),
 * a passive around a phrasal verb ("come up with"). The reviewer rejects such sentences every time, so the plan never asks for them.
 */
export function unsuitableSkill(s: PlanSkill, pos: string): boolean {
  const id = s.id ?? "";
  const label = s.label.toLowerCase();
  const embedded = id.startsWith("questions.embedded") || /indirect question|embedded/.test(label);
  const passive = id.startsWith("passive.") || label.startsWith("passive");
  const pattern = id.startsWith("verb_patterns.") || /stop doing/.test(label);
  if (/conjunction|preposition|determiner|pronoun|interjection/i.test(pos) && (embedded || pattern)) return true;
  if (/adverb|particle/i.test(pos) && pattern) return true;
  return /phrasal/i.test(pos) && passive;
}

/** the plan of this try: a construction that made an earlier try fail is replaced by a plain one */
export function replanAvoiding(plan: LessonPlan, avoid: ReadonlySet<string>): LessonPlan {
  if (avoid.size === 0) return plan;
  const used = new Set(plan.skills.map(skillKey));
  const skills = plan.skills.map((s) => {
    if (!avoid.has(skillKey(s))) return s;
    const pick = SAFE_SKILLS.find((x) => !used.has(skillKey(x)) && !avoid.has(skillKey(x)));
    if (!pick) return s;
    used.add(skillKey(pick));
    return pick;
  });
  return { ...plan, skills };
}

/** which constructions to blame for a rejected try: the tasks the checks complained about (t1.. = stage 3 tasks, b = stage 4) and the item named by a failed stage */
export function blameSkills(plan: LessonPlan, notes: Partial<Record<string, string[]>> | undefined, message: string): string[] {
  const out = new Set<string>();
  const slot = (k: number) => {
    const key = skillKey(plan.skills[k]);
    if (key) out.add(key);
  };
  for (const n of notes?.stage3 ?? []) {
    const m = /^t(\d):/.exec(n);
    if (m) slot(Number(m[1]) - 1);
  }
  if ((notes?.stage4 ?? []).some((n) => n.startsWith("b:"))) slot(plan.transformations);
  for (const m of message.matchAll(/item (\d):/g)) slot(Number(m[1]) - 1);
  if (/^stage4 could not be written/.test(message)) slot(plan.transformations);
  return [...out];
}

export function factsOf(lemma: string, sense: SenseSnapshot): WordFacts {
  return { lemma, translationRu: sense.translationRu, definitionRu: sense.definitionRu, pos: sense.pos, synonyms: sense.synonyms, word: lessonWord(lemma, sense.surfaceForms, sense.irregularForms) };
}

/** Assemble and re-check the stored lesson. Throws a plain Error naming the first problem. */
export function assembleLesson(f: WordFacts, sense: SenseSnapshot, s12: Stage12, s3: Stage3, s4: Stage4, s5: Stage5): WordLessonContent {
  const content = {
    schema_version: WORD_LESSON_SCHEMA,
    lemma: f.lemma,
    sense_ru: sense.translationRu,
    stage1: { examples: s12.examples.map((e, i) => ({ id: `e${i + 1}`, en: e.en, ru: e.ru, target: e.target })) },
    stage2: { id: "s2" as const, gapped_en: s12.gap.gapped_en, full_en: s12.gap.full_en, ru: s12.gap.ru, accepted_forms: s12.gap.accepted_forms },
    stage3: { chained: s3.chained, items: s3.items.map((t, i) => ({ id: `s3.${i + 1}` as "s3.1" | "s3.2" | "s3.3", ...t })) },
    stage4: { id: "s4" as const, ...s4 },
    stage5: { id: "s5" as const, ...s5 },
  };
  const parsed = WordLessonContentSchema.parse(content);
  // the final guard: every sentence of the lesson holds the word and no sentence appears twice (a chain repeats its own sentence by design)
  const keys = new Set<string>();
  for (const s of sentencesOfContent(parsed)) {
    const k = sentenceKey(s);
    if (!findTarget(s, f.word)) throw new Error(`a sentence lost the target word: ${s.slice(0, 40)}`);
    keys.add(k);
  }
  const independent = parsed.stage1.examples.length + 1 + parsed.stage3.items.length * 2 - (parsed.stage3.chained ? parsed.stage3.items.length - 1 : 0) + 1 + 1;
  if (keys.size < independent) throw new Error("the lesson repeats a sentence");
  return parsed;
}

/**
 * The reviewer is the same small model, and it likes to nitpick. A remark counts only when it is an "error" AND its quote really occurs in that sentence;
 * matters of taste and invented quotes are dropped, so a good lesson is not thrown away for a preference.
 */
/** a transformation counts only when the model says the meaning changed AND says what changed */
export function keepValidate(text: string, ids: ReadonlySet<string>): Validated<Array<{ id: string; problem: string }>> {
  const o = parseObject(text);
  if (!o || !Array.isArray(o.items)) return bad("SHAPE", "expected {items:[...]}");
  const out: Array<{ id: string; problem: string }> = [];
  for (const p of o.items as Array<Record<string, unknown>>) {
    const id = str(p?.id);
    if (!ids.has(id)) return bad("ITEM_ID", `unknown item id "${id}"`);
    const difference = str(p.difference);
    if (p.keeps === false && difference.length >= 8) out.push({ id, problem: `the rewritten sentence does not keep the meaning of the first one: ${difference}`.slice(0, 300) });
  }
  return ok(out);
}

/** a sentence counts only when the model says the word is not used naturally AND says what is wrong */
export function senseValidate(text: string, ids: ReadonlySet<string>): Validated<Array<{ id: string; problem: string }>> {
  const o = parseObject(text);
  if (!o || !Array.isArray(o.uses)) return bad("SHAPE", "expected {uses:[...]}");
  const out: Array<{ id: string; problem: string }> = [];
  for (const p of o.uses as Array<Record<string, unknown>>) {
    const id = str(p?.id);
    if (!ids.has(id)) return bad("USE_ID", `unknown sentence id "${id}"`);
    const issue = str(p.issue);
    if (p.natural === false && issue.length >= 8) out.push({ id, problem: `the target word is not used naturally: ${issue}`.slice(0, 300) });
  }
  return ok(out);
}

/** a pair counts only when the model says the Russian differs AND names the difference */
export function pairsValidate(text: string, ids: ReadonlySet<string>): Validated<Array<{ id: string; problem: string }>> {
  const o = parseObject(text);
  if (!o || !Array.isArray(o.pairs)) return bad("SHAPE", "expected {pairs:[...]}");
  const out: Array<{ id: string; problem: string }> = [];
  for (const p of o.pairs as Array<Record<string, unknown>>) {
    const id = str(p?.id);
    if (!ids.has(id)) return bad("PAIR_ID", `unknown pair id "${id}"`);
    const difference = str(p.difference);
    if (p.same === false && difference.length >= 5) out.push({ id, problem: `the Russian does not say the same as the English: ${difference}`.slice(0, 300) });
  }
  return ok(out);
}

export function reviewValidate(text: string, sentences: ReadonlyMap<string, string>): Validated<Array<{ id: string; problem: string }>> {
  const o = parseObject(text);
  if (!o || !Array.isArray(o.problems)) return bad("SHAPE", "expected {problems:[...]}");
  const out: Array<{ id: string; problem: string }> = [];
  for (const p of o.problems as Array<Record<string, unknown>>) {
    const id = str(p?.id);
    if (!stageOfReviewId(id)) return bad("REVIEW_ID", `unknown sentence id "${id}"`);
    const quote = str(p.quote).toLowerCase();
    const real = quote.length >= 2 && (sentences.get(id) ?? "").toLowerCase().includes(quote);
    if (p.severity === "error" && real) out.push({ id, problem: str(p.problem).slice(0, 300) });
  }
  return ok(out);
}

/**
 * One lesson (TASK_031): four writing calls (stages 1+2, 3, 4, 5), each checked by code; a review call over the whole lesson; a stage with remarks is
 * written again with the remark. Only when every stage passed is the lesson stored, in ONE update inside the job's own transaction (`alsoCommit`):
 * `ready` with status `validated`. Any earlier failure leaves the lesson unusable and writes nothing to it.
 */
export async function runWordLessonJob(ctx: RunnerContext<WordLessonPayload>, o: WordLessonRunnerDeps): Promise<RunnerOutput> {
  const { wordLessonId, attempt } = ctx.job.payload;
  const { db } = o;
  const row = db.prepare("SELECT id, entry_id, lemma, sense_json, plan_json, status, generation_attempt, settings_revision FROM word_lessons WHERE id = ?").get(wordLessonId) as LessonRow | undefined;
  if (!row || row.status !== "generating" || row.generation_attempt !== attempt) {
    return { schemaVersion: "word-lesson-v1", output: { wordLessonId, skipped: row ? "not_current" : "unknown" }, metrics: { calls: 0 } };
  }
  await o.assertModel();
  // the prompt versions are recorded the first time a lesson is written (idempotent)
  ensurePromptVersion(db, WORD_LESSON_PROMPT, wordLessonSchemaText());
  ensurePromptVersion(db, WORD_LESSON_REVIEW_PROMPT, wordLessonReviewSchemaText());
  ensurePromptVersion(db, WORD_LESSON_PAIRS_PROMPT, wordLessonPairsSchemaText());
  const sense = JSON.parse(row.sense_json) as SenseSnapshot;
  const avoid = new Set(ctx.job.payload.avoidSkills ?? []);
  for (const s of [...(JSON.parse(row.plan_json) as LessonPlan).skills, ...SAFE_SKILLS]) if (unsuitableSkill(s, (JSON.parse(row.sense_json) as SenseSnapshot).pos)) avoid.add(skillKey(s));
  const storedPlan = JSON.parse(row.plan_json) as LessonPlan;
  const plan = replanAvoiding(storedPlan, avoid);
  const facts = factsOf(row.lemma, sense);
  const cp: Checkpoint = { ...(ctx.job.checkpoint as Checkpoint | undefined) };
  cp.notes ??= {};
  let calls = 0;
  // a new attempt (the learner pressed Retry) or a rewrite after the reviewer's remark must not replay the same random choices, or it would write the same flaw again
  const seedBase = o.params.seed + attempt * 1009 + ctx.job.retryCount * 101;
  const options = (seed: number, predict: number) => ({ num_ctx: o.params.numCtx, num_predict: predict, temperature: o.params.temperature, seed });

  /** the sentences of every stage kept so far except `without` (a stage is checked against the OTHER stages) */
  const ledgerWithout = (without?: StageName): SentenceLedger => {
    const l = new SentenceLedger(db, row.id);
    if (without !== "stage12" && cp.s12) {
      cp.s12.examples.forEach((e, i) => l.accept(e.en, { independent: true, id: `e${i + 1}` }));
      l.accept(cp.s12.gap.full_en, { independent: true, id: "gap" });
    }
    if (without !== "stage3" && cp.s3) {
      const s3 = cp.s3;
      s3.items.forEach((t, i) => {
        if (!(s3.chained && i > 0)) l.accept(t.source_en, { independent: true, id: `s3.${i + 1}.src` });
        l.accept(t.expected_en, { independent: false, id: `s3.${i + 1}.exp` });
      });
    }
    if (without !== "stage4" && cp.s4) l.accept(cp.s4.expected_en, { independent: true, id: "s4" });
    if (without !== "stage5" && cp.s5) l.accept(cp.s5.sample_en, { independent: true, id: "s5" });
    return l;
  };
  let ledger = ledgerWithout();

  async function ask<T>(stage: StageName, format: object, validate: (t: string) => Validated<T>): Promise<T> {
    let last = "";
    // what went wrong in the earlier tries of this stage goes into the next one, so the model does not repeat it
    const earlier: string[] = [];
    for (let t = 0; t < STAGE_TRIES; t++) {
      const r = await runStructured<T>({
        client: o.chat,
        model: o.model.tag,
        messages: [
          { role: "system", content: WORD_LESSON_SYSTEM_V1 },
          { role: "user", content: stageInput(facts, plan, stage, [...(cp.notes?.[stage] ?? []), ...earlier]) },
        ],
        format,
        options: options(seedBase + t * 7 + (cp.reviews ?? 0) * 31 + (cp.notes?.[stage]?.length ?? 0) * 13, stage === "stage3" ? 1800 : 1200),
        validate,
        signal: ctx.signal,
        sleep: o.sleep,
      });
      calls += r.usage.calls;
      if (r.ok) return r.value;
      if (r.code === "transport_failed") throw new RunnerError("transport_failed", r.issues.map((i) => `${i.code}: ${i.message}`).join("; ").slice(0, 300), true);
      last = r.issues.map((i) => i.code).join(",");
      for (const i of r.issues.slice(0, 2)) if (!earlier.includes(i.message)) earlier.push(i.message.slice(0, 250));
      if (ctx.signal.aborted) throw new RunnerError("aborted", "stopped", true);
    }
    throw new RunnerError("lesson_stage_failed", `${stage} could not be written (${last}): ${earlier.join(" | ")}`.slice(0, 600), false, ["WORD_LESSON_STAGE"]);
  }

  const order: StageName[] = ["stage12", "stage3", "stage4", "stage5"];
  const have = (s: StageName) => (s === "stage12" ? cp.s12 : s === "stage3" ? cp.s3 : s === "stage4" ? cp.s4 : cp.s5);
  const drop = (s: StageName) => {
    if (s === "stage12") delete cp.s12;
    else if (s === "stage3") delete cp.s3;
    else if (s === "stage4") delete cp.s4;
    else delete cp.s5;
  };
  const write = async (s: StageName): Promise<void> => {
    ledger = ledgerWithout(s);
    if (s === "stage12") cp.s12 = await ask("stage12", stage12Format(), (t) => validateStage12(t, facts, ledger));
    else if (s === "stage3") cp.s3 = await ask("stage3", stage3Format(), (t) => validateStage3(t, facts, plan, ledger));
    else if (s === "stage4") cp.s4 = await ask("stage4", stage4Format(), (t) => validateStage4(t, facts, plan, ledger));
    else cp.s5 = await ask("stage5", stage5Format(), (t) => validateStage5(t, facts, ledger));
    ctx.checkpoint(cp);
  };

  try {
    for (const s of order) if (!have(s)) await write(s);
    for (let round = 0; ; round++) {
      const review = await runStructured<Array<{ id: string; problem: string }>>({
        client: o.chat,
        model: o.model.tag,
        messages: [
          { role: "system", content: WORD_LESSON_REVIEW_SYSTEM_V1 },
          { role: "user", content: reviewInput(facts, cp.s12!, cp.s3!, cp.s4!, cp.s5!) },
        ],
        format: reviewFormat(),
        options: options(seedBase + 900 + round, 700),
        validate: (t) => reviewValidate(t, new Map(reviewSentences(cp.s12!, cp.s3!, cp.s4!, cp.s5!).map((x) => [x.id!, `${x.en} ${x.ru} ${x.note ?? ""}`]))),
        signal: ctx.signal,
        sleep: o.sleep,
      });
      calls += review.usage.calls;
      if (!review.ok) {
        if (review.code === "transport_failed") throw new RunnerError("transport_failed", "review call failed", true);
        throw new RunnerError("lesson_review_failed", "the review answer could not be read", false, ["WORD_LESSON_REVIEW"]);
      }
      // the Russian must say what the English says: a narrow question of its own (an unreadable answer is skipped, never a reason to reject)
      const pairList = pairsOf(cp.s12!, cp.s3!, cp.s4!, cp.s5!);
      const pairCheck = await runStructured<Array<{ id: string; problem: string }>>({
        client: o.chat,
        model: o.model.tag,
        messages: [
          { role: "system", content: WORD_LESSON_PAIRS_SYSTEM_V1 },
          { role: "user", content: JSON.stringify({ pairs: pairList }) },
        ],
        format: pairsFormat(),
        options: options(seedBase + 950 + round, 700),
        validate: (t) => pairsValidate(t, new Set(pairList.map((x) => x.id))),
        signal: ctx.signal,
        sleep: o.sleep,
      });
      calls += pairCheck.usage.calls;
      if (!pairCheck.ok && pairCheck.code === "transport_failed") throw new RunnerError("transport_failed", "translation check failed", true);
      // HARD: the reviewer's quoted errors (rewritten until gone, or the lesson is rejected). SOFT: a Russian text that may say something else (a small model often disagrees with itself
      // about this): ONE rewrite, then it is let go. The rest of the quality rules are plain code checks in the stages (cheap and always the same), not more model judges.
      const hard = review.value;
      const soft = round === 0 ? (pairCheck.ok ? pairCheck.value : []) : [];
      const problems = [...hard, ...soft];
      if (problems.length === 0) break;
      if (round >= REVIEW_ROUNDS - 1) throw new RunnerError("lesson_review_rejected", `the review still found problems: ${problems.map((p) => p.id).join(",")}`, false, ["WORD_LESSON_REVIEW"]);
      const stages = new Set<StageName>();
      for (const p of problems) {
        const s = stageOfReviewId(p.id)!;
        stages.add(s);
        (cp.notes![s] ??= []).push(`${p.id}: ${p.problem}`);
      }
      for (const s of order) {
        if (!stages.has(s)) continue;
        drop(s);
        await write(s);
      }
      cp.reviews = round + 1;
      ctx.checkpoint(cp);
    }
    const content = assembleLesson(facts, sense, cp.s12!, cp.s3!, cp.s4!, cp.s5!);
    const { now } = o.deps;
    return {
      schemaVersion: WORD_LESSON_SCHEMA,
      output: { wordLessonId, attempt, sentences: sentencesOfContent(content).length },
      metrics: { calls, reviews: (cp.reviews ?? 0) + 1 },
      alsoCommit: (tx) => {
        const cur = tx.prepare("SELECT status, generation_attempt AS a FROM word_lessons WHERE id = ?").get(wordLessonId) as { status: string; a: number } | undefined;
        if (!cur || cur.status !== "generating" || cur.a !== attempt) return; // settled by another delivery
        const jr = tx.prepare("SELECT id FROM job_results WHERE job_id = ?").get(ctx.job.id) as { id: string } | undefined;
        const mv = tx.prepare("SELECT id FROM model_versions WHERE tag = ? AND digest = ? ORDER BY rowid DESC LIMIT 1").get(o.model.tag, o.model.digest) as { id: string } | undefined;
        tx.prepare("UPDATE word_lessons SET status = 'ready', content_json = ?, content_status = 'validated', schema_version = ?, model_version_id = ?, job_result_id = ?, error_code = NULL, ready_at = ? WHERE id = ?").run(
          JSON.stringify(content),
          WORD_LESSON_SCHEMA,
          mv?.id ?? null,
          jr?.id ?? null,
          now().toISOString(),
          wordLessonId,
        );
      },
    };
  } catch (e) {
    const definitive = !ctx.signal.aborted && (e instanceof RunnerError ? !e.transient : true);
    if (definitive) {
      const code = (e instanceof RunnerError ? e.code : "lesson_invalid").slice(0, 60);
      const left = ctx.job.payload.autoLeft ?? AUTO_ATTEMPTS;
      db.transaction(() => {
        if (left > 0) {
          // the checks rejected this try: write the lesson again at once with a new attempt number (a new random choice); nothing of the rejected one is stored
          const moved = db.prepare("UPDATE word_lessons SET generation_attempt = ?, error_code = ? WHERE id = ? AND status = 'generating' AND generation_attempt = ?").run(attempt + 1, code, wordLessonId, attempt);
          if (moved.changes === 1) enqueue(db, o.deps, { kind: "generation", priority: 3, payload: { wordLessonId, attempt: attempt + 1, autoLeft: left - 1, avoidSkills: [...new Set([...avoid, ...blameSkills(plan, cp.notes, e instanceof Error ? e.message : "")])] }, idempotencyKey: `word-lesson:${wordLessonId}:${attempt + 1}` });
        } else {
          // out of tries: the lesson is shown as failed, so the page can offer a retry
          db.prepare("UPDATE word_lessons SET status = 'failed', error_code = ? WHERE id = ? AND status = 'generating' AND generation_attempt = ?").run(code, wordLessonId, attempt);
        }
      }).immediate();
    }
    throw e;
  }
}
