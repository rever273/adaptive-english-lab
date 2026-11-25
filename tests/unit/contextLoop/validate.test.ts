import { describe, expect, it } from "vitest";
import { checkDraft, targetOf } from "../../../apps/server/src/domain/contextLoop/validate.js";

const sense = (over: Partial<{ synonyms: string[]; surfaceForms: string[]; irregularForms: string[]; pos: string }> = {}) => ({ translationRu: "неохотный", definitionRu: "", pos: "adjective", synonyms: ["unwilling", "hesitant"], surfaceForms: [], irregularForms: [], ...over });
const reluctant = targetOf("e1", "reluctant", sense());
const d = (text: string, target_surface = "reluctant", extra: Record<string, unknown> = {}) => ({ text, target_surface, context_label: "work", difficulty: "easy", ...extra });

describe("Context Loop code checks", () => {
  it("accepts a plain sentence and finds the target itself", () => {
    const r = checkDraft(d("She was reluctant to sign the contract."), reluctant);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.sentence).toMatchObject({ targetStart: 8, targetLength: 9, targetSurface: "reluctant", fingerprint: expect.any(String) });
  });

  it("finds inflected forms and irregular forms, and requires target_surface to match", () => {
    const rely = targetOf("e2", "rely on", sense({ synonyms: [], pos: "phrasal verb" }));
    expect(checkDraft(d("We relied on the old map all day.", "relied on"), rely).ok).toBe(true);
    const go = targetOf("e3", "overcome", sense({ synonyms: [], irregularForms: ["overcame"] }));
    expect(checkDraft(d("She overcame her fear of flying.", "overcame"), go).ok).toBe(true);
    expect(checkDraft(d("She overcame her fear of flying.", "overcome"), go)).toMatchObject({ ok: false, code: "TARGET_SURFACE" });
  });

  it("refuses a missing or repeated target, a synonym, wrong length, Cyrillic, blanks and bad fields", () => {
    expect(checkDraft(d("She did not want to sign it."), reluctant)).toMatchObject({ ok: false, code: "TARGET_MISSING" });
    expect(checkDraft(d("A reluctant man met a reluctant woman."), reluctant)).toMatchObject({ ok: false, code: "TARGET_TWICE" });
    expect(checkDraft(d("He was reluctant and unwilling to go."), reluctant)).toMatchObject({ ok: false, code: "SYNONYM" });
    expect(checkDraft(d("Reluctant."), reluctant)).toMatchObject({ ok: false, code: "SENTENCE" });
    expect(checkDraft(d("She was reluctant to sign the very long and complicated contract from the new bank today."), reluctant)).toMatchObject({ ok: false, code: "SENTENCE" });
    expect(checkDraft(d("Она была reluctant to sign it."), reluctant)).toMatchObject({ ok: false, code: "SENTENCE" });
    expect(checkDraft(d("She was ___ to sign it."), reluctant)).toMatchObject({ ok: false });
    expect(checkDraft(d("She was reluctant to sign it", "reluctant"), reluctant)).toMatchObject({ ok: false, code: "SENTENCE" }); // no final stop
    expect(checkDraft(d("She was reluctant to sign it.", "reluctant", { difficulty: "hard" }), reluctant)).toMatchObject({ ok: false, code: "DIFFICULTY" });
    expect(checkDraft(d("She was reluctant to sign it.", "reluctant", { context_label: " " }), reluctant)).toMatchObject({ ok: false, code: "CONTEXT_LABEL" });
  });

  it("keeps a Russian translation, allows none, and refuses one that is not Russian", () => {
    const ok = checkDraft(d("She was reluctant to sign it.", "reluctant", { translation_ru: "  Она  не хотела это подписывать. " }), reluctant);
    expect(ok.ok && ok.sentence.translationRu).toBe("Она не хотела это подписывать.");
    const none = checkDraft(d("She was reluctant to sign it."), reluctant);
    expect(none.ok && none.sentence.translationRu).toBeNull();
    for (const bad of ["She was reluctant to sign it.", "Ona ne hotela.", 42, "Она\nне хотела.", "Я".repeat(401)]) {
      expect(checkDraft(d("She was reluctant to sign it.", "reluctant", { translation_ru: bad }), reluctant)).toMatchObject({ ok: false, code: "TRANSLATION" });
    }
  });
});
