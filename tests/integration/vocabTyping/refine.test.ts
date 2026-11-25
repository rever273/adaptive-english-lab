import { afterEach, describe, expect, it } from "vitest";
import { importWordBank } from "../../../apps/server/src/domain/typing/wordBank.js";
import { applyDecisions, revertRun, startRun, type CleanDecision } from "../../../apps/server/src/domain/vocabTyping/clean.js";
import { importLexiconExamples, readExamples } from "../../../apps/server/src/domain/vocabTyping/lexiconExamples.js";
import { prepareLexicon } from "../../../apps/server/src/domain/vocabTyping/lexicon.js";
import { buildOverview, listWords, restoreWord } from "../../../apps/server/src/domain/vocabTyping/overview.js";
import { usableSentences } from "../../../apps/server/src/domain/vocabTyping/sentences.js";
import { recordScreening, startScreening } from "../../../apps/server/src/domain/vocabTyping/sessions.js";
import { sessionState } from "../../../apps/server/src/domain/vocabTyping/view.js";
import { makeDeps, seedPool, setup, typing, useSettings, uuid, type Env } from "./fixtures.js";
import type { VtScreeningCard } from "@english-lab/contracts";

let env: Env | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

const dec = (lemma: string, decision: CleanDecision["decision"], o: Partial<CleanDecision> = {}): CleanDecision => ({ lemma, decision, reason: "test", confidence: 0.9, primaryTranslationRu: null, secondary: [], transcriptionDoubt: false, softened: false, ...o });

