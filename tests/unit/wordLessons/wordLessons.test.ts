import { describe, expect, it } from "vitest";
import { lessonAnswerKey } from "../../../apps/server/src/domain/wordLessons/check.js";
import { buildPlan } from "../../../apps/server/src/domain/wordLessons/plan.js";
import { itemCredit, scoreRun, type ItemEvidence } from "../../../apps/server/src/domain/wordLessons/score.js";
import { rankCandidates, type EligibleWord } from "../../../apps/server/src/domain/wordLessons/selection.js";
import { blameSkills, replanAvoiding } from "../../../apps/server/src/domain/wordLessons/runner.js";
import { lostWords } from "../../../apps/server/src/domain/wordLessons/stages.js";
import { countTarget, findTarget, gapOut, isForm, isProperStart, lessonWord } from "../../../apps/server/src/domain/wordLessons/validate.js";
import { SettingsV1Schema } from "../../../packages/contracts/src/index.js";
import type { WordEvent } from "../../../apps/server/src/domain/vocabulary/schedule.js";

const at = (n: number) => new Date(Date.UTC(2026, 10, 1, 0, 0, n)).toISOString();
const item = (key: string, stage: 2 | 3 | 4 | 5, attempts: ItemEvidence["attempts"], events: ItemEvidence["events"] = []): ItemEvidence => ({ key, stage, attempts, events });

describe("word-lesson-score-v1", () => {
  it("gives full credit only to an unaided first answer", () => {
    expect(itemCredit(item("s2", 2, [{ at: at(1), verdict: "correct" }])).credit).toBe(1);
    expect(itemCredit(item("s3.1", 3, [{ at: at(1), verdict: "incorrect" }, { at: at(5), verdict: "correct" }])).credit).toBe(0.6);
  });
  it("lowers credit for hints opened before the accepted answer, and for the full answer more than for a part", () => {
    const ok = [{ at: at(10), verdict: "correct" as const }];
    expect(itemCredit(item("s3.1", 3, ok, [{ at: at(2), kind: "hint_partial" }])).credit).toBe(0.6);
    expect(itemCredit(item("s3.1", 3, ok, [{ at: at(2), kind: "hint_partial" }, { at: at(3), kind: "hint_full" }])).credit).toBe(0.2);
    expect(itemCredit(item("s3.1", 3, ok, [{ at: at(2), kind: "translation" }])).credit).toBe(0.9);
    expect(itemCredit(item("s2", 2, ok, [{ at: at(2), kind: "hint_word" }])).credit).toBe(0.2);
    expect(itemCredit(item("s5", 5, ok, [{ at: at(2), kind: "hint_start" }])).credit).toBe(0.5);
    // a hint opened AFTER the right answer changes nothing
    expect(itemCredit(item("s3.1", 3, ok, [{ at: at(20), kind: "hint_full" }])).credit).toBe(1);
  });
  it("completion is not performance: continuing after feedback earns almost nothing, a dispute or an unchecked answer half", () => {
    expect(itemCredit(item("s4", 4, [{ at: at(1), verdict: "incorrect" }], [{ at: at(2), kind: "continue" }])).credit).toBe(0.1);
    expect(itemCredit(item("s4", 4, [{ at: at(1), verdict: "disputed" }], [{ at: at(2), kind: "continue" }])).credit).toBe(0.5);
    expect(itemCredit(item("s5", 5, [{ at: at(1), verdict: "unresolved" }], [{ at: at(2), kind: "continue" }])).credit).toBe(0.5);
    expect(itemCredit(item("s5", 5, [{ at: at(1), verdict: "unresolved" }], [{ at: at(2), kind: "continue" }, { at: at(3), kind: "hint_start" }])).credit).toBe(0.5);
  });
  it("weights 20/30/25/25, the passive stage carries no points, and a perfect run is 100", () => {
    const perfect = [item("s2", 2, [{ at: at(1), verdict: "correct" }]), item("s3.1", 3, [{ at: at(1), verdict: "correct" }]), item("s3.2", 3, [{ at: at(1), verdict: "correct" }]), item("s4", 4, [{ at: at(1), verdict: "correct" }]), item("s5", 5, [{ at: at(1), verdict: "correct" }])];
    const r = scoreRun(perfect);
    expect(r.score).toBe(100);
    expect(r.stages.map((s) => s.max)).toEqual([0, 20, 30, 25, 25]);
    expect(r.stages[0]).toMatchObject({ credit: null, points: 0 });
    const half = scoreRun([...perfect.slice(0, 1), item("s3.1", 3, [{ at: at(1), verdict: "correct" }]), item("s3.2", 3, [{ at: at(1), verdict: "incorrect" }], [{ at: at(2), kind: "continue" }]), ...perfect.slice(3)]);
    expect(half.score).toBe(87); // 20 + 30 * (1 + 0.1) / 2 + 25 + 25 = 86.5
  });
});

