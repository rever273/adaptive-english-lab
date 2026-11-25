import { describe, expect, it } from "vitest";
import type { ChatClient } from "../../../apps/server/src/domain/ai/clients.js";
import { CLEAN_PROMPT_VERSION, CLEAN_SYSTEM, cleanBatch, cleanUser, conservative, validateClean, validTranslation, type CleanWord } from "../../../apps/server/src/domain/vocabTyping/clean.js";

const w = (wordId: number, lemma: string, rank: number): CleanWord => ({ wordId, lemma, pos: "noun", translationRu: "перевод", definitionRu: "", transcription: "t", rank });
const batch = [w(1, "table", 400), w(2, "zorp", 9000), w(3, "may", 5000), w(4, "xyzzy", 12000)];
const answer = (decisions: unknown[]) => JSON.stringify({ decisions });
const item = (id: number, o: Record<string, unknown> = {}) => ({ id, decision: "keep", reason: "ordinary word", confidence: 0.95, primary_translation_ru: null, secondary_translations_ru: [], transcription_doubt: false, ...o });

describe("dictionary cleanup answer (vt-clean-v2)", () => {
  it("accepts a valid answer for every word", () => {
    const r = validateClean(answer(batch.map((b) => item(b.wordId))), batch);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.decisions.map((d) => d.lemma)).toEqual(["table", "zorp", "may", "xyzzy"]);
      expect(r.value.errors).toEqual([]);
    }
  });

  it("an answer that is not the expected shape is a validation failure (the call is repaired)", () => {
    expect(validateClean("not json", batch).ok).toBe(false);
    expect(validateClean(JSON.stringify({ result: [] }), batch).ok).toBe(false);
  });

  it("a bad item costs only its word, with a machine code, and the word is retried later", () => {
    const r = validateClean(
      answer([
        item(1),
        item(2, { decision: "delete" }),
        item(3, { confidence: 1.5 }),
        item(4, { primary_translation_ru: "a long English translation" }),
        item(99), // not in the batch: ignored
      ]),
      batch,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.decisions.map((d) => d.lemma)).toEqual(["table"]);
      expect(Object.fromEntries(r.value.errors.map((e) => [e.lemma, e.code]))).toEqual({ zorp: "bad_decision", may: "bad_confidence", xyzzy: "bad_translation" });
    }
  });

  it("a word the model left out, or answered twice, is an error", () => {
    const r = validateClean(answer([item(1), item(1), item(2)]), batch);
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.fromEntries(r.value.errors.map((e) => [e.lemma, e.code]))).toEqual({ table: "duplicate_id", may: "missing_word", xyzzy: "missing_word" });
  });

  it("a translation equal to the stored one is no change", () => {
    const r = validateClean(answer(batch.map((b) => item(b.wordId, { primary_translation_ru: b.wordId === 1 ? "Перевод" : "другой" }))), batch);
    if (r.ok) expect(r.value.decisions.map((d) => d.primaryTranslationRu)).toEqual([null, "другой", "другой", "другой"]);
  });

  it("checks translations: Cyrillic, short, one meaning, at most three more", () => {
    expect(validTranslation("стол")).toBe(true);
    expect(validTranslation("может быть")).toBe(true);
    expect(validTranslation("table")).toBe(false);
    expect(validTranslation("стол, стул, шкаф, лавка")).toBe(false);
    expect(validTranslation("а".repeat(61))).toBe(false);
    expect(validTranslation("")).toBe(false);
    const r = validateClean(answer([item(1, { secondary_translations_ru: ["один", "два", "три", "четыре"] }), item(2), item(3), item(4)]), batch);
    if (r.ok) expect(r.value.errors).toEqual([{ lemma: "table", code: "bad_translation" }]);
  });

  it("is conservative: a weak exclusion and any exclusion among the first 3000 words become needs_review", () => {
    expect(conservative({ decision: "exclude", confidence: 0.69 }, 9000)).toEqual({ decision: "needs_review", softened: true });
    expect(conservative({ decision: "exclude", confidence: 0.95 }, 3000)).toEqual({ decision: "needs_review", softened: true });
    expect(conservative({ decision: "exclude", confidence: 0.95 }, 3001)).toEqual({ decision: "exclude", softened: false });
    expect(conservative({ decision: "keep", confidence: 0.1 }, 10)).toEqual({ decision: "keep", softened: false });
    const r = validateClean(answer([item(1, { decision: "exclude", confidence: 0.99 }), item(2, { decision: "exclude", confidence: 0.99 }), item(3), item(4)]), batch);
    if (r.ok) expect(r.value.decisions.slice(0, 2).map((d) => [d.decision, d.softened])).toEqual([["needs_review", true], ["exclude", false]]);
  });

  it("the prompt keeps ordinary words that look like names and does not ask the model to fix the transcription", () => {
    expect(CLEAN_PROMPT_VERSION).toBe("vt-clean-v2");
    expect(CLEAN_SYSTEM).toMatch(/may, march, turkey/);
    expect(CLEAN_SYSTEM).toMatch(/Prefer it to "exclude"/);
    expect(CLEAN_SYSTEM).toMatch(/Do not correct the transcription/);
    expect(cleanUser(batch)).toContain('"word":"table"');
  });

  it("runs through the structured call: one repair for a broken answer, then the decisions", async () => {
    const replies = ["{broken", answer(batch.map((b) => item(b.wordId)))];
    const calls: string[] = [];
    const client: ChatClient = {
      async chat(req) {
        calls.push(req.messages.at(-1)!.content);
        return { text: replies.shift() ?? "", stats: { totalMs: 1, loadMs: null, promptTokens: null, evalTokens: null, evalMs: null } };
      },
    };
    const r = await cleanBatch(client, "gemma4:12b", batch);
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(2);
    const failing: ChatClient = { async chat() { return { text: "nope", stats: { totalMs: 1, loadMs: null, promptTokens: null, evalTokens: null, evalMs: null } }; } };
    expect((await cleanBatch(failing, "gemma4:12b", batch)).ok).toBe(false);
  });
});
