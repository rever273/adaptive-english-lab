import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { difficultyLevels } from "../../../packages/contracts/src/index.js";
import { loadCandidates } from "../../../apps/server/src/domain/sessions/bank.js";
import { diagEnv, practiceBank, seed } from "../diagnostics/fixtures.js";

it("registers and releases a reviewed C2 exercise and selects it only when its range allows C2", async () => {
  const { env } = await diagEnv({ practice: true });
  try {
    const c = structuredClone(practiceBank().find((x) => x.type === "choose_form")!);
    c.id = randomUUID();
    c.difficulty = "C2";
    c.context_level = "C2";
    c.context_id = `c2-${c.id}`;
    c.template_cluster = `c2-${c.id}`;
    c.prompt_en = "At the symposium, the panel ___ its conclusions despite unusually stringent scrutiny.";
    const ids = seed(env, [c]);
    const id = ids.get(c.id)!;
    expect(loadCandidates(env.db, "practice", [], difficultyLevels({ difficultyMin: "C2", difficultyMax: "C2" })).map((x) => x.revisionId)).toEqual([id]);
    expect(loadCandidates(env.db, "practice", [], difficultyLevels({ difficultyMin: "B1", difficultyMax: "C1" })).some((x) => x.revisionId === id)).toBe(false);
  } finally { env.cleanup(); }
});
