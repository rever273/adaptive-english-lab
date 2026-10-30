import { describe, expect, it } from "vitest";
import { bankTexts, countOccurrences, isValidWord, matchForms, normalizeWord, regularForms, shownTexts } from "../../../apps/server/src/domain/vocabulary/forms.js";

describe("saved-word matching is plain and explainable", () => {
  it("normalises what the learner selected", () => {
    expect(normalizeWord("  Library. ")).toBe("library");
    expect(normalizeWord("“Stopped”")).toBe("stopped");
    expect(normalizeWord("Don’t")).toBe("don't");
    expect(isValidWord("take a break")).toBe(true);
    expect(isValidWord("well-known")).toBe(true);
    expect(isValidWord("one two three four five")).toBe(false);
    expect(isValidWord("42")).toBe(false);
    expect(isValidWord("")).toBe(false);
    expect(isValidWord("rm -rf /")).toBe(false);
  });

  it("regular endings only: -s -es -ed -d -ing, y->ies/ied, silent e, doubled consonant", () => {
    expect(regularForms("walk").sort()).toEqual(["walk", "walked", "walking", "walks"]);
    expect(regularForms("stop")).toEqual(expect.arrayContaining(["stop", "stops", "stopped", "stopping"]));
    expect(regularForms("make")).toEqual(expect.arrayContaining(["makes", "maked", "making"]));
    expect(regularForms("study")).toEqual(expect.arrayContaining(["studies", "studied", "studying"]));
    expect(regularForms("watch")).toEqual(expect.arrayContaining(["watches"]));
    expect(regularForms("take a break")).toEqual(expect.arrayContaining(["take a breaks"])); // a phrase inflects its last word only
    expect(regularForms("go")).not.toContain("went"); // irregular forms are only found when the learner saved them
    expect(matchForms("go", ["went"])).toContain("went");
  });

  it("counts whole words only, case-insensitively, never inside other words", () => {
    const f = matchForms("stop", ["stopped"]);
    expect(countOccurrences("He stopped smoking. Stop it! We were stopping.", f)).toBe(3);
    expect(countOccurrences("A stopover at the bus stop is not a stoppage.", matchForms("stop", []))).toBe(1); // only "stop" in "bus stop"
    expect(countOccurrences("The cat sat.", matchForms("cat", []))).toBe(1);
    expect(countOccurrences("concatenate", matchForms("cat", []))).toBe(0);
    expect(countOccurrences("Don’t stop", matchForms("don't", []))).toBe(1); // curly apostrophe
    expect(countOccurrences("a take  a break today", matchForms("take a break", []))).toBe(1);
    expect(countOccurrences("anything", [])).toBe(0);
  });

  it("shown text excludes accepted answers; bank text includes them (what is displayed vs what is in the bank)", () => {
    const guided = { prompt_en: "Complete the sentence, starting with: The new library...", payload: { cue_ru: "Новую библиотеку открыл мэр", accepted_answers: ["The new library was opened by the mayor."] } };
    expect(shownTexts(guided, "guided_short_answer", null).join(" ")).not.toContain("opened");
    expect(bankTexts(guided, "guided_short_answer").join(" ")).toContain("opened");
    const reading = { prompt_en: "Read.", payload: { paragraphs: ["The festival was postponed."], questions: [{ id: "q1", prompt: "Why?", options: [{ text: "heat" }] }, { id: "q2", prompt: "Who?", options: [{ text: "council" }] }] } };
    expect(shownTexts(reading, "context_reading", "q1").join(" ")).toContain("heat");
    expect(shownTexts(reading, "context_reading", "q1").join(" ")).not.toContain("council"); // only the question of this slot
    expect(shownTexts(reading, "context_reading", "q1").join(" ")).toContain("postponed");
  });
});
