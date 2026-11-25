import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareLexicon } from "../../../apps/server/src/domain/vocabTyping/lexicon.js";
import { acceptEnglish, acceptRussian, importTatoeba, selectBest, type Candidate } from "../../../apps/server/src/domain/vocabTyping/tatoeba.js";
import { usableCounts, usableSentences } from "../../../apps/server/src/domain/vocabTyping/sentences.js";
import { makeScratchRoot } from "../helpers.js";
import { makeDeps, setup, type Env } from "./fixtures.js";

let env: Env | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

const WORDS = ["run", "go", "see", "saw", "big", "cat", "table", "nice"];
const tsv = (rows: Array<Array<string | number>>): string => rows.map((r) => r.join("\t")).join("\n") + "\n";

describe("Tatoeba filters", () => {
  const bl = new Set(["damn"]);
  it("accepts a short typable sentence and rejects the rest", () => {
    expect(acceptEnglish("I run every day.", bl)).toBe("I run every day.");
    expect(acceptEnglish("It’s a big cat.", bl)).toBe("It's a big cat.");
    for (const bad of ["Run.", "Go home", "I have 3 cats.", "See www.example.com now.", "Damn that big cat.", "Café au lait is nice.", "THE BIG CAT RAN HOME.", "I saw " + "very ".repeat(30) + "big cats.", "One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen."]) expect(acceptEnglish(bad, bl)).toBeNull();
  });
  it("wants a Cyrillic translation without Latin letters", () => {
    expect(acceptRussian("Я бегаю каждый день.")).toBe(true);
    expect(acceptRussian("I run every day.")).toBe(false);
    expect(acceptRussian("Run бегать")).toBe(false);
  });
  it("selects at most the limit, best first, with variety of spellings", () => {
    const mk = (i: number, surface: string, difficulty: number): Candidate => ({ enId: i, ruId: i, text: `t${i}`, textRu: "р", authorEn: null, authorRu: null, words: 8, difficulty, ambiguous: false, start: 0, length: 3, surface });
    const cands = [...Array.from({ length: 10 }, (_, i) => mk(i, "run", 100 + i)), mk(50, "ran", 500), mk(51, "running", 600)];
    const chosen = selectBest(cands, 6);
    expect(chosen).toHaveLength(6);
    expect(chosen.filter((c) => c.surface === "run").length).toBe(4);
    expect(chosen.map((c) => c.surface)).toEqual(expect.arrayContaining(["ran", "running"]));
    expect(selectBest(cands, 6).map((c) => c.enId)).toEqual(chosen.map((c) => c.enId));
  });
});

