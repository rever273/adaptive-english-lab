import { describe, expect, it } from "vitest";
import { pickVocabularyTopic, vocabularyTopicPool } from "../../../apps/server/src/domain/content/batches/vocabularyTopics.js";

describe("vocabulary topic pool", () => {
  it("includes the Audio Dictation topics next to the general settings", () => {
    const pool = vocabularyTopicPool();
    expect(pool.length).toBeGreaterThan(80);
    expect(pool).toContain("workplace");
    expect(pool).toContain("Space exploration");
    expect(new Set(pool.map((t) => t.toLowerCase())).size).toBe(pool.length);
  });
  it("is deterministic and spreads consecutive ordinals over different topics", () => {
    expect(pickVocabularyTopic(7, 0)).toBe(pickVocabularyTopic(7, 0));
    const first = Array.from({ length: 40 }, (_, i) => pickVocabularyTopic(i, 0));
    expect(new Set(first).size).toBe(40);
  });
});