describe("candidates", () => {
  const w = (lemma: string, learned = false, createdAt = "2026-10-01T00:00:00Z"): EligibleWord => ({ entryId: lemma, lemma, learned, createdAt, translationRu: "x", surfaceForms: [], pos: "verb" });
  const ev = (outcome: WordEvent["outcome"], day: number): WordEvent => ({ at: new Date(Date.UTC(2026, 9, day)).toISOString(), outcome, revisionId: "r", slotId: "s" });
  it("puts missed words first, then helped, then never practised, then known ones by shortest streak; learned words last", () => {
    const events = new Map<string, WordEvent[]>([
      ["missed", [ev("success", 1), ev("miss", 20)]],
      ["helped", [ev("assisted", 20)]],
      ["strong", [ev("success", 1), ev("success", 5), ev("success", 9), ev("success", 14)]],
      ["fine", [ev("success", 1)]],
      ["knownmiss", [ev("miss", 10)]],
    ]);
    const ranked = rankCandidates([w("strong"), w("fresh"), w("helped"), w("fine"), w("missed"), w("knownmiss", true)], events, new Date("2026-10-28T00:00:00Z")).map((x) => x.lemma);
    expect(ranked).toEqual(["missed", "helped", "fresh", "fine", "strong", "knownmiss"]);
  });
  it("is deterministic: ties are broken by when the word was saved, then by spelling", () => {
    const a = rankCandidates([w("b", false, "2026-10-02"), w("a", false, "2026-10-02"), w("c", false, "2026-10-01")], new Map(), new Date());
    expect(a.map((x) => x.lemma)).toEqual(["c", "a", "b"]);
  });
});

describe("the word in a sentence", () => {
  const overlook = lessonWord("overlook", [], []);
  it("finds regular forms as whole words only", () => {
    expect(findTarget("She overlooked the mistake.", overlook)).toMatchObject({ form: "overlooked" });
    expect(countTarget("Do not overlook it, or you will overlook more.", overlook)).toBe(2);
    expect(findTarget("The overlooking tower is closed.", overlook)).toMatchObject({ form: "overlooking" });
    expect(findTarget("Overlooks happen.", overlook)).toMatchObject({ form: "Overlooks" });
    expect(isForm("overlooked", overlook)).toBe(true);
    expect(isForm("overlay", overlook)).toBe(false);
  });
  it("uses the irregular forms and keeps a phrasal verb's particle in place", () => {
    const go = lessonWord("give up", [], ["give", "gave", "given"]);
    expect(findTarget("He gave up smoking years ago.", go)).toMatchObject({ form: "gave up" });
    expect(findTarget("He gave smoking up.", go)).toBeNull();
    expect(lessonWord("take", [], ["take", "took", "taken"]).forms).toContain("took");
  });
  it("makes the gap only when the word occurs once", () => {
    expect(gapOut("Nobody wanted to overlook the neighbours.", overlook)).toBe("Nobody wanted to ___ the neighbours.");
    expect(gapOut("Do not overlook it and do not overlook that.", overlook)).toBeNull();
    expect(gapOut("Nothing here.", overlook)).toBeNull();
  });
  it("a partial hint is the start of the answer in whole words and at least two words shorter", () => {
    expect(isProperStart("If I had not overlooked", "If I had not overlooked the deadline, I would have finished.")).toBe(true);
    expect(isProperStart("If I had", "If I had")).toBe(false);
    expect(isProperStart("Something else", "If I had not overlooked the deadline")).toBe(false);
    expect(isProperStart("If I had not overlooked the", "If I had not overlooked the deadline")).toBe(false);
  });
});

