import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../../apps/server/src/db/migrate.js";
import { openDatabase, type Db } from "../../../apps/server/src/db/open.js";
import { importWordBank } from "../../../apps/server/src/domain/typing/wordBank.js";
import { completeDrills, drillsOverview, LIVES_SLACK, startDrills } from "../../../apps/server/src/domain/typing/drills.js";
import { abortWords, completeWords, startWords, wordsNextLevel, wordsOverview } from "../../../apps/server/src/domain/typing/words.js";
import { typingAnalytics } from "../../../apps/server/src/domain/typing/analytics.js";
import { loadSettings } from "../../../apps/server/src/domain/sessions/policy.js";
import { makeScratchRoot, projectRoot } from "../helpers.js";
import type { TypingDrillsStartResponse } from "../../../packages/contracts/src/typing.js";

const HEADER = "id;English word;Russian translation;Difficulty;Word category;Stress syllable number;Irregular verb forms;Memorization difficulty;Formality level;Translations;Definition / Description;Pronunciation;Transcription;Part of speech (English);Part of speech (Russian);Synonyms";
// stage-1 words (home row + e i r u, 3-5 letters, difficulty 2), and words that only later stages allow
const WORDS: Array<[string, number, string]> = [
  ["sad", 2, "грустный"], ["desk", 2, "стол"], ["fish", 2, "рыба"], ["dress", 2, "платье"], ["fuel", 2, "топливо"], ["ask", 2, "спрашивать"],
  ["fire", 2, "огонь"], ["hair", 2, "волосы"], ["ride", 2, "ехать"], ["side", 2, "сторона"], ["ears", 2, "уши"], ["fake", 2, "фальшивый"],
  ["toast", 2, "тост"], ["animal", 2, "животное"], ["collection", 3, "коллекция"], ["window", 3, "окно"],
  ["garden", 3, "сад"], ["planet", 3, "планета"], ["journey", 3, "путешествие"], ["kitchen", 3, "кухня"], ["question", 3, "вопрос"],
];
const ROWS = WORDS.map(([w, d, t], i) => `${i + 1};${w};50;${d};x;1;;1;Neutral;${t};x;x;[x];noun;x;x`);

let scratch: ReturnType<typeof makeScratchRoot> | null = null;
let db: Db | null = null;
afterEach(() => {
  db?.close();
  db = null;
  scratch?.cleanup();
  scratch = null;
});

let clock = Date.parse("2026-11-09T10:00:00Z");
const deps = { now: () => new Date((clock += 1000)), newId: randomUUID, random: () => 0.42 };

async function setup(drillWords = 24): Promise<Db> {
  scratch = makeScratchRoot();
  db = openDatabase(path.join(scratch.root, "db", "test.sqlite"));
  await runMigrations(db, { migrationsDir: path.join(projectRoot, "migrations"), appVersion: "test" });
  importWordBank(db, [HEADER, ...ROWS].join("\n"), "sha-drills", { now: () => new Date() });
  const cur = loadSettings(db);
  const values = { ...cur.values, typingDrillWordsPerLevel: drillWords, typingWordsPerLevel: 10, typingVocabularyShare: 0, typingSpeedMultiplier: 1 };
  db.prepare("INSERT INTO settings_revisions(id, revision, values_json, created_at) VALUES (?,?,?,?)").run(randomUUID(), cur.revision + 1, JSON.stringify(values), new Date().toISOString());
  return db;
}

/** type the whole plan perfectly and fast (100 ms per letter, far above the 25 WPM default of 480 ms) */
function perfect(plan: TypingDrillsStartResponse, errorsAt: number[] = []) {
  const chars = plan.words.reduce((a, w) => a + w.lemma.length + 1, 0);
  return {
    status: "completed" as const,
    activeMs: 60_000,
    charsTyped: chars + errorsAt.length,
    errors: errorsAt.length,
    words: plan.words.map((w) => ({ planIndex: w.planIndex, errors: errorsAt.includes(w.planIndex) ? 1 : 0, completed: true, typeMs: 100 * w.lemma.length })),
  };
}

