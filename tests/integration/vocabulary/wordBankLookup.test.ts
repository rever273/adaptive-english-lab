import { afterEach, expect, it } from "vitest";
import { lookupWordBank } from "../../../apps/server/src/domain/vocabulary/wordBankLookup.js";
import { makeEnv, type Env } from "../attempts/fixtures.js";

let env: Env | null = null;
afterEach(() => { env?.cleanup(); env = null; });

it("looks up exact words and regular forms without changing the bank", async () => {
  env = await makeEnv();
  const insert = env.db.prepare("INSERT INTO typing_word_bank(lemma, char_count, part_of_speech, translation_ru, definition_ru, transcription, difficulty, status, source_sha256, imported_at) VALUES (?, ?, 'verb', ?, '', '', 2, 'draft', 'fixture', '2026-01-01')");
  for (const lemma of ["choose", "study", "stop", "work", "works"]) insert.run(lemma, lemma.length, `translation ${lemma}`);
  expect(lookupWordBank(env.db, "CHOOSE")[0]?.lemma).toBe("choose");
  expect(lookupWordBank(env.db, "choosing").map((m) => m.lemma)).toContain("choose");
  expect(lookupWordBank(env.db, "studies").map((m) => m.lemma)).toContain("study");
  expect(lookupWordBank(env.db, "stopped").map((m) => m.lemma)).toContain("stop");
  expect(lookupWordBank(env.db, "works").map((m) => m.lemma)).toEqual(["works"]);
  expect(lookupWordBank(env.db, "went")).toEqual([]);
  expect(lookupWordBank(env.db, "two words")).toEqual([]);
  expect((env.db.prepare("SELECT COUNT(*) AS n FROM typing_word_bank").get() as { n: number }).n).toBe(5);
});

it("imports every CSV word for lookup but marks only lowercase difficulty 2-5 words for Typing Words", async () => {
  const { importWordBank } = await import("../../../apps/server/src/domain/typing/wordBank.js");
  env = await makeEnv();
  const csv = [
    "id;English word;Russian translation;Difficulty;Translations;Definition / Description;Transcription;Part of speech (English)",
    "1;in;1;1;в, внутрь;;[ɪn];preposition",
    "2;bridge;1;3;мост;;[b];noun",
    "3;China;1;4;Китай;;[c];noun",
    "4;FALSE;1;3;ложный;;[f];adjective",
    "5;well-known;1;3;известный;;[w];adjective",
    "6;nothing;1;3;(none);;[n];noun",
  ].join("\n");
  const res = importWordBank(env.db, csv, "sha", { now: () => new Date("2026-01-01") });
  expect(res.imported).toBe(4);
  expect(res.lookupOnly).toBe(2);
  expect(res.skipped).toMatchObject({ notLetters: 1, noTranslation: 1 });
  const ok = env.db.prepare("SELECT lemma FROM typing_word_bank WHERE typing_ok = 1 ORDER BY lemma").all().map((r) => (r as { lemma: string }).lemma);
  expect(ok).toEqual(["bridge", "false"]);
  expect(lookupWordBank(env.db, "China")[0]?.translationRu).toBe("Китай");
  expect(lookupWordBank(env.db, "in")[0]?.translationRu).toBe("в");
});

it("finds the base verb for an irregular past or participle, but never overrides an exact entry", async () => {
  const { importWordBank } = await import("../../../apps/server/src/domain/typing/wordBank.js");
  env = await makeEnv();
  const csv = [
    "id;English word;Russian translation;Difficulty;Translations;Definition / Description;Transcription;Part of speech (English)",
    "1;arise;1;3;возникать;;[a];verb",
    "2;go;1;2;идти;;[g];verb",
    "3;went;1;2;ушёл (особая запись);;[w];verb",
    "4;put;1;2;класть;;[p];verb",
  ].join("\n");
  const irregular = JSON.stringify({
    arise: [{ "2": ["arose"], "3": ["arisen"] }],
    go: [{ "2": ["went"], "3": ["gone"] }],
    put: [{ "2": ["put"], "3": ["put"] }],
    unknownverb: [{ "2": ["x"], "3": ["y"] }],
  });
  const res = importWordBank(env.db, csv, "sha", { now: () => new Date("2026-01-01") }, irregular);
  expect(res.irregularVerbs).toBe(2); // put -> put adds nothing; unknownverb is not in the bank
  expect(lookupWordBank(env.db, "arisen")).toEqual([{ lemma: "arise", translationRu: "возникать", partOfSpeech: "verb", form: "participle" }]);
  expect(lookupWordBank(env.db, "Arose")[0]).toMatchObject({ lemma: "arise", form: "past" });
  expect(lookupWordBank(env.db, "gone")[0]).toMatchObject({ lemma: "go", form: "participle" });
  expect(lookupWordBank(env.db, "went")[0]?.lemma).toBe("went"); // an exact entry wins
  expect(env.db.prepare("SELECT past_forms AS p FROM typing_word_bank WHERE lemma = 'put'").get()).toEqual({ p: "[]" }); // same as the base: not stored
  expect(lookupWordBank(env.db, "arising")[0]?.lemma).toBe("arise"); // regular endings still work
});
