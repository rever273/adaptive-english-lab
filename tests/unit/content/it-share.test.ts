import { describe, expect, it } from "vitest";
import { planTopic } from "../../../apps/server/src/domain/content/batches/plan.js";
import { vocabularyTopic } from "../../../apps/server/src/domain/content/batches/repository.js";
import { itContext } from "../../../apps/server/src/domain/content/batches/itContext.js";

describe("IT share of generated sentences", () => {
  it("is 20% for grammar and vocabulary plans", () => {
    const n = 200;
    const g = Array.from({ length: n }, (_, i) => planTopic(i)).filter((t) => t === "technology").length;
    const v = Array.from({ length: n }, (_, i) => vocabularyTopic(i, 0)).filter((t) => t === "technology").length;
    expect(g).toBe(40);
    expect(v).toBe(40);
  });
  it("gives the generator a setting and two phrases", () => {
    const c = itContext(3);
    expect(c.suggested_phrases).toHaveLength(2);
    expect(c.setting).toContain("Australian");
  });
});