describe("Finger Drills (TASK_033)", () => {
  it("plans N showings of the three easiest stage-1 words, with translations under every one and speech on the first and every seventh showing", async () => {
    const d = await setup(24);
    const plan = startDrills(d, deps);
    expect(plan.words).toHaveLength(24);
    expect(plan.stage).toBe(1);
    // no history: 5% of the 24 × (word + space) keys × LIVES_SLACK, plus 3 spare
    const keys = plan.words.reduce((a, w) => a + w.lemma.length + 1, 0);
    expect(plan.lives).toBe(Math.max(5, Math.round(keys * 0.05 * LIVES_SLACK) + 3));
    const lemmas = [...new Set(plan.words.map((w) => w.lemma))];
    expect(lemmas).toHaveLength(3);
    for (const l of lemmas) {
      expect(["toast", "animal", "collection", "window"]).not.toContain(l);
      const shows = plan.words.filter((w) => w.lemma === l);
      expect(shows).toHaveLength(8);
      expect(shows.every((w) => w.showTranslation)).toBe(true); // a translation under every word
      expect(shows.map((w) => w.speak)).toEqual([true, false, false, false, false, false, false, true]); // 1st and 8th
    }
    expect(plan.words.every((w, i) => w.planIndex === i && w.translationRu)).toBe(true);
    const row = d.prepare("SELECT mode, variant, status FROM typing_sessions WHERE id = ?").get(plan.sessionId);
    expect(row).toEqual({ mode: "words", variant: "drills", status: "active" });

  });

  it("stores each showing with its time, keeps Meteor Rain levels apart and learns words only after enough perfect fast showings", async () => {
    const d = await setup(21); // 7 showings of each word: fewer than MIN_SHOWINGS
    const plan = startDrills(d, deps);
    const result = completeDrills(d, deps, plan.sessionId, perfect(plan));
    expect(result.variant).toBe("drills");
    expect(result.status).toBe("completed");
    expect(result.xpAwarded).toBeGreaterThan(0);
    expect(result.metrics.charsCorrect).toBe(plan.words.reduce((a, w) => a + w.lemma.length + 1, 0) - 1); // no space after the last word
    expect(result.drills).toEqual({ stage: 1, learned: 0, newlyLearned: [] });
    const stored = d.prepare("SELECT COUNT(*) AS n, SUM(type_ms IS NOT NULL) AS timed FROM typing_word_results WHERE session_id = ?").get(plan.sessionId) as { n: number; timed: number };
    expect(stored).toEqual({ n: 21, timed: 21 });
    // a Drills level is not a Meteor Rain level
    expect(wordsNextLevel(d)).toBe(1);
    expect(wordsOverview(d).drills.nextLevel).toBe(2);
    // idempotent
    expect(completeDrills(d, deps, plan.sessionId, perfect(plan)).sessionId).toBe(plan.sessionId);
  });

  it("learns words by their accuracy over all levels, then adds new words and keeps learned ones as reviews", async () => {
    const d = await setup(30); // 10 perfect showings of each of 3 words: MIN_SHOWINGS at 100%
    const plan = startDrills(d, deps);
    const result = completeDrills(d, deps, plan.sessionId, perfect(plan));
    const lemmas = [...new Set(plan.words.map((w) => w.lemma))].sort();
    expect(result.drills?.newlyLearned).toEqual(lemmas);
    expect(drillsOverview(d).learned).toBe(3);

    const next = startDrills(d, deps);
    const reviews = next.words.filter((w) => w.review);
    expect(reviews.length).toBeGreaterThanOrEqual(1);
    expect(reviews.length).toBeLessThanOrEqual(9); // at most 30% of the level
    expect(reviews.every((w) => lemmas.includes(w.lemma))).toBe(true);
    const fresh = [...new Set(next.words.filter((w) => !w.review).map((w) => w.lemma))];
    expect(fresh).toHaveLength(3);
    expect(fresh.some((l) => lemmas.includes(l))).toBe(false);

    // one slip keeps a learned word learned (11 of 12 recent showings perfect); three put it back to practice (10 of 13)
    const [slip, bad] = [...new Set(reviews.map((w) => w.lemma))];
    const errorsAt = [next.words.find((w) => w.lemma === slip)!.planIndex, ...next.words.filter((w) => w.lemma === bad).map((w) => w.planIndex)];
    completeDrills(d, deps, next.sessionId, perfect(next, errorsAt));
    expect(drillsOverview(d).learned).toBe(2);
    const a = typingAnalytics(d, { mode: "drills", days: null, timezone: "UTC", now: new Date() });
    expect(a.summary.drills?.words.find((w) => w.lemma === bad)).toMatchObject({ learned: false, step: 0 });
    expect(a.summary.drills?.words.find((w) => w.lemma === slip)).toMatchObject({ learned: true, step: 1 });
  });

  it("mixes two new words into every level while the earlier words keep going wrong", async () => {
    const d = await setup(30);
    const first = startDrills(d, deps);
    const sloppy = perfect(first, first.words.filter((_, i) => i % 3 === 0).map((w) => w.planIndex));
    completeDrills(d, deps, first.sessionId, sloppy);
    const before = new Set(first.words.map((w) => w.lemma));
    const next = startDrills(d, deps);
    const lemmas = [...new Set(next.words.map((w) => w.lemma))];
    expect(lemmas).toHaveLength(5);
    expect(lemmas.filter((l) => before.has(l))).toHaveLength(3);
    expect(next.words.every((w) => !w.review)).toBe(true);
  });

  it("learns slow but accurate words without moving them to rarer reviews, and never lets a level be completed without every word", async () => {
    const d = await setup(30);
    const plan = startDrills(d, deps);
    const slow = perfect(plan);
    slow.words = slow.words.map((w) => ({ ...w, typeMs: 1000 * plan.words[w.planIndex]!.lemma.length }));
    expect(() => completeDrills(d, deps, plan.sessionId, { ...slow, words: slow.words.slice(0, 5) })).toThrow(/every planned word/);
    expect(() => completeDrills(d, deps, plan.sessionId, { ...slow, words: slow.words.slice(1) })).toThrow(/plan order/);
    expect(completeDrills(d, deps, plan.sessionId, slow).drills?.learned).toBe(3);
    const step = (lemma: string) => typingAnalytics(d, { mode: "drills", days: null, timezone: "UTC", now: new Date() }).summary.drills?.words.find((w) => w.lemma === lemma)?.step;
    const lemma = plan.words[0]!.lemma;
    // a clean but slow review keeps the step, a clean and fast one moves it up
    const again = startDrills(d, deps);
    const slow2 = perfect(again);
    slow2.words = slow2.words.map((w) => ({ ...w, typeMs: 1000 * again.words[w.planIndex]!.lemma.length }));
    completeDrills(d, deps, again.sessionId, slow2);
    expect(step(lemma)).toBe(1);
    const fast = startDrills(d, deps);
    completeDrills(d, deps, fast.sessionId, perfect(fast));
    expect(step(lemma)).toBe(2);
  });

  it("sets the lives from the recent Drills accuracy, with some room after a lost level", async () => {
    const d = await setup(24);
    const first = startDrills(d, deps);
    completeDrills(d, deps, first.sessionId, perfect(first)); // no wrong key at all
    expect(startDrills(d, deps).lives).toBe(5); // the minimum
    const sloppy = startDrills(d, deps);
    const words = sloppy.words.slice(0, 10).map((w) => ({ planIndex: w.planIndex, errors: 2, completed: true, typeMs: 400 }));
    const keys = sloppy.words.slice(0, 10).reduce((a, w) => a + w.lemma.length + 1, 0);
    completeDrills(d, deps, sloppy.sessionId, { status: "failed", activeMs: 30_000, charsTyped: keys + 20, errors: 20, words });
    const next = startDrills(d, deps);
    const plannedKeys = next.words.reduce((a, w) => a + w.lemma.length + 1, 0);
    const rate = 20 / ((first.words.reduce((a, w) => a + w.lemma.length + 1, 0)) + keys + 20);
    expect(next.lives).toBe(Math.max(5, Math.round(plannedKeys * rate * LIVES_SLACK * 1.15) + 3));
  });

  it("records a failed level up to the word being typed, without XP", async () => {
    const d = await setup(24);
    const plan = startDrills(d, deps);
    const words = [...plan.words.slice(0, 4).map((w) => ({ planIndex: w.planIndex, errors: 0, completed: true, typeMs: 300 })), { planIndex: 4, errors: 2, completed: false, typeMs: null }];
    const r = completeDrills(d, deps, plan.sessionId, { status: "failed", activeMs: 20_000, charsTyped: 40, errors: 2, words });
    expect(r.status).toBe("failed");
    expect(r.xpAwarded).toBe(0);
    const rows = d.prepare("SELECT w.plan_index AS i, w.destroyed_at IS NOT NULL AS done, r.errors, r.type_ms AS ms FROM typing_words w JOIN typing_word_results r USING (session_id, plan_index) WHERE w.session_id = ? ORDER BY i").all(plan.sessionId) as Array<{ i: number; done: number; errors: number; ms: number | null }>;
    expect(rows).toHaveLength(5);
    expect(rows[4]).toEqual({ i: 4, done: 0, errors: 2, ms: null });
  });

  it("keeps Meteor Rain and Drills sessions apart in completion, abort, analytics and their speed", async () => {
    const d = await setup(24);
    const drills = startDrills(d, deps);
    // starting Meteor Rain interrupts the open Drills level (one Words session at a time)
    const meteors = startWords(d, deps);
    expect((d.prepare("SELECT status FROM typing_sessions WHERE id = ?").get(drills.sessionId) as { status: string }).status).toBe("interrupted");
    expect(() => completeDrills(d, deps, meteors.sessionId, perfect(drills))).toThrow(/Finger Drills/);
    abortWords(d, deps, meteors.sessionId, {});

    const again = startDrills(d, deps);
    expect(() => completeWords(d, deps, again.sessionId, { status: "failed", activeMs: 1, charsTyped: 0, errors: 0, appearances: [], destroyedPlanIndexes: [] })).toThrow(/Meteor Rain/);
    completeDrills(d, deps, again.sessionId, perfect(again));

    const a = typingAnalytics(d, { mode: "drills", days: null, timezone: "UTC", now: new Date() });
    expect(a.mode).toBe("drills");
    expect(a.summary.completed).toBe(1);
    expect(a.summary.wordsDestroyed).toBe(24);
    expect(a.summary.drills?.stage).toBe(1);
    expect(a.series.drillProgress).toMatchObject([{ status: "completed", clean: 24, withErrors: 0, learned: 0 }]);
    expect(a.summary.drills?.words.map((w) => w.showings)).toEqual([8, 8, 8]);
    expect(a.summary.drills?.words.every((w) => !w.learned && w.accuracy === 1 && w.step === 0 && w.msPerLetter === 100)).toBe(true);
    const m = typingAnalytics(d, { mode: "words", days: null, timezone: "UTC", now: new Date() });
    expect(m.summary.completed).toBe(0);
    expect(m.summary.wordsDestroyed).toBe(0);

    // Drills WPM never feeds the Drills baseline: the next pace still starts from the 25 WPM default
    expect(startDrills(d, deps).speed.estimateWpm).toBe(25);
    // and Drills time counts as Words time (Journey and the daily goal group typing sessions by mode)
    const words = d.prepare("SELECT SUM(active_ms) AS ms FROM typing_sessions WHERE mode = 'words'").get() as { ms: number };
    expect(words.ms).toBeGreaterThanOrEqual(60_000);

    // each variant numbers its own levels: Meteor Rain level 1 and Drills level 1 can both be completed
    const m1 = startWords(d, deps);
    const all = m1.words.map((w) => w.planIndex);
    const chars = m1.words.reduce((n, w) => n + w.lemma.length, 0);
    completeWords(d, deps, m1.sessionId, { status: "completed", activeMs: 30_000, charsTyped: chars, errors: 0, appearances: all.map((i) => ({ planIndex: i, order: i })), destroyedPlanIndexes: all });
    expect(wordsNextLevel(d)).toBe(2);
    const d2 = startDrills(d, deps);
    expect(d2.level).toBe(2);
    expect(completeDrills(d, deps, d2.sessionId, perfect(d2)).status).toBe("completed");
    expect(() => d.prepare("UPDATE typing_sessions SET variant = 'drills' WHERE id = ?").run(startWords(d, deps).sessionId)).toThrow(/identity is fixed/);

  });
});
