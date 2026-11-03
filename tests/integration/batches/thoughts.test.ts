// TASK_026 stage 2: a saved Russian thought is read by the model through the queue (English + patterns, NO skills), an agent chooses the
// grammar skills, and only then does it become ordinary drafts that wait for review.
import { afterEach, describe, expect, it } from "vitest";
import { addThought, createThoughtBatch, getThought, thoughtsNeedingSkills, thoughtsReady } from "../../../apps/server/src/domain/thoughts/repository.js";
import { applyThoughtSkills, thoughtsForSkillReview } from "../../../apps/server/src/domain/thoughts/skillReview.js";
import { getBatch } from "../../../apps/server/src/domain/content/batches/repository.js";
import { taxonomyForNewRevisions } from "../../../apps/server/src/domain/content/repository.js";
import { rows } from "../attempts/fixtures.js";
import { batchJobsSettled, closeRigs, drive, makeRig, type Rig } from "./fixtures.js";

afterEach(closeRigs);

const SOURCE_EN = "It would be great to go ice skating tomorrow.";
const RU = "Вот было бы здорово завтра пойти покататься на коньках.";
const PATTERN = { pattern: "It would be + adjective + to-infinitive", why_ru: "Выражение желаемого действия." };
const thoughtSettled = (r: Rig, id: string) => () => getThought(r.env.db, id)!.status !== "pending";

/** answers the interpretation call (it carries `thought_ru`); anything else falls back to the default clean drafts */
function interpretWith(r: Rig, answer: unknown): void {
  const normal = r.model.behave;
  r.model.behave = (c, u) => ("thought_ru" in (u as object) ? JSON.stringify(answer) : normal(c, u));
}
const manifest = (items: unknown[], extra: Record<string, unknown> = {}) => ({ schema_version: "thought-skill-review-v1", reviewer: "agent:test@1", review_version: "pass-1", items, ...extra });
const firstSkill = (r: Rig) => [...taxonomyForNewRevisions(r.env.db).skills].sort()[0]!;

async function readOne(r: Rig, ru = RU, answer: unknown = { status: "ok", english: SOURCE_EN, constructions: [PATTERN] }) {
  interpretWith(r, answer);
  const t = addThought(r.env.db, r.deps, ru).thought;
  await drive(r, thoughtSettled(r, t.id));
  return t;
}

describe("personal thoughts: reading", () => {
  it("the model proposes English and patterns but no skill; a thought waits for an agent's skill choice and creates nothing", async () => {
    const r = await makeRig();
    const t = await readOne(r, RU, { status: "ok", english: SOURCE_EN, constructions: [{ ...PATTERN, skill_id: "conditionals.second" }, { pattern: "to + verb", why_ru: "Инфинитив." }] });
    const done = getThought(r.env.db, t.id)!;
    expect(done).toMatchObject({ status: "needs_skills", englishDraft: SOURCE_EN, textRu: RU });
    const out = JSON.parse(rows<{ output_json: string }>(r.env.db, "SELECT output_json FROM thought_analyses WHERE status = 'needs_skills'")[0]!.output_json) as { constructions: Array<Record<string, unknown>> };
    expect(out.constructions).toHaveLength(2);
    expect(out.constructions.every((c) => !("skill_id" in c))).toBe(true); // the model's own skill claim is not kept
    expect(thoughtsNeedingSkills(r.env.db)).toBe(1);
    expect(thoughtsReady(r.env.db)).toBe(0);
    expect(() => createThoughtBatch(r.env.db, r.deps)).toThrow(/No analysed thoughts/);
    expect(rows(r.env.db, "SELECT 1 FROM exercise_revisions")).toHaveLength(0);
    expect(r.model.units.some((u) => JSON.stringify(u).includes("allowed_skills"))).toBe(false); // the model is never shown the skill list
  });

  it("an ambiguous thought and a thought without a reusable pattern are settled without any skill review", async () => {
    const r = await makeRig();
    const a = await readOne(r, "Ну это самое, ну ты понял, вот.", { status: "ambiguous", english: "", constructions: [] });
    expect(getThought(r.env.db, a.id)!.status).toBe("ambiguous");
    const b = await readOne(r, "Спасибо большое!", { status: "no_skill", english: "Thanks a lot!", constructions: [] });
    expect(getThought(r.env.db, b.id)!.status).toBe("no_skill");
    expect(thoughtsNeedingSkills(r.env.db) + thoughtsReady(r.env.db)).toBe(0);
  });
});

