import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../../apps/server/src/db/migrate.js";
import { openDatabase, type Db } from "../../../apps/server/src/db/open.js";
import { importWordBank } from "../../../apps/server/src/domain/typing/wordBank.js";
import { buildWordsPlan, completeWords, recordAppearances, startWords, wordsNextLevel, wordsOverview } from "../../../apps/server/src/domain/typing/words.js";
import { typingProgress } from "../../../apps/server/src/domain/typing/xp.js";
import { loadSettings } from "../../../apps/server/src/domain/sessions/policy.js";
import { makeScratchRoot, projectRoot } from "../helpers.js";

const HEADER = "id;English word;Russian translation;Difficulty;Word category;Stress syllable number;Irregular verb forms;Memorization difficulty;Formality level;Translations;Definition / Description;Pronunciation;Transcription;Part of speech (English);Part of speech (Russian);Synonyms";
const ROWS = [
  "1;cat;100;2;животные;1;;1;Neutral;кот, кошка;Домашнее животное.;«кэт»;[kæt];noun;существительное;feline",
  "2;dog;90;2;животные;1;;1;Neutral;собака;Домашнее животное.;«дог»;[dɒɡ];noun;существительное;canine",
  "3;sun;80;2;природа;1;;1;Neutral;солнце;Звезда.;«сан»;[sʌn];noun;существительное;star",
  "4;sky;70;2;природа;1;;1;Neutral;небо;Небо.;«скай»;[skaɪ];noun;существительное;heaven",
  "5;tree;60;2;природа;1;;1;Neutral;дерево;Растение.;«три»;[triː];noun;существительное;plant",
  "6;book;50;2;предметы;1;;1;Neutral;книга;Издание.;«бук»;[bʊk];noun;существительное;volume",
  "7;house;40;2;дом;1;;1;Neutral;дом, жильё;Здание.;«хаус»;[haʊs];noun;существительное;home",
  "8;urban;30;3;город;1;;1;Neutral;городской;О городе.;x;[ˈɜːbən];adjective;прилагательное;city",
  "9;green;20;2;цвет;1;;1;Neutral;зелёный;Цвет.;x;[ɡriːn];adjective;прилагательное;colour",
  "10;window;20;3;дом;1;;1;Neutral;окно;Проём.;x;[ˈwɪndəʊ];noun;существительное;pane",
  "11;garden;20;3;природа;1;;1;Neutral;сад;Участок.;x;[ˈɡɑːdn];noun;существительное;yard",
  "12;planet;20;3;космос;1;;1;Neutral;планета;Небесное тело.;x;[ˈplænɪt];noun;существительное;world",
  "13;journey;20;3;путешествие;1;;1;Neutral;путешествие;Поездка.;x;[ˈdʒɜːni];noun;существительное;trip",
  "14;transient;15;4;время;1;;1;Neutral;преходящий;Временный.;x;[ˈtrænziənt];adjective;прилагательное;temporary",
  "15;collection;15;3;предметы;1;;1;Neutral;коллекция, собрание;Набор.;«колэкшн»;[kəˈlekʃn];noun;существительное;set",
  "16;resurgence;15;4;событие;1;;1;Neutral;возрождение;Возврат.;x;[rɪˈsɜːdʒəns];noun;существительное;revival",
  "17;ambulatory;15;5;медицина;1;;1;Neutral;амбулаторный;Связанный с ходьбой.;x;[ˈæmbjʊlətərɪ];adjective;прилагательное;walking",
  "18;immorality;15;5;этика;1;;1;Neutral;безнравственность;Отсутствие морали.;x;[ˌɪməˈrælɪtɪ];noun;существительное;vice",
  "19;cat2;5;1;x;1;;1;Neutral;x;x;x;[x];noun;x;x",
];

const deps = { now: () => new Date(), newId: randomUUID, random: () => 0.5 };

let scratch: ReturnType<typeof makeScratchRoot> | null = null;
let db: Db | null = null;
afterEach(() => {
  db?.close();
  db = null;
  scratch?.cleanup();
  scratch = null;
});

async function setup(): Promise<Db> {
  scratch = makeScratchRoot();
  db = openDatabase(path.join(scratch.root, "db", "test.sqlite"));
  await runMigrations(db, { migrationsDir: path.join(projectRoot, "migrations"), appVersion: "test" });
  return db;
}

function seedBank(d: Db): void {
  importWordBank(d, [HEADER, ...ROWS].join("\n"), "sha-for-test", { now: () => new Date() });
}

