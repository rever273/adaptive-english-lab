import { describe, expect, it } from "vitest";
import { hintFocus, markTyped } from "../../../apps/web/src/game/dictationMarks.js";
import { isCorrect } from "../../../apps/server/src/domain/typing/dictation/check.js";

const E = "You should stop using that old software today.";
const red = (typed: string) => markTyped(typed, E).filter((s) => s.wrong).map((s) => s.text);

describe("marking wrong words while typing", () => {
  it("marks nothing for a correct beginning, even with the last word unfinished", () => {
    expect(red("You should stop us")).toEqual([]);
    expect(red("You should stop using that old software today")).toEqual([]);
  });
  it("marks a finished wrong word, not the right ones", () => {
    expect(red("You would stop using")).toEqual(["would"]);
    expect(red("You should stap using that")).toEqual(["stap"]);
  });
  it("marks the word being typed only when it cannot become the next word", () => {
    expect(red("You should sx")).toEqual(["sx"]);
    expect(red("You should st")).toEqual([]);
  });
  it("marks an extra word and Russian-layout letters", () => {
    expect(red("You should really stop")).toEqual(["really"]);
    expect(red("You shoЫld")).toContain("Ы");
    expect(markTyped("Привет", E).every((s) => s.wrong)).toBe(true);
  });
  it("does not mind capitals, final punctuation or regional spelling", () => {
    expect(red("you SHOULD stop using that old software today.")).toEqual([]);
    expect(markTyped("my favourite colour", "my favorite color").some((s) => s.wrong)).toBe(false);
  });
  it("accepts an answer without the final full stop", () => {
    expect(isCorrect(E, "You should stop using that old software today")).toBe(true);
    expect(isCorrect(E, "you should stop using that old software today!")).toBe(true);
  });
  it("a contraction is not a mistake, and after Enter the last word counts as finished", () => {
    expect(markTyped("I am sure it is fine", "I'm sure it's fine", true).some((x) => x.wrong)).toBe(false);
    expect(markTyped("You should stop usin", E, true).filter((x) => x.wrong).map((x) => x.text)).toEqual(["usin"]);
    expect(markTyped("You should stop usin", E).some((x) => x.wrong)).toBe(false);
  });
  it("finds the word a hint is about", () => {
    expect(hintFocus([{ text: "You" }, { text: "should" }, { text: null }])).toBe(1);
    expect(hintFocus([{ text: null }])).toBeNull();
  });
});
