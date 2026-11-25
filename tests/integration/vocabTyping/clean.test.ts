import { afterEach, describe, expect, it } from "vitest";
import { applyDecisions, finishRun, revertRun, startRun, type CleanDecision } from "../../../apps/server/src/domain/vocabTyping/clean.js";
import { buildOverview } from "../../../apps/server/src/domain/vocabTyping/overview.js";
import { startScreening } from "../../../apps/server/src/domain/vocabTyping/sessions.js";
import { makeDeps, seedPool, setup, type Env } from "./fixtures.js";

let env: Env | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

const d = (lemma: string, decision: CleanDecision["decision"], o: Partial<CleanDecision> = {}): CleanDecision => ({ lemma, decision, reason: "test", confidence: 0.9, primaryTranslationRu: null, secondary: [], transcriptionDoubt: false, softened: false, ...o });
const eligibility = (db: Env["db"], lemma: string): string => (db.prepare("SELECT eligibility FROM vocab_typing_lexicon WHERE lemma = ?").get(lemma) as { eligibility: string }).eligibility;

describe("dictionary cleanup storage (D175, D184)", () => {
  it("appends decisions, follows the latest one in the lexicon, writes translations into the bank, archives excluded words and refuses a word-by-word revert", async () => {
    env = await setup();
    const { db } = env;
    const deps = makeDeps();
    const { lemmas } = seedPool(db, 40);
    const [a, b, c] = lemmas as [string, string, string];

    const run1 = startRun(db, deps, { mode: "apply", params: {}, model: "gemma4:12b" });
    applyDecisions(db, deps, run1, "gemma4:12b", [d(a, "keep"), d(b, "exclude", { primaryTranslationRu: "новый" }), d(c, "needs_review", { secondary: ["один", "два"], primaryTranslationRu: "иначе" })]);
    finishRun(db, deps, run1, { n: 3 });
    expect([a, b, c].map((l) => eligibility(db, l))).toEqual(["keep", "excluded", "needs_review"]);
    // the refined translation goes straight into the bank; an excluded word is archived, not deleted and not retranslated
    expect(db.prepare("SELECT translation_ru AS t, archived FROM typing_word_bank WHERE lemma = ?").get(c)).toEqual({ t: "иначе", archived: 0 });
    expect(db.prepare("SELECT archived, archived_by AS by FROM typing_word_bank WHERE lemma = ?").get(b)).toEqual({ archived: 1, by: "model" });
    expect((db.prepare("SELECT COUNT(*) AS n FROM typing_word_bank").get() as { n: number }).n).toBe(40);
    // an archived word is out of the pool; one that needs review stays in
    expect(buildOverview(db, deps).poolSize).toBe(39);
    expect(startScreening(db, deps, "t")).toBeTruthy();

    // a later run decides again: the lexicon follows the latest decision
    deps.advance(1000);
    const run2 = startRun(db, deps, { mode: "apply", params: {}, model: "gemma4:12b" });
    applyDecisions(db, deps, run2, "gemma4:12b", [d(a, "exclude", { reason: "second thoughts" }), d(b, "keep")]);
    expect([a, b].map((l) => eligibility(db, l))).toEqual(["excluded", "keep"]);
    expect(db.prepare("SELECT archived FROM typing_word_bank WHERE lemma = ?").get(a)).toEqual({ archived: 1 });

    // nothing is deleted: every decision is still there, and the log cannot be edited
    expect((db.prepare("SELECT COUNT(*) AS n FROM vocab_typing_cleanup WHERE actor <> 'learner'").get() as { n: number }).n).toBe(5);
    expect(() => db.prepare("DELETE FROM vocab_typing_cleanup").run()).toThrow(/append-only/);
    expect(() => revertRun(db, deps, run1)).toThrow(/npm run restore/);
    expect(db.prepare("SELECT model_tag AS m, prompt_version AS v FROM vocab_typing_cleanup WHERE run_id = ? LIMIT 1").get(run1)).toEqual({ m: "gemma4:12b", v: "vt-clean-v1" });
  });
});
