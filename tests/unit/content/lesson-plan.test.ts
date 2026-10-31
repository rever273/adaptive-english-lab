import { describe, expect, it } from "vitest";
import { groupUnits, planFromDeficits, type LessonDemand } from "../../../apps/server/src/domain/content/batches/plan.js";
import { lessonLabel, rangeLabel, withMargin } from "../../../apps/server/src/domain/content/batches/lessonNeeds.js";

const L = (key: string, formatDeficit: LessonDemand["formatDeficit"], capacity: number, skills = [`prepositions.${key}`, `articles.${key}`, `agreement.${key}`]): LessonDemand => ({ key, formatDeficit, skills, capacity });
const byLesson = (items: ReturnType<typeof planFromDeficits>) => items.reduce<Record<string, number>>((m, i) => ({ ...m, [i.lesson!]: (m[i.lesson!] ?? 0) + 1 }), {});
const byType = (items: ReturnType<typeof planFromDeficits>) => items.reduce<Record<string, number>>((m, i) => ({ ...m, [i.type]: (m[i.type] ?? 0) + 1 }), {});

describe("replenishment sizing (D68)", () => {
  it("the recommended size is the deficit plus 20%, rounded up; nothing missing recommends nothing", () => {
    expect(withMargin(10)).toBe(12);
    expect(withMargin(11)).toBe(14); // 13.2
    expect(withMargin(1)).toBe(2);
    expect(withMargin(0)).toBe(0);
  });
  it("labels the lesson and the level range for the notice", () => {
    expect(lessonLabel("first10-l01", "x")).toBe("L01");
    expect(lessonLabel("first10-l10", "x")).toBe("L10");
    expect(lessonLabel("custom", "My lesson")).toBe("My lesson");
    expect(rangeLabel(["B1", "B2", "C1"])).toBe("B1-C1");
    expect(rangeLabel(["B2"])).toBe("B2");
    expect(rangeLabel(null)).toBe("all levels");
  });
});

describe("planFromDeficits", () => {
  const lessons = [L("l01", { detect_error: 4, guided_short_answer: 1, choose_form: 5 }, 12), L("l02", { choose_form: 6, russian_to_english_short: 4 }, 12), L("l03", { detect_error: 8 }, 10)];

  it("a batch of exactly the recommended size serves only the next lesson, weighted by its deficits", () => {
    const items = planFromDeficits({ count: 12, lessons, tag: "t" });
    expect(items).toHaveLength(12);
    expect(byLesson(items)).toEqual({ l01: 12 });
    expect(byType(items)).toEqual({ detect_error: 5, guided_short_answer: 1, choose_form: 6 }); // 4:1:5 scaled to 12
    expect(items.every((i) => lessons[0]!.skills.includes(i.target_skill))).toBe(true); // only the lesson skill pool
    expect(items.map((i) => i.ordinal)).toEqual(items.map((_, i) => i));
  });

  it("extra items go to the following lessons' deficits in lesson order", () => {
    const items = planFromDeficits({ count: 30, lessons, tag: "t" });
    expect(items).toHaveLength(30);
    expect(byLesson(items)).toEqual({ l01: 12, l02: 12, l03: 6 });
    const l02 = items.filter((i) => i.lesson === "l02");
    expect(new Set(l02.map((i) => i.type))).toEqual(new Set(["choose_form", "russian_to_english_short"]));
    expect(l02.every((i) => lessons[1]!.skills.includes(i.target_skill))).toBe(true);
  });

  it("beyond every capacity the rest is spread over the visited pools, formats evenly", () => {
    const items = planFromDeficits({ count: 40, lessons, tag: "t" });
    expect(items).toHaveLength(40);
    expect(Object.keys(byLesson(items)).sort()).toEqual(["l01", "l02", "l03"]);
    expect(Object.keys(byType(items)).length).toBeGreaterThan(3);
  });

  it("is deterministic, keeps one skill per inference unit and marks every 4th detect_error as a No-mistake case", () => {
    const a = planFromDeficits({ count: 30, lessons, tag: "t" });
    expect(planFromDeficits({ count: 30, lessons, tag: "t" })).toEqual(a);
    for (const unit of groupUnits(a)) expect(new Set(unit.map((p) => p.target_skill)).size).toBe(1);
    const detect = a.filter((i) => i.type === "detect_error");
    expect(detect.filter((i) => i.noMistake)).toHaveLength(Math.floor(detect.length / 4));
  });

  it("a format the lesson skills cannot carry is not planned (fragments need preposition/article-like skills)", () => {
    const only = [L("l09", { choose_missing_fragment: 5, detect_error: 5 }, 10, ["agreement.be_auxiliary", "questions.embedded_order"])];
    const items = planFromDeficits({ count: 10, lessons: only, tag: "t" });
    expect(byType(items)).toEqual({ detect_error: 10 });
  });

  it("respects an explicit format filter", () => {
    const items = planFromDeficits({ count: 12, lessons, types: ["choose_form"], tag: "t" });
    expect(byType(items)).toEqual({ choose_form: 12 });
  });
});
