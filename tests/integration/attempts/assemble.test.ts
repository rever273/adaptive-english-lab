// TASK_026: a block exercise is graded by code into confirmed evidence, is shown scrambled without its answers, and takes a choose_missing_fragment slot.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { AttemptRequest } from "../../../packages/contracts/src/index.js";
import { recordAttempt } from "../../../apps/server/src/domain/attempts/attempts.js";
import { ClosedFormAssessor } from "../../../apps/server/src/domain/content/grader.js";
import { buildPrompt } from "../../../apps/server/src/domain/sessions/reveal.js";
import { getFeedback } from "../../../apps/server/src/domain/sessions/feedback.js";
import { loadCandidates } from "../../../apps/server/src/domain/sessions/bank.js";
import { makeEnv, makeRevision, makeSession, makeSlot, addEvent, rows, type Env } from "./fixtures.js";

let env: Env;
afterEach(() => env?.cleanup());

const BLOCKS = ["the", "team", "fixed", "the", "bug.", "fix"].map((text, i) => ({ id: `b${i + 1}`, text }));
const content = (exerciseId: string) => ({
  schema_version: "exercise-v1",
  id: exerciseId,
  type: "assemble_sentence",
  target_skill: "articles.definite",
  prompt_en: "Build the sentence from the blocks.",
  explanation_ru: "Определённый артикль стоит перед известным существительным.",
  hints_ru: ["Подсказка."],
  payload: { cue_ru: "Команда исправила ошибку.", blocks: BLOCKS, distractor_block_ids: ["b6"], accepted_answers: ["The team fixed the bug."] },
});
const submit = (slotId: string, answer: string[]): AttemptRequest => ({ slotId, submissionId: randomUUID(), answer, inputMode: "text" });

async function setup() {
  env = await makeEnv({ assessor: ClosedFormAssessor });
  const revisionId = makeRevision(env, { type: "assemble_sentence", dimension: "recognition", content: content(randomUUID()) });
  const sessionId = makeSession(env);
  const slotId = makeSlot(env, sessionId, revisionId, 0);
  addEvent(env, sessionId, slotId, "reveal");
  return { revisionId, sessionId, slotId };
}

describe("assemble_sentence in play", () => {
  it("a right order is confirmed correct evidence, a wrong order confirmed incorrect evidence - both by code, in the recognition dimension", async () => {
    const { slotId } = await setup();
    const miss = recordAttempt(env.db, env.deps, submit(slotId, ["b2", "b1", "b3", "b4", "b5"]));
    expect(miss.body.assessment).toMatchObject({ verdict: "incorrect", confirmation: "confirmed" });
    expect(rows(env.db, "SELECT result, dimension FROM confirmed_opportunities WHERE target = 1")).toEqual([{ result: "failure", dimension: "recognition" }]);
    const hit = recordAttempt(env.db, env.deps, submit(slotId, ["b4", "b2", "b3", "b1", "b5"])); // the two 'the' blocks are interchangeable
    expect(hit.body.assessment).toMatchObject({ verdict: "correct", confirmation: "confirmed" });
  });

  it("the shown task is scrambled, never already solved, and carries no accepted answers", async () => {
    const { revisionId, slotId } = await setup();
    const json = rows<{ content_json: string }>(env.db, "SELECT content_json FROM exercise_revisions WHERE id = ?", revisionId)[0]!.content_json;
    const shown = buildPrompt("assemble_sentence", json, null, slotId);
    expect(shown.kind).toBe("blocks");
    if (shown.kind !== "blocks") return;
    expect(shown.blocks.map((b) => b.id).sort()).toEqual(BLOCKS.map((b) => b.id).sort());
    expect(JSON.stringify(shown)).not.toContain("accepted_answers");
    expect(JSON.stringify(shown)).not.toContain("distractor");
    expect(shown.blocks.map((b) => b.id)).toEqual(buildPrompt("assemble_sentence", json, null, slotId).kind === "blocks" ? (buildPrompt("assemble_sentence", json, null, slotId) as { blocks: Array<{ id: string }> }).blocks.map((b) => b.id) : []); // stable per slot
    // with no wrong block, a scramble that spells the sentence is never shown
    const solved = { ...JSON.parse(json), payload: { ...JSON.parse(json).payload, blocks: BLOCKS.slice(0, 5), distractor_block_ids: [] } };
    for (let i = 0; i < 40; i++) {
      const p = buildPrompt("assemble_sentence", JSON.stringify(solved), null, `slot-${i}`);
      if (p.kind !== "blocks") throw new Error("expected blocks");
      const order = p.blocks.map((b) => BLOCKS.find((x) => x.id === b.id)!.text).join(" ");
      expect(order).not.toBe("the team fixed the bug.");
    }
  });

  it("feedback shows the learner's blocks as a sentence and the approved sentence", async () => {
    const { sessionId, slotId } = await setup();
    recordAttempt(env.db, env.deps, submit(slotId, ["b2", "b1", "b3", "b4", "b5"]));
    const f = getFeedback(env.db, env.deps as never, sessionId, slotId);
    expect(f.yourAnswer).toBe("team the fixed the bug.");
    expect(f.correct).toEqual({ answers: ["The team fixed the bug."] });
  });

  it("the bank offers it for a choose_missing_fragment slot only when it is released; the real type is kept for play", async () => {
    const { revisionId } = await setup();
    expect(loadCandidates(env.db, "practice").some((c) => c.revisionId === revisionId)).toBe(false); // not approved and released: the real view hides it
    env.db.exec("DROP VIEW selectable_revisions; CREATE VIEW selectable_revisions AS SELECT id AS revision_id, exercise_id, type, dimension, difficulty, bank_role, content_hash FROM exercise_revisions");
    env.db.prepare("INSERT INTO exercise_skills SELECT ?, id, 'target' FROM skill_revisions WHERE skill_id = 'articles.definite' AND active = 1 LIMIT 1").run(revisionId);
    const c = loadCandidates(env.db, "practice").find((x) => x.revisionId === revisionId);
    expect(c).toMatchObject({ format: "choose_missing_fragment", dimension: "recognition" });
    expect(rows<{ type: string }>(env.db, "SELECT type FROM exercise_revisions WHERE id = ?", revisionId)[0]!.type).toBe("assemble_sentence");
  });
});