describe("personal thoughts: the agent's skill choice", () => {
  it("lists the waiting thoughts, appends the choice as a new analysis, drops patterns without a skill, and a second apply is a no-op", async () => {
    const r = await makeRig();
    const t = await readOne(r, RU, { status: "ok", english: SOURCE_EN, constructions: [PATTERN, { pattern: "to + verb", why_ru: "Инфинитив." }] });
    const [w] = thoughtsForSkillReview(r.env.db);
    expect(w).toMatchObject({ thought_ru: RU, english: SOURCE_EN });
    expect(w!.constructions.map((c) => c.index)).toEqual([0, 1]);
    const skill = firstSkill(r);
    const m = manifest([{ analysis_id: w!.analysis_id, constructions: [{ index: 0, skill_id: skill, rationale: "fits" }, { index: 1, skill_id: null, rationale: "no skill fits" }] }]);
    expect(applyThoughtSkills(r.env.db, r.deps, m)).toMatchObject({ applied: 1, alreadyApplied: 0, withSkills: 1, withoutSkills: 0 });
    expect(getThought(r.env.db, t.id)!.status).toBe("ok");
    const out = JSON.parse(rows<{ output_json: string }>(r.env.db, "SELECT output_json FROM thought_analyses WHERE status = 'ok'")[0]!.output_json) as { constructions: Array<{ skill_id: string }>; discarded_patterns: unknown[] };
    expect(out.constructions.map((c) => c.skill_id)).toEqual([skill]);
    expect(out.discarded_patterns).toHaveLength(1);
    expect(rows(r.env.db, "SELECT 1 FROM thought_analyses WHERE thought_id = ?", t.id)).toHaveLength(3); // pending, model reading, agent choice
    expect(applyThoughtSkills(r.env.db, r.deps, m)).toMatchObject({ applied: 0, alreadyApplied: 1 });
    expect(rows(r.env.db, "SELECT 1 FROM thought_analyses WHERE thought_id = ?", t.id)).toHaveLength(3);
  });

  it("refuses the whole manifest for an unknown skill, a missing pattern decision or a bad reviewer, and a null-only choice ends as no_skill", async () => {
    const r = await makeRig();
    const t = await readOne(r);
    const id = thoughtsForSkillReview(r.env.db)[0]!.analysis_id;
    const one = (c: unknown[]) => manifest([{ analysis_id: id, constructions: c }]);
    expect(() => applyThoughtSkills(r.env.db, r.deps, one([{ index: 0, skill_id: "made_up.skill", rationale: "x" }]))).toThrow(/refused as a whole/);
    expect(() => applyThoughtSkills(r.env.db, r.deps, one([{ index: 1, skill_id: null, rationale: "x" }]))).toThrow(/refused as a whole/);
    expect(() => applyThoughtSkills(r.env.db, r.deps, manifest([{ analysis_id: id, constructions: [{ index: 0, skill_id: null, rationale: "x" }] }], { reviewer: "gemma" }))).toThrow();
    expect(getThought(r.env.db, t.id)!.status).toBe("needs_skills"); // nothing changed
    applyThoughtSkills(r.env.db, r.deps, one([{ index: 0, skill_id: null, rationale: "no skill genuinely fits" }]));
    expect(getThought(r.env.db, t.id)!.status).toBe("no_skill");
    expect(() => createThoughtBatch(r.env.db, r.deps)).toThrow(/No analysed thoughts/);
  });
});

