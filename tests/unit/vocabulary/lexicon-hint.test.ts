import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LexiconHints, parseLexicon, splitLine } from "../../../apps/server/src/domain/vocabulary/lexiconHint.js";

const HEADER = "id;English word;Russian translation;Difficulty;Word category;Stress syllable number;Irregular verb forms;Memorization difficulty;Formality level;Translations;Definition / Description;Pronunciation;Transcription;Part of speech (English);Part of speech (Russian);Synonyms";
// invented rows in the shape of the user's old word list
const ROWS = [
  '1;go;640.5;1;движение;1;go/went/gone;1;Neutral;идти, ехать;"Перемещаться; двигаться.";«гоу»;[ɡəʊ];verb;глагол;"move, travel, leave"',
  "2;Meeting;51;2;работа;1;;1;Neutral;встреча;Собрание людей.;«митинг»;[ˈmiːtɪŋ];noun;существительное;gathering",
  "3;go;1;1;x;1;;1;Neutral;дубль;Повтор.;x;[x];noun;x;x",
];

describe("old word list hints (D69)", () => {
  it("splits a line on ; and keeps ; and doubled quotes inside quotes", () => {
    expect(splitLine('a;"b;c";"d ""q"" e";')).toEqual(["a", "b;c", 'd "q" e', ""]);
  });

  it("keeps only the useful columns, lower-cases the key, takes the first of duplicate words and reads the frequency number", () => {
    const m = parseLexicon([HEADER, ...ROWS, ""].join("\r\n"));
    expect(m.size).toBe(2);
    expect(m.get("go")).toEqual({ partOfSpeech: "verb", transcription: "[ɡəʊ]", definitionRu: "Перемещаться; двигаться.", synonyms: ["move", "travel", "leave"], irregularForms: "go/went/gone", translationsRu: "идти, ехать", frequency: 640.5 });
    expect(m.get("meeting")?.irregularForms).toBe("");
  });

  it("returns nothing for an unknown header, a missing file or no configured file, and never throws", async () => {
    expect(parseLexicon("a;b\n1;2").size).toBe(0);
    expect(await new LexiconHints(undefined).lookup("go")).toBeNull();
    expect(await new LexiconHints(path.join(tmpdir(), "englishlab-no-such-file.csv")).lookup("go")).toBeNull();
    const dir = mkdtempSync(path.join(tmpdir(), "englishlab-lex-"));
    try {
      const file = path.join(dir, "words.csv");
      writeFileSync(file, [HEADER, ...ROWS].join("\n"), "utf8");
      const hints = new LexiconHints(file);
      expect((await hints.lookup(" GO "))?.partOfSpeech).toBe("verb");
      expect(await hints.lookup("absent")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
