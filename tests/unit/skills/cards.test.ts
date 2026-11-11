import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalCards, displayName, validateCards } from "../../../apps/server/src/domain/skills/cards.js";
import { skillCards } from "../../../apps/server/src/domain/content/batches/draftFormats.js";

const root = path.resolve(__dirname, "../../..");
const read = (...p: string[]) => JSON.parse(readFileSync(path.join(root, ...p), "utf8"));
const v1 = read("content", "taxonomy", "skill-cards-v1.json").cards as Record<string, unknown>;
const v2 = read("content", "taxonomy", "skill-cards-v2-extra.json").cards as Record<string, unknown>;
const taxonomy = (read("content", "taxonomy", "taxonomy-v2.json").skills as Array<{ id: string }>).map((s) => s.id);

describe("canonical skill cards (TASK_032, D140-D142)", () => {
  const cards = canonicalCards().skills;
  it("keeps all 82 earlier cards byte-for-byte equal to the frozen snapshots", () => {
    for (const [id, c] of Object.entries({ ...v1, ...v2 })) {
      const s = cards[id]!;
      expect({ rule: s.rule, good: s.good, wrong: s.wrong }).toEqual(c);
    }
  });
  it("covers every taxonomy-v2 skill and marks exactly those as inTaxonomy", () => {
    expect(Object.keys(cards).filter((k) => cards[k]!.inTaxonomy).sort()).toEqual([...taxonomy].sort());
    expect(Object.keys(cards).length).toBeGreaterThan(taxonomy.length);
  });
  it("the grammar generator still sees exactly the earlier skill sets", () => {
    expect(Object.keys(skillCards("generation-v9")).sort()).toEqual(Object.keys(v1).sort());
    expect(Object.keys(skillCards("generation-v10")).sort()).toEqual(Object.keys({ ...v1, ...v2 }).sort());
  });
  it("keeps the labels of the grammar Practice (skillLabels.json is derived)", () => {
    const labels = read("apps", "web", "src", "skillLabels.json") as Record<string, { en: string; ru: string }>;
    const derived = Object.fromEntries(Object.entries(cards).filter(([, s]) => s.since === "taxonomy-v1").map(([id, s]) => [id, { en: s.displayName, ru: s.displayNameRu }]));
    expect(labels).toEqual(derived);
  });
  it("names skills in English, with General Grammar as the fallback", () => {
    expect(displayName("modals.polite_requests")).toBe("Polite requests with modals");
    expect(displayName(null)).toBe("General Grammar");
  });
  it("rejects malformed cards", () => {
    const bad = JSON.parse(JSON.stringify(canonicalCards()));
    bad.skills["modals.advice"].good = [];
    expect(() => validateCards(bad)).toThrow(/good/);
    const bad2 = JSON.parse(JSON.stringify(canonicalCards()));
    bad2.skills["x.y"] = { ...bad2.skills["modals.advice"], family: "z" };
    expect(() => validateCards(bad2)).toThrow(/family/);
  });
});