describe("Vocabulary Typing refinement (D177-D179, D184)", () => {
  it("ranks by the CSV frequency (third column), writes it into the word bank and keeps ranks unique", async () => {
    env = await setup();
    const { db } = env;
    seedPool(db, 3);
    const csv = ["id;English word;Russian translation", "1;waaa;10", "2;waab;50.5", "3;waac;50.5"].join("\n");
    const r = prepareLexicon(db, csv, new Date());
    expect(r).toMatchObject({ updated: 3, unchanged: 0, frequencyUpdated: 3 });
    const rank = (l: string) => (db.prepare("SELECT freq_rank AS r FROM vocab_typing_lexicon WHERE lemma = ?").get(l) as { r: number }).r;
    expect([rank("waab"), rank("waac"), rank("waaa")]).toEqual([1, 2, 3]);
    expect(db.prepare("SELECT frequency FROM typing_word_bank WHERE lemma = 'waab'").get()).toEqual({ frequency: 50.5 });
    expect(prepareLexicon(db, csv, new Date())).toMatchObject({ updated: 0, unchanged: 3, frequencyUpdated: 0 });
  });

  it("the pool takes words of the minimum length beyond the skipped top; the skipped top counts as known by assumption", async () => {
    env = await setup();
    const { db } = env;
    const deps = makeDeps();
    seedPool(db, 40, new Date(), 5);
    const o = buildOverview(db, deps);
    expect(o.poolSize).toBe(35);
    expect(o.estimate).toMatchObject({ assumedKnown: 5, poolSize: 40, version: "vt-estimate-v2" });
    useSettings(db, { vtMinLength: 5 });
    expect(buildOverview(db, deps).poolSize).toBe(0);
    expect(() => startScreening(db, deps, "t")).toThrow(/already screened/);
    useSettings(db, { vtMinLength: 3, vtSkipTopRanks: 0 });
    expect(buildOverview(db, deps).poolSize).toBe(40);
  });

  it("archiving keeps the word, takes it out of the pool and of every practice, and Restore brings it back", async () => {
    env = await setup();
    const { db } = env;
    const deps = makeDeps();
    seedPool(db, 30);
    const { sessionId } = startScreening(db, deps, "t");
    const lemma = (sessionState(db, sessionId).card as VtScreeningCard).word.lemma;
    recordScreening(db, deps, sessionId, { clientEventId: uuid(), tabId: "t", lemma, kind: "screen_archived", typing });
    expect(db.prepare("SELECT archived, archived_by AS by FROM typing_word_bank WHERE lemma = ?").get(lemma)).toEqual({ archived: 1, by: "learner" });
    expect((db.prepare("SELECT COUNT(*) AS n FROM typing_word_bank").get() as { n: number }).n).toBe(30);
    expect(buildOverview(db, deps)).toMatchObject({ poolSize: 29, screening: { notUseful: 1, screened: 0 } });
    expect(db.prepare("SELECT COUNT(*) AS n FROM mode_xp_events WHERE source = 'vocabTyping'").get()).toEqual({ n: 0 });
    // the other practices read only archived = 0
    expect(db.prepare("SELECT COUNT(*) AS n FROM typing_word_bank WHERE typing_ok = 1 AND archived = 0").get()).toEqual({ n: 29 });
    expect(listWords(db, { filter: "excluded", limit: 10, offset: 0 }).words).toMatchObject([{ lemma, state: "excluded_by_learner", archived: true }]);
    restoreWord(db, deps, lemma);
    expect(db.prepare("SELECT archived FROM typing_word_bank WHERE lemma = ?").get(lemma)).toEqual({ archived: 0 });
    expect(buildOverview(db, deps).poolSize).toBe(30);
  });

  it("the cleanup writes refined translations into the bank and archives (never deletes) excluded words; a reseed keeps both; revert explains itself", async () => {
    env = await setup();
    const { db } = env;
    const deps = makeDeps();
    const { lemmas } = seedPool(db, 20);
    const [a, b, c] = lemmas as [string, string, string];
    const run = startRun(db, deps, { mode: "apply", params: {}, model: "m" });
    applyDecisions(db, deps, run, "m", [dec(a, "keep", { primaryTranslationRu: "новый перевод" }), dec(b, "exclude"), dec(c, "needs_review")]);
    expect(db.prepare("SELECT translation_ru AS t FROM typing_word_bank WHERE lemma = ?").get(a)).toEqual({ t: "новый перевод" });
    expect(db.prepare("SELECT archived, archived_by AS by, archive_reason AS r FROM typing_word_bank WHERE lemma = ?").get(b)).toEqual({ archived: 1, by: "model", r: "test" });
    expect((db.prepare("SELECT COUNT(*) AS n FROM typing_word_bank").get() as { n: number }).n).toBe(20);
    expect(() => revertRun(db, deps, run)).toThrow(/npm run restore/);

    // typing:seed: frequency comes in, the refined translation and the archive flag stay
    const header = "id;English word;Russian translation;Difficulty;Translations;Definition / Description;Transcription;Part of speech (English)";
    const rows = lemmas.map((l, i) => `${i + 1};${l};${100 - i};3;старый;;t;noun`);
    const imported = importWordBank(db, [header, ...rows].join("\n"), "sha", { now: () => new Date() });
    expect(imported).toMatchObject({ imported: 20, keptOut: 1 });
    expect(db.prepare("SELECT translation_ru AS t, frequency FROM typing_word_bank WHERE lemma = ?").get(a)).toEqual({ t: "новый перевод", frequency: 100 });
    expect(db.prepare("SELECT translation_ru AS t FROM typing_word_bank WHERE lemma = ?").get(c)).toEqual({ t: "старый" });
    expect(db.prepare("SELECT archived, archived_by AS by FROM typing_word_bank WHERE lemma = ?").get(b)).toEqual({ archived: 1, by: "model" });
    // a model-archived word can be restored by the learner
    restoreWord(db, deps, b);
    expect(db.prepare("SELECT archived FROM typing_word_bank WHERE lemma = ?").get(b)).toEqual({ archived: 0 });
    expect(db.prepare("SELECT eligibility FROM vocab_typing_lexicon WHERE lemma = ?").get(b)).toEqual({ eligibility: "keep" });
  });

  it("imports the CSV examples as source 'lexicon' through the same checks, without duplicates, once", async () => {
    env = await setup();
    const { db } = env;
    const deps = makeDeps();
    const ins = db.prepare("INSERT INTO typing_word_bank(lemma, char_count, part_of_speech, translation_ru, definition_ru, transcription, difficulty, status, source_sha256, imported_at, typing_ok, past_forms, participle_forms) VALUES (?,?,?,?,?,?,2,'draft','sha','2026-11-24T00:00:00Z',1,?,?)");
    for (const w of ["gift", "wait", "run"]) ins.run(w, w.length, "noun", "перевод", "", "", w === "run" ? '["ran"]' : "[]", w === "run" ? '["run"]' : "[]");
    const head = ["id", "English word", "Russian translation", ...Array.from({ length: 4 }, (_, i) => [`Example sentence ${i + 1}`, `Example translation ${i + 1}`]).flat()].join(";");
    const csv = [
      head,
      "1;gift;300;I bought a gift for my friend.;Я купил подарок для моего друга.;I bought this gift for you.;Я купил этот подарок для тебя.;Gift.;Подарок.;The gift has 3 parts.;Подарок состоит из трёх частей.",
      "2;wait;200;She has to wait for an hour.;Ей надо ждать час.;I bought a gift for my friend.;Я купил подарок.;We wait here.;Мы ждём здесь.;Please wait here today.;Wait please",
      "3;run;100;He ran home fast.;Он быстро побежал домой.;Run and run again today.;Беги и беги снова.;;;;",
    ].join("\n");
    expect(readExamples(csv).get("gift")).toHaveLength(4);
    prepareLexicon(db, csv, new Date());
    // an earlier Tatoeba sentence for the same word is not duplicated
    db.prepare("INSERT INTO vocab_typing_imports(id, corpus, version, inputs_json, counts_json, created_at) VALUES ('t','tatoeba','x','{}','{}','2026-11-24T00:00:00Z')").run();
    db.prepare("INSERT INTO vocab_typing_sentences(id, source, source_en_id, source_ru_id, text_en, text_ru, license_en, license_ru, word_count, difficulty_score, import_id, created_at) VALUES ('s1','tatoeba',1,2,'I bought a gift for my friend!','Я купил подарок.','CC BY 2.0 FR','CC BY 2.0 FR',7,10,'t','2026-11-24T00:00:00Z')").run();
    db.prepare("INSERT INTO vocab_typing_sentence_targets(sentence_id, lemma, start, length, surface, ambiguous, rank_for_lemma) VALUES ('s1','gift',15,4,'gift',0,1)").run();
    db.prepare("INSERT INTO vocab_typing_sentence_status(id, sentence_id, status, actor, created_at) VALUES ('st1','s1','validated','code','2026-11-24T00:00:00Z')").run();

    const r = importLexiconExamples(db, csv, new Set(), deps);
    expect(r.skipped).toBe(false);
    expect(r.rejected).toMatchObject({ duplicate: expect.any(Number), english_filter: expect.any(Number) });
    expect(usableSentences(db, "gift").map((s) => s.text)).toEqual(["I bought a gift for my friend!", "I bought this gift for you."]);
    expect(usableSentences(db, "wait").map((s) => s.text).sort()).toEqual(["She has to wait for an hour.", "We wait here."]);
    expect(usableSentences(db, "run").map((s) => s.text)).toEqual(["He ran home fast."]); // "Run and run again" has the word twice
    expect(db.prepare("SELECT source, license_en AS l, author_en AS a FROM vocab_typing_sentences WHERE id LIKE 'vts-lex-%' LIMIT 1").get()).toEqual({ source: "lexicon", l: "own dictionary", a: null });
    expect(db.prepare("SELECT DISTINCT status, actor FROM vocab_typing_sentence_status").all()).toEqual([{ status: "validated", actor: "code" }]);
    const again = importLexiconExamples(db, csv, new Set(), deps);
    expect(again.skipped).toBe(true);
    expect((db.prepare("SELECT COUNT(*) AS n FROM vocab_typing_sentences WHERE source = 'lexicon'").get() as { n: number }).n).toBe(r.sentencesStored);
  });
});
