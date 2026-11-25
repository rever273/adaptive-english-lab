import { describe, expect, it } from "vitest";
import { buildFormIndex, formsOf, matchSentence, tokenize, type PoolWord } from "../../../apps/server/src/domain/vocabTyping/matching.js";

const w = (lemma: string, pos = "noun", past: string[] = [], participle: string[] = []): PoolWord => ({ lemma, pos, past, participle });
const POOL: PoolWord[] = [
  w("achieve", "verb"),
  w("run", "verb", ["ran"], ["run"]),
  w("go", "verb", ["went"], ["gone"]),
  w("see", "verb", ["saw"], ["seen"]),
  w("saw", "noun"),
  w("big", "adjective"),
  w("nice", "adjective"),
  w("happy", "adjective"),
  w("good", "adjective"),
  w("man"),
  w("child"),
  w("study", "verb"),
  w("be", "verb", ["was", "were"], ["been"]),
];
const index = buildFormIndex(POOL);
const m = (text: string) => matchSentence(text, index);

describe("lemma to sentence matching (vt-match-v1)", () => {
  it("finds regular forms and gives the exact span of the surface form", () => {
    for (const [text, surface] of [["They achieve a lot.", "achieve"], ["She achieved her goal.", "achieved"], ["We are achieving more.", "achieving"], ["He achieves little.", "achieves"]] as const) {
      const hit = m(text).find((x) => x.lemma === "achieve")!;
      expect(hit.surface).toBe(surface);
      expect(text.slice(hit.start, hit.start + hit.length)).toBe(surface);
    }
  });

  it("run / ran / running match; runner does not", () => {
    for (const text of ["I run every day.", "I ran home.", "He is running late.", "She runs fast."]) expect(m(text).map((x) => x.lemma)).toContain("run");
    expect(m("The runner was tired.").map((x) => x.lemma)).not.toContain("run");
  });

  it("go / went / gone match; ongoing does not", () => {
    for (const text of ["We go home.", "We went home.", "They have gone away.", "He goes out."]) expect(m(text).map((x) => x.lemma)).toContain("go");
    expect(m("The ongoing war ended.").map((x) => x.lemma)).not.toContain("go");
    expect(m("Going home now.").map((x) => x.lemma)).toContain("go");
  });

  it("is case-insensitive at the start of a sentence, but a capitalised word inside is a name", () => {
    expect(m("Run for your life.")[0]).toMatchObject({ lemma: "run", start: 0, surface: "Run" });
    expect(m("My friend Big came.").map((x) => x.lemma)).not.toContain("big");
    expect(m("He is big.").map((x) => x.lemma)).toContain("big");
  });

  it("knows adjective degrees, irregular plurals and the verb be", () => {
    expect(m("This is bigger than that.").map((x) => x.lemma)).toContain("big");
    expect(m("She is the happiest girl.").map((x) => x.lemma)).toContain("happy");
    expect(m("It was nicer there.").map((x) => x.lemma)).toContain("nice");
    expect(m("This is better.").map((x) => x.lemma)).toContain("good");
    expect(m("Two men came.").map((x) => x.lemma)).toContain("man");
    expect(m("The children played.").map((x) => x.lemma)).toContain("child");
    expect(m("They were here.").map((x) => x.lemma)).toContain("be");
    expect(m("He studies hard.").map((x) => x.lemma)).toContain("study");
  });

  it("marks a spelling that belongs to two pool words as ambiguous for both", () => {
    const hits = m("I saw a dog.");
    expect(hits.map((x) => x.lemma).sort()).toEqual(["saw", "see"]);
    expect(hits.every((x) => x.ambiguous)).toBe(true);
    expect(m("I see a dog.")[0]).toMatchObject({ lemma: "see", ambiguous: false });
  });

  it("drops a word that occurs twice, because a gap would leave the answer in the sentence", () => {
    expect(m("Run and run again.").map((x) => x.lemma)).not.toContain("run");
  });

  it("tokenises contractions as one word and keeps offsets", () => {
    const t = tokenize("Don't go, it's late.");
    expect(t.map((x) => x.text)).toEqual(["Don't", "go", "it's", "late"]);
    expect(t[1]).toMatchObject({ start: 6, length: 2 });
  });

  it("a lemma named like an Object member is an ordinary word", () => {
    expect(() => buildFormIndex([w("constructor"), w("toString"), w("valueOf")])).not.toThrow();
    expect(matchSentence("The constructor was tired today.", buildFormIndex([w("constructor")]))[0]).toMatchObject({ lemma: "constructor" });
  });

  it("generates only plain letter spellings", () => {
    expect(formsOf(w("study", "verb")).every((f) => /^[a-z]+$/.test(f))).toBe(true);
    expect(formsOf(w("nice", "adjective"))).toEqual(expect.arrayContaining(["nicer", "nicest"]));
  });
});
