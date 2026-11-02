import { describe, expect, it } from "vitest";
import { MASTERY_V1, MASTERY_V2, MASTERY_V3, computeComponents } from "@english-lab/learning";
import { computeGroups } from "../../../apps/server/src/domain/analytics/runs.js";

const AS_OF = "2026-11-02T00:00:00.000Z";
const row = (id: string, partial: boolean) => ({ id, skillId: "tenses.past_simple", dimension: "recognition" as const, at: "2026-11-01T01:00:00.000Z", localDate: "2026-11-01", success: true, heldout: false, ...(partial ? { partial: true } : {}) });
const sumW = (cfg: typeof MASTERY_V1, partial: boolean) => computeGroups([row("a", partial)], new Map(), AS_OF, cfg)[0]!.components;

describe("partly right answers (mastery-v3 only)", () => {
  it("count at partialWeight in v3, as plain successes in v1 and v2, and never as AI-checked", () => {
    const full = sumW(MASTERY_V3, false);
    const part = sumW(MASTERY_V3, true);
    expect(part.sumW).toBeCloseTo(full.sumW * MASTERY_V3.partialWeight!, 12);
    expect(part.aiCheckedN).toBeUndefined();
    expect(sumW(MASTERY_V1, true)).toEqual(sumW(MASTERY_V1, false));
    expect(sumW(MASTERY_V2, true)).toEqual(sumW(MASTERY_V2, false));
  });
  it("v3 without partial evidence gives the same numbers as v2", () => {
    expect(computeComponents([{ id: "a", at: "2026-11-01T01:00:00.000Z", localDate: "2026-11-01", success: true, heldout: false, delayedProbe: false }], AS_OF, MASTERY_V3)).toEqual(
      computeComponents([{ id: "a", at: "2026-11-01T01:00:00.000Z", localDate: "2026-11-01", success: true, heldout: false, delayedProbe: false }], AS_OF, MASTERY_V2),
    );
  });
});