describe("the fast path key", () => {
  it("ignores case, spaces, a final stop and the marks , ; : but keeps articles, tenses and order", () => {
    const k = lessonAnswerKey("If I had not overlooked the deadline, I would have finished.");
    expect(lessonAnswerKey("  if i HAD not overlooked the deadline I would   have finished ")).toBe(k);
    expect(lessonAnswerKey("If I had not overlooked a deadline, I would have finished.")).not.toBe(k);
    expect(lessonAnswerKey("If I had not overlook the deadline, I would have finished.")).not.toBe(k);
    expect(lessonAnswerKey("I would have finished if I had not overlooked the deadline.")).not.toBe(k);
    expect(lessonAnswerKey("I don’t know")).toBe(lessonAnswerKey("I do not know"));
  });
});

describe("planning", () => {
  const pool = { weak: [{ id: "passive.past", label: "Passive voice" }, { id: "questions.embedded_order", label: "embedded order" }], familiar: [{ id: "tenses.perfect_vs_past", label: "perfect vs past" }] };
  it("takes the weak skills for most tasks without repeating one, and never needs history", () => {
    const p = buildPlan({ difficultyMin: "B2", difficultyMax: "C1" }, pool, 0, 12345);
    expect(p.skills).toHaveLength(p.transformations + 1);
    expect(new Set(p.skills.map((s) => s.label)).size).toBe(p.skills.length);
    expect(p.skills.filter((s) => s.id === "passive.past" || s.id === "questions.embedded_order").length).toBe(Math.min(2, p.weakCount));
    expect(p.difficulty).toEqual({ min: "B2", max: "C1" });
    const bare = buildPlan({ difficultyMin: "B1", difficultyMax: "C1" }, { weak: [], familiar: [] }, 3, 99);
    expect(bare.skills.every((s) => s.id === null)).toBe(true);
    expect(bare.skills).toHaveLength(bare.transformations + 1);
  });
  it("draws different kinds of rewrite from a wide list, so lessons do not all get the same three tasks", () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) {
      const p = buildPlan({ difficultyMin: "B2", difficultyMax: "C1" }, { weak: [], familiar: [] }, seed, seed * 7919);
      const s3 = p.skills.slice(0, p.transformations).map((s) => s.label);
      expect(new Set(s3).size).toBe(s3.length);
      s3.forEach((l) => seen.add(l));
    }
    expect(seen.size).toBeGreaterThanOrEqual(10);
  });
  it("is reproducible from its seed", () => {
    expect(buildPlan({ difficultyMin: "B2", difficultyMax: "C1" }, pool, 2, 777)).toEqual(buildPlan({ difficultyMin: "B2", difficultyMax: "C1" }, pool, 2, 777));
  });
});

describe("settings stay readable", () => {
  const base = { schema_version: "settings-v1", taskCount: 18, weakRatio: 0.65, voiceTarget: 2, difficulty: "adaptive", explanation: "compact", vocabularyShare: 0.12, stockWarning: 3 };
  it("accepts a revision saved before the sixth daily mode", () => {
    expect(SettingsV1Schema.safeParse({ ...base, dailyOrder: ["grammar", "vocabulary", "words", "books", "dictation"], dailyMinutes: { grammar: 15, vocabulary: 10, words: 5, books: 10, dictation: 10 } }).success).toBe(true);
    expect(SettingsV1Schema.safeParse(base).success).toBe(true);
  });
  it("accepts the new mode and still rejects repeats and unknown modes", () => {
    expect(SettingsV1Schema.safeParse({ ...base, dailyOrder: ["wordLesson", "grammar", "vocabulary", "words", "books", "dictation"], dailyMinutes: { grammar: 15, vocabulary: 10, words: 5, books: 10, dictation: 10, wordLesson: 5 } }).success).toBe(true);
    expect(SettingsV1Schema.safeParse({ ...base, dailyOrder: ["grammar", "grammar", "words", "books", "dictation"] }).success).toBe(false);
    expect(SettingsV1Schema.safeParse({ ...base, dailyOrder: ["grammar", "vocabulary", "words", "books", "mystery"] }).success).toBe(false);
  });
});

