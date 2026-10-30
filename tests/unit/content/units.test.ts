import { describe, expect, it } from "vitest";
import { BLANK, NEAR_DUPLICATE_THRESHOLD, canonicalJson, contentHashOf, fingerprintOf, isSentenceUnit, jaccard, normalizeSentence, splitSentences, trigrams } from "../../../apps/server/src/domain/content/normalize.js";
import { extractUnits } from "../../../apps/server/src/domain/content/units.js";
import { fixture } from "../../fixtures/exercises/load.js";

describe("norm-v1 (spec/04)", () => {
  it("folds case, whitespace, typographic quotes/dashes and Unicode form", () => {
    const a = normalizeSentence("  The  organiser’s “plan” – it works.  ");
    expect(a).toBe('the organiser\'s "plan" - it works');
    expect(normalizeSentence("The organiser's \"plan\" - it works!")).toBe(a);
    expect(normalizeSentence("Ｔhe cat")).toBe("the cat"); // full-width T, NFKC
  });

  it("removes terminal punctuation only", () => {
    expect(normalizeSentence("Is it ready?!")).toBe("is it ready");
    expect(normalizeSentence("Wait…")).toBe("wait");
    expect(normalizeSentence("He said 'no. Never.' again.")).toBe("he said 'no. never.' again");
  });

  it("never erases negation, numbers or articles", () => {
    expect(normalizeSentence("They did not go.")).not.toBe(normalizeSentence("They did go."));
    expect(normalizeSentence("I have 2 tickets.")).not.toBe(normalizeSentence("I have 3 tickets."));
    expect(normalizeSentence("She bought a car.")).not.toBe(normalizeSentence("She bought the car."));
    expect(fingerprintOf(normalizeSentence("She bought a car."))).not.toBe(fingerprintOf(normalizeSentence("She bought the car.")));
  });

  it("gives blanks one stable marker", () => {
    const n = normalizeSentence("The council ___ the timetable.");
    expect(n).toContain(BLANK.toLowerCase());
    expect(normalizeSentence("The council ______ the timetable")).toBe(n);
    expect(normalizeSentence("The council [blank] the timetable")).toBe(n);
  });

  it("only full sentences (>= 3 words) count as units: fragments never do", () => {
    for (const frag of ["to", "has published", "in the"]) expect(isSentenceUnit(normalizeSentence(frag))).toBe(frag === "in the" ? false : false);
    expect(isSentenceUnit(normalizeSentence("She left early."))).toBe(true);
  });

  it("canonical JSON and content hash ignore key order", () => {
    expect(canonicalJson({ b: [1, { z: 1, a: 2 }], a: null })).toBe('{"a":null,"b":[1,{"a":2,"z":1}]}');
    expect(contentHashOf({ a: 1, b: 2 })).toBe(contentHashOf({ b: 2, a: 1 }));
  });

  it("splits running text into sentences", () => {
    expect(splitSentences("It rained. We stayed in! Did you go?  Yes.")).toEqual(["It rained.", "We stayed in!", "Did you go?", "Yes."]);
  });

  it("near duplicates: token-trigram Jaccard, threshold .80", () => {
    const a = trigrams(normalizeSentence("The council published the revised timetable on Monday morning before the meeting."));
    const nearly = trigrams(normalizeSentence("The council published the revised timetable on Monday morning before the meeting started."));
    const different = trigrams(normalizeSentence("Several residents complained about the noise from the new building site."));
    expect(jaccard(a, nearly)).toBeGreaterThanOrEqual(NEAR_DUPLICATE_THRESHOLD);
    expect(jaccard(a, different)).toBeLessThan(0.1);
    expect(jaccard(a, a)).toBe(1);
  });
});

describe("sentence units per format (spec/04 + spec/05 invariant 7)", () => {
  const byRole = (name: Parameters<typeof fixture>[0]) => {
    const e = fixture(name);
    return extractUnits({ type: e.type, prompt_en: e.prompt_en, payload: e.payload });
  };

  it("blank tasks: the whole prompt with a BLANK marker plus the sentence restored from the accepted fragment; options are fragments", () => {
    const u = byRole("choose_form");
    expect(u.map((x) => [x.role, x.text])).toEqual([
      ["prompt", `the council ${BLANK.toLowerCase()} the revised timetable yesterday`],
      ["answer", "the council published the revised timetable yesterday"],
    ]);
    const m = byRole("choose_missing_fragment");
    expect(m.find((x) => x.role === "answer")!.text).toBe("the organiser asked us to listen to the safety announcement before entering the site");
    expect(m.filter((x) => x.role === "option")).toEqual([]); // "to", "for", "at" are not sentences
  });

  it("only ACCEPTED fragments are restored; a distractor-filled sentence is not registered as seen", () => {
    const texts = byRole("choose_form").map((x) => x.text);
    expect(texts.some((t) => t.includes("has published"))).toBe(false);
  });

  it("detect_error: the sentence and corrections; the instruction prompt is not a unit", () => {
    const u = byRole("detect_error");
    expect(u.map((x) => x.role)).toEqual(["prompt", "answer"]);
    expect(u[0]!.text).toBe("he suggested to go to the beach after work");
    expect(byRole("detect_error_no_mistake").map((x) => x.role)).toEqual(["prompt"]);
  });

  it("short answers: each approved alternative is an answer unit; the Russian cue is never a unit", () => {
    const u = byRole("guided_short_answer");
    expect(u.map((x) => x.role)).toEqual(["answer", "answer"]);
    expect(u.every((x) => !/[Ѐ-ӿ]/.test(x.text))).toBe(true);
    expect(byRole("russian_to_english_short")).toHaveLength(2);
  });

  it("reading: passage sentences, question prompts and full-sentence options; each passage sentence is its own unit", () => {
    const u = byRole("context_reading");
    expect(u.filter((x) => x.role === "passage")).toHaveLength(4); // 2 sentences in each of 2 paragraphs
    expect(u.filter((x) => x.role === "prompt")).toHaveLength(3);
    expect(u.filter((x) => x.role === "option").length).toBeGreaterThanOrEqual(5);
  });

  it("a whole-sentence option counts, a repeated unit inside one role is one unit", () => {
    const e = fixture("choose_form");
    e.prompt_en = "Which sentence is correct?"; // no blank: instruction only
    e.payload.options = [{ id: "a", text: "The council published the timetable." }, { id: "b", text: "The council publish the timetable." }, { id: "c", text: "The council published the timetable!" }];
    e.payload.accepted_option_ids = ["a"];
    const u = extractUnits({ type: e.type, prompt_en: e.prompt_en, payload: e.payload });
    expect(u.filter((x) => x.role === "option")).toHaveLength(2); // a and c normalise to the same sentence
    expect(u.some((x) => x.role === "prompt")).toBe(false);
  });

  it("fingerprints do not depend on typography", () => {
    const e = fixture("detect_error");
    const plain = extractUnits({ type: e.type, prompt_en: e.prompt_en, payload: e.payload });
    e.payload.sentence = "He  suggested to go to the beach after work!";
    const typo = extractUnits({ type: e.type, prompt_en: e.prompt_en, payload: e.payload });
    expect(typo[0]!.fingerprint).toBe(plain[0]!.fingerprint);
  });
});
