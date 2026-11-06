import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../../apps/server/src/db/migrate.js";
import { openDatabase, type Db } from "../../../apps/server/src/db/open.js";
import { loadSettings } from "../../../apps/server/src/domain/sessions/policy.js";
import { typingAnalytics } from "../../../apps/server/src/domain/typing/analytics.js";
import { keyInsights, weakPairs } from "../../../apps/server/src/domain/typing/keyStats.js";
import { recallSave, recallStart } from "../../../apps/server/src/domain/typing/recall.js";
import { importWordBank } from "../../../apps/server/src/domain/typing/wordBank.js";
import { completeWords, recordAppearances, startWords } from "../../../apps/server/src/domain/typing/words.js";
import { addWord } from "../../../apps/server/src/domain/vocabulary/repository.js";
import { makeScratchRoot, projectRoot } from "../helpers.js";

const HEADER = "id;English word;Russian translation;Difficulty;Word category;Stress syllable number;Irregular verb forms;Memorization difficulty;Formality level;Translations;Definition / Description;Pronunciation;Transcription;Part of speech (English);Part of speech (Russian);Synonyms";
const WORDS = ["through", "thought", "rough", "enough", "cat", "dog", "sun", "sky", "tree", "book", "house", "urban", "green", "window", "garden", "planet", "journey", "mother", "brother", "silver", "yellow", "orange", "purple", "market"];
const ROWS = WORDS.map((w, i) => `${i + 1};${w};10;2;x;1;;1;Neutral;слово${i};Описание.;x;[x];noun;x;x`);
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
  await runMigrations(db, { migrationsDir: projectRoot + "/migrations", appVersion: "test" });
  importWordBank(db, [HEADER, ...ROWS].join("\n"), "sha", { now: () => new Date() });
  const cur = loadSettings(db);
  db.prepare("INSERT INTO settings_revisions(id, revision, values_json, created_at) VALUES (?,?,?,?)").run(randomUUID(), cur.revision + 1, JSON.stringify({ ...cur.values, typingWordsPerLevel: 10, typingVocabularyShare: 0, typingSpeedMultiplier: 1 }), new Date().toISOString());
  return db;
}

function setRecallWords(d: Db, n: number): void {
  const cur = loadSettings(d);
  d.prepare("INSERT INTO settings_revisions(id, revision, values_json, created_at) VALUES (?,?,?,?)").run(randomUUID(), cur.revision + 1, JSON.stringify({ ...cur.values, typingRecallWords: n }), new Date().toISOString());
}

function finishLevel(d: Db, keyStats?: Array<{ pair: string; count: number; totalMs: number; errors: number }>): string {
  const started = startWords(d, deps);
  const appearances = started.words.map((w, i) => ({ planIndex: w.planIndex, order: i }));
  recordAppearances(d, deps, started.sessionId, appearances);
  completeWords(d, deps, started.sessionId, { status: "completed", activeMs: 60000, charsTyped: 60, errors: 0, appearances, destroyedPlanIndexes: started.words.map((w) => w.planIndex), ...(keyStats ? { keyStats } : {}) });
  return started.sessionId;
}

describe("letter pairs", () => {
  it("are stored with the level, the slow and mistyped ones are found, and the next level favours words with them", async () => {
    const d = await setup();
    // "gh" is slow (900 ms against ~200), "ro" is often mistyped; everything else is typical
    const stats = [
      { pair: "gh", count: 30, totalMs: 30 * 900, errors: 0 },
      { pair: "ro", count: 30, totalMs: 30 * 200, errors: 12 },
      { pair: "at", count: 60, totalMs: 60 * 200, errors: 0 },
      { pair: "he", count: 60, totalMs: 60 * 210, errors: 0 },
      { pair: "xx", count: 2, totalMs: 100, errors: 0 }, // too few to say anything
    ];
    finishLevel(d, stats);
    expect((d.prepare("SELECT COUNT(*) AS n FROM typing_key_stats").get() as { n: number }).n).toBe(5);
    expect(() => d.prepare("DELETE FROM typing_key_stats").run()).toThrow(/append-only/);
    const weak = weakPairs(d, 3);
    expect(weak).toContain("gh");
    expect(weak).toContain("ro");
    expect(weak).not.toContain("xx");
    const insight = keyInsights(d);
    expect(insight.slowPairs[0]!.pair).toBe("gh");
    expect(insight.errorPairs[0]!.pair).toBe("ro");

    // 10 words, 10% weak: at least one word with gh or ro
    const second = startWords(d, deps);
    expect(second.words.filter((w) => w.lemma.includes("gh") || w.lemma.includes("ro")).length).toBeGreaterThanOrEqual(1);

    const stats2 = typingAnalytics(d, { mode: "words", days: 30, timezone: "UTC", now: new Date() });
    expect(stats2.keyInsights.slowPairs[0]!.pair).toBe("gh");
  });
});