describe("Tatoeba import", () => {
  it("stores the best sentences per word with their sources, once, and reports coverage", async () => {
    env = await setup();
    const { db } = env;
    const ins = db.prepare("INSERT INTO typing_word_bank(lemma, char_count, part_of_speech, translation_ru, definition_ru, transcription, difficulty, status, source_sha256, imported_at, typing_ok, past_forms, participle_forms) VALUES (?,?,?,?,?,?,2,'draft','sha','2026-11-24T00:00:00Z',1,?,?)");
    WORDS.forEach((w) => ins.run(w, w.length, w === "big" || w === "nice" ? "adjective" : "verb", "перевод", "", "", w === "run" ? '["ran"]' : w === "go" ? '["went"]' : w === "see" ? '["saw"]' : "[]", w === "run" ? '["run"]' : w === "go" ? '["gone"]' : w === "see" ? '["seen"]' : "[]"));
    const csv = ["id;English word", ...WORDS.map((w, i) => `${i + 1};${w}`)].join("\n");
    prepareLexicon(db, csv, new Date());

    const scratch = makeScratchRoot();
    try {
      const dir = path.join(scratch.root, "tatoeba");
      mkdirSync(dir, { recursive: true });
      const eng = [
        [1, "eng", "I run every day.", "alice", ""],
        [2, "eng", "He ran home.", "bob", ""],
        [3, "eng", "I saw a big cat.", "carol", ""],
        [4, "eng", "I saw a big cat!", "dave", ""], // same sentence once punctuation is ignored
        [5, "eng", "They want to go home.", "erin", ""],
        [6, "eng", "The ongoing war is bad.", "frank", ""],
        [7, "eng", "Run and run again today.", "gina", ""],
        [8, "eng", "She has a nice table.", "hugo", ""],
        [9, "eng", "No translation exists here.", "ivan", ""],
        [10, "eng", "I run fast.", "judy", ""],
      ];
      const rus = [
        [101, "rus", "Я бегаю каждый день.", "olga", ""],
        [102, "rus", "Он побежал домой.", "pavel", ""],
        [103, "rus", "Я видел большого кота.", "rita", ""],
        [105, "rus", "Они хотят пойти домой.", "sasha", ""],
        [106, "rus", "Идущая война плоха.", "tanya", ""],
        [107, "rus", "Беги и беги снова сегодня.", "uma", ""],
        [108, "rus", "У неё красивый стол.", "vera", ""],
        [109, "rus", "Это длинный русский перевод который длиннее другого перевода.", "wanda", ""],
        [110, "rus", "Я бегу быстро.", "xenia", ""],
        [111, "rus", "I run fast", "latin", ""], // not a valid translation
      ];
      const links = [[1, 101], [2, 102], [3, 103], [4, 103], [5, 105], [6, 106], [7, 107], [8, 108], [8, 109], [10, 110], [10, 111]];
      writeFileSync(path.join(dir, "eng.tsv"), tsv(eng));
      writeFileSync(path.join(dir, "rus.tsv"), tsv(rus));
      writeFileSync(path.join(dir, "links.tsv"), tsv(links));
      writeFileSync(path.join(dir, "engcc0.tsv"), tsv([[1, "eng", "I run every day.", ""]]));
      writeFileSync(path.join(dir, "ruscc0.tsv"), "");
      const files = { engSentences: path.join(dir, "eng.tsv"), rusSentences: path.join(dir, "rus.tsv"), links: path.join(dir, "links.tsv"), engCc0: path.join(dir, "engcc0.tsv"), rusCc0: path.join(dir, "ruscc0.tsv") };
      const inputs = { files: [{ name: "eng", bytes: 1, sha256: "aa" }, { name: "rus", bytes: 1, sha256: "bb" }] };
      const deps = makeDeps();
      const report = await importTatoeba(db, files, inputs, new Set(), deps);
      expect(report.skipped).toBe(false);
      expect(report.linkedPairs).toBe(11);

      // run: sentences 1, 2 (ran), 7 is dropped (the word twice), 10; sentence 6 is not about go
      const run = usableSentences(db, "run");
      expect(run.map((s) => s.text).sort()).toEqual(["He ran home.", "I run every day.", "I run fast."]);
      const first = run.find((s) => s.text === "I run every day.")!;
      expect(first.text.slice(first.start, first.start + first.length)).toBe("run");
      expect(usableSentences(db, "go").map((s) => s.text)).toEqual(["They want to go home."]);
      // saw belongs to see and to the noun "saw": both marked ambiguous, and the duplicate sentence is stored once
      expect(usableSentences(db, "see")[0]).toMatchObject({ ambiguous: true });
      expect(usableSentences(db, "big").filter((s) => s.text.startsWith("I saw a big cat"))).toHaveLength(1);
      // the shortest valid translation is chosen and the invalid one is ignored
      expect(db.prepare("SELECT text_ru AS t FROM vocab_typing_sentences WHERE source_en_id = 8").get()).toEqual({ t: "У неё красивый стол." });
      expect(db.prepare("SELECT text_ru AS t FROM vocab_typing_sentences WHERE source_en_id = 10").get()).toEqual({ t: "Я бегу быстро." });
      // sources and licences are kept per sentence
      expect(db.prepare("SELECT author_en AS a, license_en AS l, license_ru AS r, source_ru_id AS ru FROM vocab_typing_sentences WHERE source_en_id = 1").get()).toEqual({ a: "alice", l: "CC0 1.0", r: "CC BY 2.0 FR", ru: 101 });
      expect(db.prepare("SELECT license_en AS l FROM vocab_typing_sentences WHERE source_en_id = 2").get()).toEqual({ l: "CC BY 2.0 FR" });
      // every sentence is `validated` by code, never approved
      expect(db.prepare("SELECT DISTINCT status, actor FROM vocab_typing_sentence_status").all()).toEqual([{ status: "validated", actor: "code" }]);
      expect(db.prepare("SELECT context_count AS n FROM vocab_typing_lexicon WHERE lemma = 'run'").get()).toEqual({ n: 3 });
      expect(usableCounts(db).get("run")).toBe(3);
      expect(report.totals.atLeast3).toBe(1);
      expect(report.totals).toEqual({ atLeast3: 1, oneOrTwo: 7, none: 0 });

      // the same version again changes nothing
      const again = await importTatoeba(db, files, inputs, new Set(), deps);
      expect(again.skipped).toBe(true);
      expect((db.prepare("SELECT COUNT(*) AS n FROM vocab_typing_sentences").get() as { n: number }).n).toBe(report.sentencesStored);
      // a flagged pair is no longer usable (append-only status, the sentence itself stays)
      db.prepare("INSERT INTO vocab_typing_sentence_status(id, sentence_id, lemma, status, actor, created_at) VALUES ('f1', ?, 'run', 'flagged', 'learner', ?)").run(first.id, (deps.advance(1000), deps.now().toISOString()));
      expect(usableSentences(db, "run")).toHaveLength(2);
    } finally {
      scratch.cleanup();
    }
  });
});
