import { describe, expect, it } from "vitest";
import { blankOut, matchForms } from "../../../apps/server/src/domain/vocabulary/forms.js";

describe("the example sentence with the word hidden", () => {
  it("blanks every form of the word and nothing else", () => {
    const forms = matchForms("harsh", []);
    expect(blankOut("The harsh wind was harsh again, not harsher.", forms)).toBe("The ____ wind was ____ again, not harsher."); // only listed forms
    expect(blankOut("It was a marshy place.", forms)).toBeNull(); // "harsh" inside another word is not the word
    expect(blankOut("Rely on me, he relied on her.", matchForms("rely", ["relied"]))).toBe("____ on me, he ____ on her.");
    expect(blankOut("Nothing here.", [])).toBeNull();
  });
  it("is case-insensitive and keeps the punctuation", () => {
    expect(blankOut("Gentle rain, gentle wind.", matchForms("gentle", []))).toBe("____ rain, ____ wind.");
  });
});