describe("memory check after a Words level", () => {
  it("offers saved words, saves the raw counts once, scores by hints and wrong keys, and shows up in the statistics", async () => {
    const d = await setup();
    for (const w of ["reliable", "borrow", "ancient", "gentle"]) {
      addWord(d, deps, { word: w });
    }
    // translations are needed: the enrichment job did not run, so give every saved word a revision
    for (const e of d.prepare("SELECT id, lemma FROM vocabulary_entries").all() as Array<{ id: string; lemma: string }>) {
      d.prepare("INSERT INTO vocabulary_revisions(id, entry_id, revision, translation_ru, part_of_speech, example_en, collocations_json, source, status, user_edited, based_on_user_rev, job_result_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(randomUUID(), e.id, 1, "перевод", "adjective", e.lemma === "gentle" ? "" : `It was a ${e.lemma} thing to say, and ${e.lemma} words matter.`, "[]", "user", "validated", 1, null, null, new Date().toISOString());
    }
    const sessionId = finishLevel(d);
    // the default is two words; this level asks for three
    expect(recallStart(d, deps, sessionId).words).toHaveLength(2);
    setRecallWords(d, 3);
    const offered = recallStart(d, deps, sessionId);
    expect(offered.done).toBe(false);
    expect(offered.words).toHaveLength(3);
    for (const w of offered.words) {
      // the sentence of the dictionary with the word blanked out in every place; a word without an example has none
      if (w.lemma === "gentle") expect(w.sentence).toBeNull();
      else {
        expect(w.sentence).toBe("It was a ____ thing to say, and ____ words matter.");
        expect(w.sentence).not.toContain(w.lemma);
      }
    }
    expect(new Set(offered.words.map((w) => w.entryId)).size).toBe(3);

    const [a, b, c] = offered.words;
    const saved = recallSave(d, deps, sessionId, [
      { entryId: a!.entryId, correctKeys: a!.lemma.length, wrongKeys: 0, hints: 0, revealed: false }, // 10
      { entryId: b!.entryId, correctKeys: b!.lemma.length - 1, wrongKeys: 4, hints: 1, revealed: false }, // 10 - 3 - 2 = 5
      { entryId: c!.entryId, correctKeys: 0, wrongKeys: 0, hints: 0, revealed: true }, // 0
    ]);
    expect(saved.results.map((r) => r.points)).toEqual([10, 5, 0]);
    expect(saved.points).toBe(15);
    expect(() => recallSave(d, deps, sessionId, [{ entryId: a!.entryId, correctKeys: 1, wrongKeys: 0, hints: 0, revealed: false }])).toThrow(/already saved/);
    expect(recallStart(d, deps, sessionId)).toMatchObject({ done: true, points: 15, words: [] });
    expect(() => d.prepare("UPDATE typing_recall_results SET points = 10").run()).toThrow(/append-only/);

    const stats = typingAnalytics(d, { mode: "words", days: 30, timezone: "UTC", now: new Date() });
    expect(stats.summary.recall).toMatchObject({ checks: 1, words: 3, withoutHelpRate: 33.3, avgPoints: 5 });
  });

  it("asks for as many words as the setting says, and none when it is 0", async () => {
    const d = await setup();
    for (const w of ["reliable", "borrow", "ancient"]) addWord(d, deps, { word: w });
    for (const e of d.prepare("SELECT id FROM vocabulary_entries").all() as Array<{ id: string }>) {
      d.prepare("INSERT INTO vocabulary_revisions(id, entry_id, revision, translation_ru, part_of_speech, example_en, collocations_json, source, status, user_edited, based_on_user_rev, job_result_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(randomUUID(), e.id, 1, "перевод", "noun", "", "[]", "user", "validated", 1, null, null, new Date().toISOString());
    }
    const sessionId = finishLevel(d);
    setRecallWords(d, 1);
    expect(recallStart(d, deps, sessionId).words).toHaveLength(1);
    setRecallWords(d, 0);
    expect(recallStart(d, deps, sessionId)).toMatchObject({ words: [], done: false });
  });

  it("is not offered for a level that is not completed", async () => {
    const d = await setup();
    const started = startWords(d, deps);
    expect(() => recallStart(d, deps, started.sessionId)).toThrow(/completed Words level/);
  });

  it("prefers words that give trouble: a word missed in vocabulary practice or failed before is offered far more often than a clean one", async () => {
    const d = await setup();
    const ids: Record<string, string> = {};
    for (const w of ["alpha", "bravo"]) ids[w] = addWord(d, deps, { word: w }).entry.id;
    for (const id of Object.values(ids)) {
      d.prepare("INSERT INTO vocabulary_revisions(id, entry_id, revision, translation_ru, part_of_speech, example_en, collocations_json, source, status, user_edited, based_on_user_rev, job_result_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(randomUUID(), id, 1, "перевод", "noun", "", "[]", "user", "validated", 1, null, null, new Date().toISOString());
    }
    d.prepare("UPDATE vocabulary_entries SET learned = 1 WHERE id = ?").run(ids.alpha);
    // bravo (not learned) vs alpha (learned): over many draws the unlearned word is picked first much more often
    const session = finishLevel(d);
    let bravoFirst = 0;
    let seed = 1;
    for (let i = 0; i < 200; i++) {
      seed = (seed * 16807) % 2147483647;
      let x = seed;
      const random = () => ((x = (x * 16807) % 2147483647) / 2147483647);
      if (recallStart(d, { ...deps, random }, session).words[0]!.lemma === "bravo") bravoFirst++;
    }
    expect(bravoFirst).toBeGreaterThan(130);
  });
});

describe("combo and characters in the statistics", () => {
  it("keeps the best combo and the characters typed, per day and in total", async () => {
    const d = await setup();
    const started = startWords(d, deps);
    const appearances = started.words.map((w, i) => ({ planIndex: w.planIndex, order: i }));
    recordAppearances(d, deps, started.sessionId, appearances);
    completeWords(d, deps, started.sessionId, { status: "completed", activeMs: 60000, charsTyped: 77, errors: 0, appearances, destroyedPlanIndexes: started.words.map((w) => w.planIndex), bestCombo: 7 });
    const stats = typingAnalytics(d, { mode: "words", days: 7, timezone: "UTC", now: new Date() });
    expect(stats.summary).toMatchObject({ totalChars: 77, bestCombo: 7 });
    expect(stats.series.daily.reduce((a, x) => a + (x.chars ?? 0), 0)).toBe(77);
    expect(typingAnalytics(d, { mode: "books", days: 7, timezone: "UTC", now: new Date() }).summary).toMatchObject({ totalChars: 0, bestCombo: null });
  });
});