describe("personal thoughts: drafting", () => {
  it("turns a checked thought into a draft batch: the model gets the pattern but not the learner's sentence; drafts wait for review; a second batch is refused", async () => {
    const r = await makeRig();
    await readOne(r);
    const skill = firstSkill(r);
    applyThoughtSkills(r.env.db, r.deps, manifest([{ analysis_id: thoughtsForSkillReview(r.env.db)[0]!.analysis_id, constructions: [{ index: 0, skill_id: skill, rationale: "fits" }] }]));
    expect(thoughtsReady(r.env.db)).toBe(1);
    r.model.units.length = 0;

    const created = createThoughtBatch(r.env.db, r.deps);
    expect(created).toMatchObject({ items: 1, thoughts: 1 });
    await drive(r, () => batchJobsSettled(r, created.batchId));
    const seen = JSON.stringify(r.model.units);
    expect(seen).toContain(PATTERN.pattern);
    expect(seen).not.toContain(SOURCE_EN);
    expect(seen).not.toContain("коньках");
    expect(rows<{ plan_json: string }>(r.env.db, "SELECT plan_json FROM batch_items WHERE batch_id = ?", created.batchId).map((x) => JSON.parse(x.plan_json).target_skill)).toEqual([skill]);

    const b = getBatch(r.env.db, created.batchId);
    expect(b.counts.ready_for_review + b.counts.generated).toBe(1);
    expect(rows<{ to_status: string }>(r.env.db, "SELECT to_status FROM content_state_events ORDER BY sequence DESC LIMIT 1")[0]!.to_status).toBe("pending_review");
    expect(rows(r.env.db, "SELECT 1 FROM selectable_revisions")).toHaveLength(0);
    expect(thoughtsReady(r.env.db)).toBe(0);
    expect(() => createThoughtBatch(r.env.db, r.deps)).toThrow(/No analysed thoughts/);
  });

  it("rejects a draft that repeats the learner's own sentence", async () => {
    const r = await makeRig();
    await readOne(r, "Совет попросил нас послушать объявление по безопасности.", { status: "ok", english: "The tzzza council asked us to listen to the safety announcement.", constructions: [{ pattern: "listen + to", why_ru: "Предлог после глагола." }] });
    applyThoughtSkills(r.env.db, r.deps, manifest([{ analysis_id: thoughtsForSkillReview(r.env.db)[0]!.analysis_id, constructions: [{ index: 0, skill_id: firstSkill(r), rationale: "fits" }] }]));
    const created = createThoughtBatch(r.env.db, r.deps);
    r.model.behave = (_c, u) => JSON.stringify({ drafts: (u as unknown as { items: unknown[] }).items.map(() => ({ sentence: "The tzzza council asked us to listen ___ the safety announcement.", options: ["to", "for", "at"], correct_index: 0, hint_ru: "Подсказка: обратите внимание на предлог.", explanation_ru: "После listen перед объектом требуется предлог to: listen to the announcement." })) });
    await drive(r, () => batchJobsSettled(r, created.batchId));
    const item = rows<{ state: string; error_json: string }>(r.env.db, "SELECT state, error_json FROM batch_items WHERE batch_id = ?", created.batchId)[0]!;
    expect(item.state).toBe("invalid");
    expect(item.error_json).toContain("COPIED_THOUGHT");
  });
});