/** make sure typing settings default to a small level for these tests */
function setSmallLevel(d: Db): void {
  const cur = loadSettings(d);
  const values = { ...cur.values, typingWordsPerLevel: 10, typingVocabularyShare: 0, typingSpeedMultiplier: 1 };
  d.prepare("INSERT INTO settings_revisions(id, revision, values_json, created_at) VALUES (?,?,?,?)").run(randomUUID(), cur.revision + 1, JSON.stringify(values), new Date().toISOString());
}

describe("typing words domain", () => {
  it("imports the word bank, excluding Difficulty=1 and non-lowercase words", async () => {
    const d = await setup();
    const result = importWordBank(d, [HEADER, ...ROWS, '20;China;5;3;x;1;;1;Neutral;Китай;x;x;[x];noun;x;x'].join("\n"), "sha", { now: () => new Date() });
    expect(result.imported).toBe(18); // 18 valid rows; cat2 (Difficulty=1) and China (uppercase) are dropped
    const count = (d.prepare("SELECT COUNT(*) AS n FROM typing_word_bank").get() as { n: number }).n;
    expect(count).toBe(18);
  });

  it("builds a plan of exactly N words with no duplicate lemmas", async () => {
    const d = await setup();
    seedBank(d);
    setSmallLevel(d);
    const settings = loadSettings(d).values;
    const plan = buildWordsPlan(d, 1, settings, deps);
    expect(plan.words).toHaveLength(10);
    expect(new Set(plan.words.map((w) => w.lemma)).size).toBe(10);
    // level 1-3: no very long words
    expect(plan.words.every((w) => w.lemma.length <= 10)).toBe(true);
  });

  it("starts, completes and idempotently re-completes a Words level, awarding XP once", async () => {
    const d = await setup();
    seedBank(d);
    setSmallLevel(d);
    const started = startWords(d, deps);
    expect(started.words).toHaveLength(10);
    expect(wordsOverview(d).activeSessionId).toBe(started.sessionId);
    expect(wordsNextLevel(d)).toBe(1);

    const appearances = started.words.map((w, i) => ({ planIndex: w.planIndex, order: i }));
    recordAppearances(d, deps, started.sessionId, appearances);
    const result = completeWords(d, deps, started.sessionId, {
      status: "completed",
      activeMs: 60000,
      charsTyped: 60,
      errors: 0,
      appearances,
      destroyedPlanIndexes: started.words.map((w) => w.planIndex),
    });
    expect(result.status).toBe("completed");
    expect(result.xpAwarded).toBeGreaterThan(0);
    expect(wordsNextLevel(d)).toBe(2);

    const xp1 = typingProgress(d).total;
    // idempotent re-complete returns the same result and does not double XP
    const again = completeWords(d, deps, started.sessionId, {
      status: "completed",
      activeMs: 60000,
      charsTyped: 60,
      errors: 0,
      appearances,
      destroyedPlanIndexes: started.words.map((w) => w.planIndex),
    });
    expect(again.sessionId).toBe(result.sessionId);
    expect(typingProgress(d).total).toBe(xp1);
  });

  it("rejects completing a level without destroying exactly all words", async () => {
    const d = await setup();
    seedBank(d);
    setSmallLevel(d);
    const started = startWords(d, deps);
    const appearances = started.words.map((w, i) => ({ planIndex: w.planIndex, order: i }));
    expect(() =>
      completeWords(d, deps, started.sessionId, {
        status: "completed",
        activeMs: 60000,
        charsTyped: 60,
        errors: 0,
        appearances,
        destroyedPlanIndexes: [started.words[0]!.planIndex],
      }),
    ).toThrow(/must destroy exactly/);
  });

  it("does not award XP for a failed level", async () => {
    const d = await setup();
    seedBank(d);
    setSmallLevel(d);
    const started = startWords(d, deps);
    completeWords(d, deps, started.sessionId, {
      status: "failed",
      activeMs: 60000,
      charsTyped: 30,
      errors: 0,
      appearances: [],
      destroyedPlanIndexes: [],
    });
    expect(typingProgress(d).total).toBe(0);
    expect(wordsNextLevel(d)).toBe(1);
  });

  it("does not count words that never appeared when a level is lost", async () => {
    const d = await setup();
    seedBank(d);
    setSmallLevel(d);
    const started = startWords(d, deps);
    // only the first word appears before the loss
    recordAppearances(d, deps, started.sessionId, [{ planIndex: started.words[0]!.planIndex, order: 0 }]);
    const shown = (d.prepare("SELECT COUNT(*) AS n FROM typing_words WHERE session_id = ?").get(started.sessionId) as { n: number }).n;
    expect(shown).toBe(1);
  });
});
