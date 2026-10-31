import { describe, expect, it } from "vitest";
import { VocabularyPracticeMetadataSchema, normaliseVocabularyAnswer } from "../../../packages/contracts/src/vocabulary-practice.js";

const target = { entryId: "entry-1", lemma: "resolve", senseId: "sense-verb", partOfSpeech: "verb", surfaceForm: "resolved" };
const options = [
  { id: "a", text: "resolved", rationaleRu: "Подходит по смыслу." },
  { id: "b", text: "reported", rationaleRu: "Не означает решение." },
  { id: "c", text: "investigated", rationaleRu: "Не означает решение." },
];

describe("vocabulary practice metadata", () => {
  it("requires a specific target sense and valid unique options", () => {
    const item = { schemaVersion: "vocabulary-practice-v1", family: "recognition", target, options, acceptedOptionId: "a" };
    expect(VocabularyPracticeMetadataSchema.safeParse(item).success).toBe(true);
    expect(VocabularyPracticeMetadataSchema.safeParse({ ...item, target: { ...target, senseId: "" } }).success).toBe(false);
    expect(VocabularyPracticeMetadataSchema.safeParse({ ...item, acceptedOptionId: "missing" }).success).toBe(false);
    expect(VocabularyPracticeMetadataSchema.safeParse({ ...item, options: [options[0], options[1], { ...options[2], text: " RESOLVED " }] }).success).toBe(false);
  });

  it("normalises case, whitespace and apostrophes without changing word forms", () => {
    expect(normaliseVocabularyAnswer("  Don’t   STOP ")).toBe("don't stop");
    expect(normaliseVocabularyAnswer("resolved")).not.toBe(normaliseVocabularyAnswer("resolve"));
  });

  it("rejects duplicate accepted alternatives after normalisation", () => {
    const item = { schemaVersion: "vocabulary-practice-v1", family: "guided_recall", target, guidedCue: "r", expectedWords: 1, acceptedAnswers: ["Resolved", " resolved "] };
    expect(VocabularyPracticeMetadataSchema.safeParse(item).success).toBe(false);
  });
});