describe("a transformation keeps the details of its source", () => {
  it("only words the construction accounts for may vanish", () => {
    // the case a learner met: "in her old job" disappeared
    expect(lostWords("She managed to cope with heavy workloads easily in her old job.", "She used to cope with heavy workloads easily.")).toEqual(["managed", "in", "old", "job"]);
    expect(lostWords("She managed to cope with heavy workloads easily in her old job.", "She used to cope with heavy workloads easily in her old job.")).toEqual(["managed"]);
    // tense, passive and embedded-question changes lose only auxiliaries, time words and the opening phrase
    expect(lostWords("The manager resolved the conflict yesterday.", "The manager has resolved the conflict.")).toEqual([]);
    expect(lostWords("We have coped with the technical issues so far.", "We coped with the technical issues yesterday.")).toEqual([]);
    expect(lostWords("Does the company offer a bonus?", "Could you tell me if the company offers a bonus?")).toEqual([]);
    expect(lostWords("I wonder what the trade-off is between battery life and weight.", "Could you tell me what the trade-off is between battery life and weight?")).toEqual([]);
    expect(lostWords("She overlooks small details when she is tired.", "Small details are overlooked by her when she is tired.")).toEqual([]);
    // a place, a thing or a reason may not vanish
    expect(lostWords("The inspector found a crack in the north wall.", "The inspector found a crack.")).toEqual(["in", "north", "wall"]);
  });
});

describe("a construction that made a try fail is swapped for a plain one", () => {
  const plan = { version: "word-lesson-plan-v1" as const, seed: 1, topics: [], difficulty: { min: "B1", max: "C1" }, transformations: 2 as const, weakCount: 1, skills: [{ id: "tenses.habitual_used_to", label: "habitual used to" }, { id: "questions.embedded_order", label: "embedded order" }, { id: "verb_patterns.would_rather", label: "would rather" }] };
  it("blames the tasks the checks complained about", () => {
    expect(blameSkills(plan, { stage3: ["t1: the Russian does not say the same"], stage4: ["b: invented"] }, "")).toEqual(["tenses.habitual_used_to", "verb_patterns.would_rather"]);
    expect(blameSkills(plan, undefined, "stage3 could not be written (T_SAME): item 2: expected_en must be visibly different")).toEqual(["questions.embedded_order"]);
    expect(blameSkills(plan, undefined, "stage4 could not be written (S4_HINT): x")).toEqual(["verb_patterns.would_rather"]);
  });
  it("replaces only the blamed skills, once each, and leaves the others", () => {
    const next = replanAvoiding(plan, new Set(["tenses.habitual_used_to", "verb_patterns.would_rather"]));
    expect(next.skills[1]).toEqual(plan.skills[1]);
    expect(next.skills[0]!.id).toBeNull();
    expect(next.skills[2]!.id).toBeNull();
    expect(new Set(next.skills.map((s) => s.label)).size).toBe(3);
    expect(replanAvoiding(plan, new Set())).toBe(plan);
  });
});

describe("phrasal verbs and function words (retry failures)", () => {
  it("accepts the whole irregular form of a phrasal verb", async () => {
    const { lessonWord, findTarget } = await import("../../../apps/server/src/domain/wordLessons/validate.js");
    const w = lessonWord("run into", [], ["run into", "ran into", "run into"]);
    expect(findTarget("I ran into my old teacher at the market.", w)).not.toBeNull();
    expect(lessonWord("come up with", [], ["come up with", "came up with"]).forms).toContain("came up with");
  });
  it("keeps indirect questions off conjunctions and the passive off phrasal verbs", async () => {
    const { unsuitableSkill } = await import("../../../apps/server/src/domain/wordLessons/runner.js");
    expect(unsuitableSkill({ id: "questions.embedded_order", label: "embedded order" }, "conjunction")).toBe(true);
    expect(unsuitableSkill({ id: null, label: "Passive voice" }, "phrasal verb")).toBe(true);
    expect(unsuitableSkill({ id: null, label: "Passive voice" }, "verb")).toBe(false);
  });
});