describe("personal thoughts: rewrite tasks with a hint (format C) and block tasks (format B)", () => {
  const T3 = { status: "ok", english: "If I'd known about that sooner, I wouldn't have changed anything in the zzqx database.", constructions: [{ pattern: "If + had + past participle, would + have + past participle", why_ru: "Нереальное условие в прошлом." }] };
  const transformDraft = (o: Record<string, unknown> = {}) => ({
    source_en: "The team missed the deadline because nobody checked the staging logs.",
    task_en: "Say this as a regret about the past.",
    hint_en: "Use a third conditional.",
    cue_ru: "Выразите сожаление о прошлом: из-за невнимательности команда пропустила срок.",
    accepted_answers: ["If the team had checked the staging logs, they would not have missed the deadline.", "If somebody had checked the staging logs, the team would not have missed the deadline."],
    meaning_ru: "Сожаление о прошлом: при проверке логов срок не был бы сорван.",
    marker_ru: "третье условное: had + V3, would have + V3",
    reject_ru: "Не принимать ответы с будущим или настоящим временем.",
    hint_ru: "Подсказка: условие относится к прошлому, нужен Past Perfect.",
    explanation_ru: "Для нереального прошлого используется третье условное: if + had + V3, would have + V3.",
    ...o,
  });
  const blocksDraft = (o: Record<string, unknown> = {}) => ({
    cue_ru: "Скажите, что если бы команда проверила логи, срок не был бы сорван.",
    blocks: ["if the team", "had checked", "the logs,", "they would", "have met", "the deadline."],
    distractor: "has checked",
    other_orders: [],
    hint_ru: "Подсказка: условие относится к прошлому.",
    explanation_ru: "Для нереального прошлого используется третье условное: if + had + V3, would have + V3.",
    ...o,
  });
  async function batchFor(r: Rig, draft: Record<string, unknown>, blocks: Record<string, unknown> = blocksDraft()) {
    await readOne(r, "Если бы я знал об этом раньше, я бы не стал ничего менять в базе данных.", T3);
    applyThoughtSkills(r.env.db, r.deps, manifest([{ analysis_id: thoughtsForSkillReview(r.env.db)[0]!.analysis_id, constructions: [{ index: 0, skill_id: "conditionals.third", rationale: "fits" }] }]));
    const normal = r.model.behave;
    r.model.behave = (c, u) => {
      const f = (u as unknown as { format: string }).format;
      return f === "guided_short_answer" ? JSON.stringify({ drafts: [draft] }) : f === "assemble_sentence" ? JSON.stringify({ drafts: [blocks] }) : normal(c, u);
    };
    r.model.units.length = 0;
    const created = createThoughtBatch(r.env.db, r.deps);
    await drive(r, () => batchJobsSettled(r, created.batchId));
    return created;
  }
  const itemOf = (r: Rig, batchId: string, type: string) => rows<{ state: string; error_json: string | null; content_json: string | null }>(r.env.db, "SELECT bi.state, bi.error_json, er.content_json FROM batch_items bi LEFT JOIN exercise_revisions er ON er.id = bi.revision_id WHERE bi.batch_id = ? AND json_extract(bi.plan_json, '$.type') = ?", batchId, type)[0]!;

  it("a pattern with a rewrite-friendly skill gets two drafts; the rewrite shows source, task and hint, stores the source, and waits for review", async () => {
    const r = await makeRig();
    const created = await batchFor(r, transformDraft());
    expect(created.items).toBe(3); // choose the phrase, rewrite, build from blocks
    const c = itemOf(r, created.batchId, "guided_short_answer");
    expect(c.state).toBe("generated");
    const ex = JSON.parse(c.content_json!) as { prompt_en: string; payload: { source_en: string; accepted_answers: string[] }; type: string; dimension: string };
    expect(ex).toMatchObject({ type: "guided_short_answer", dimension: "production" });
    expect(ex.prompt_en).toBe("Source: The team missed the deadline because nobody checked the staging logs.\nTask: Say this as a regret about the past.\nHint: Use a third conditional.");
    expect(ex.payload.source_en).toContain("staging logs");
    expect(itemOf(r, created.batchId, "choose_missing_fragment").state).toBe("generated");
    expect(rows(r.env.db, "SELECT 1 FROM selectable_revisions")).toHaveLength(0);
    // the source sentence is a unit of the exercise, so it can never come back as another exercise
    expect(rows<{ n: number }>(r.env.db, "SELECT COUNT(*) AS n FROM revision_prompt_units rpu JOIN prompt_units u ON u.id = rpu.unit_id WHERE u.canonical_text LIKE '%nobody checked the staging logs%'")[0]!.n).toBeGreaterThan(0);
    expect(JSON.stringify(r.model.units)).not.toContain("zzqx"); // the learner's sentence never reaches the model
  });

  it("the block task keeps its blocks in order, adds the wrong block, stores the approved sentence and is recognition", async () => {
    const r = await makeRig();
    const created = await batchFor(r, transformDraft());
    const b = itemOf(r, created.batchId, "assemble_sentence");
    expect(b.state).toBe("generated");
    const ex = JSON.parse(b.content_json!) as { type: string; dimension: string; prompt_en: string; payload: { blocks: Array<{ id: string; text: string }>; distractor_block_ids: string[]; accepted_answers: string[] } };
    expect(ex).toMatchObject({ type: "assemble_sentence", dimension: "recognition", prompt_en: "Build the sentence from the blocks." });
    expect(ex.payload.accepted_answers).toEqual(["if the team had checked the logs, they would have met the deadline."]);
    expect(ex.payload.blocks.map((x) => x.text)).toEqual(["if the team", "had checked", "the logs,", "they would", "have met", "the deadline.", "has checked"]);
    expect(ex.payload.distractor_block_ids).toEqual(["b7"]);
    expect(rows(r.env.db, "SELECT 1 FROM selectable_revisions")).toHaveLength(0);
  });

  it.each([
    ["no wrong block for a skill that is not about word order", { distractor: "" }, "DISTRACTOR_REQUIRED"],
    ["a wrong block that is a real block", { distractor: "had checked" }, "DISTRACTOR_IS_BLOCK"],
    ["another order that cannot be spelled from the blocks", { other_orders: ["If the team had checked the logs, they would have missed the deadline."] }, "OTHER_ORDER_NOT_FROM_BLOCKS"],
    ["blocks of more than four words", { blocks: ["if the team had checked the logs", "they would", "have met", "the deadline."] }, "BLOCK_TOO_LONG"],
    ["the learner's own sentence", { blocks: ["if i'd known", "about that sooner,", "i wouldn't have changed", "anything", "in the zzqx database."], other_orders: [] }, "COPIED_THOUGHT"],
  ])("rejects %s", async (_n, patch, code) => {
    const r = await makeRig();
    const created = await batchFor(r, transformDraft(), blocksDraft(patch as Record<string, unknown>));
    const b = itemOf(r, created.batchId, "assemble_sentence");
    expect(b.state).toBe("invalid");
    expect(b.error_json).toContain(code);
  });

  it.each([
    ["an answer that repeats the source sentence", { accepted_answers: ["The team missed the deadline because nobody checked the staging logs.", "If the team had checked the staging logs, they would not have missed the deadline."] }, "ANSWER_IS_SOURCE"],
    ["a hint that contains a complete answer", { hint_en: "If the team had checked the staging logs, they would not have missed the deadline." }, "HINT_LEAKS"],
    ["the learner's own sentence as the source", { source_en: "If I'd known about that sooner, I wouldn't have changed anything in the zzqx database." }, "COPIED_THOUGHT"],
    ["a Russian task in the English fields", { task_en: "Скажите это как сожаление." }, "NOT_ENGLISH"],
  ])("rejects %s", async (_n, patch, code) => {
    const r = await makeRig();
    const created = await batchFor(r, transformDraft(patch as Record<string, unknown>));
    const c = itemOf(r, created.batchId, "guided_short_answer");
    expect(c.state).toBe("invalid");
    expect(c.error_json).toContain(code);
  });

  it("a skill where a rewrite is not natural (agreement) gets only the choose-the-phrase draft", async () => {
    const r = await makeRig();
    await readOne(r);
    applyThoughtSkills(r.env.db, r.deps, manifest([{ analysis_id: thoughtsForSkillReview(r.env.db)[0]!.analysis_id, constructions: [{ index: 0, skill_id: "agreement.be_auxiliary", rationale: "fits" }] }]));
    expect(createThoughtBatch(r.env.db, r.deps).items).toBe(1);
  });
});
