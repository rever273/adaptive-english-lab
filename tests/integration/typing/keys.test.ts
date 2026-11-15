import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../../apps/server/src/db/migrate.js";
import { openDatabase, type Db } from "../../../apps/server/src/db/open.js";
import { abortKeysLesson, completeKeysLesson, keysOverview, startKeysLesson } from "../../../apps/server/src/domain/typing/keys/lessons.js";
import { typingProgress } from "../../../apps/server/src/domain/typing/xp.js";
import { typingAnalytics } from "../../../apps/server/src/domain/typing/analytics.js";
import { readJourney } from "../../../apps/server/src/domain/journey/readModel.js";
import { TypingKeysResultSchema, type TypingKeysStartResponse } from "../../../packages/contracts/src/typing.js";
import { makeScratchRoot, projectRoot } from "../helpers.js";

let scratch: ReturnType<typeof makeScratchRoot> | null = null;
let db: Db | null = null;
afterEach(() => {
  db?.close();
  db = null;
  scratch?.cleanup();
  scratch = null;
});

let clock = Date.parse("2026-11-14T01:00:00Z");
let seed = 11;
const deps = { now: () => new Date((clock += 1000)), newId: randomUUID, random: () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) };

async function setup(): Promise<Db> {
  scratch = makeScratchRoot();
  db = openDatabase(path.join(scratch.root, "db", "test.sqlite"));
  await runMigrations(db, { migrationsDir: path.join(projectRoot, "migrations"), appVersion: "test" });
  return db;
}

/** the whole text typed cleanly, every key at `ms` per press */
function typed(lesson: TypingKeysStartResponse, ms: number) {
  const text = lesson.tokens.map((t) => t.text).join(" ");
  const counts = new Map<string, number>();
  for (const ch of text) if (ch !== " ") counts.set(ch, (counts.get(ch) ?? 0) + 1);
  clock += text.length * ms; // the lesson takes that long, so the server's wall-time cap keeps the reported time
  return { activeMs: text.length * ms, charsTyped: text.length, errors: 0, keys: [...counts].map(([letter, hits]) => ({ letter, hits, misses: 0, meanMs: ms })) };
}

describe("Key Builder", () => {
  it("starts with six open keys, text only from them, pseudo-words marked and without translation", async () => {
    const d = await setup();
    const lesson = startKeysLesson(d, deps, projectRoot);
    const open = lesson.keys.filter((k) => k.included).map((k) => k.letter);
    expect(open).toHaveLength(6);
    expect(lesson.lessonNumber).toBe(1);
    expect(lesson.tokens.length).toBeGreaterThan(10);
    for (const t of lesson.tokens) {
      expect([...t.text].every((c) => open.includes(c))).toBe(true);
      if (t.kind === "pseudo") expect(t.translationRu).toBeNull();
    }
    expect(keysOverview(d, projectRoot)).toMatchObject({ nextLesson: 1, openKeys: 6 });
  });

  it("opens the next key once every open key reached the target, keeps raw facts append-only and awards XP and Words time", async () => {
    const d = await setup();
    let lesson = startKeysLesson(d, deps, projectRoot);
    const fast = 60000 / lesson.targetCpm / 1.5; // well above the target
    let result = completeKeysLesson(d, deps, projectRoot, lesson.lessonId, typed(lesson, fast));
    expect(result.targetCpm).toBe(25 * 5); // first stage, no history: the usual 25 WPM, fixed for the stage
    // keys not in the first text have no data yet, so a seventh opens only when all six were typed
    for (let i = 0; i < 6 && result.newKeys.length === 0; i++) {
      lesson = startKeysLesson(d, deps, projectRoot);
      result = completeKeysLesson(d, deps, projectRoot, lesson.lessonId, typed(lesson, fast));
    }
    expect(result.newKeys).toHaveLength(1);
    expect(result.goalCpm).toBe(275); // 55 WPM by default
    expect(result.keys.filter((k) => k.included)).toHaveLength(7);
    expect(result.xpAwarded).toBeGreaterThan(0);
    expect(typingProgress(d).total).toBeGreaterThan(0);
    expect(readJourney(d).totals.words).toBeGreaterThan(0);
    expect(() => d.prepare("UPDATE typing_key_hits SET hits = 0").run()).toThrow(/append-only/);
    expect(() => d.prepare("DELETE FROM typing_key_lessons").run()).toThrow(/append-only/);
    expect(() => d.prepare("UPDATE typing_key_lessons SET errors = 5 WHERE id = ?").run(lesson.lessonId)).toThrow(/never changes/);
  });

  it("a slow key stays focused and nothing opens; an unfinished text cannot complete; abort keeps no key facts", async () => {
    const d = await setup();
    const lesson = startKeysLesson(d, deps, projectRoot);
    const slow = (60000 / lesson.targetCpm) * 2;
    const result = completeKeysLesson(d, deps, projectRoot, lesson.lessonId, typed(lesson, slow));
    expect(result.newKeys).toEqual([]);
    expect(result.keys.find((k) => k.focused)).toBeDefined();
    // the report says what the next letter waits for: the slow keys are not reached on speed
    expect(TypingKeysResultSchema.parse(result).nextKey.letter).toBe(result.keys.find((k) => !k.included)?.letter);
    expect(result.nextKey.keys).toHaveLength(6);
    expect(result.nextKey.progress).toBeGreaterThanOrEqual(0);
    expect(result.nextKey.progress).toBeLessThan(1); // slow keys: the next letter is not at 100%
    expect(result.nextKey.keys.every((k) => k.speedProgress >= 0 && k.speedProgress <= 1 && k.accuracyProgress >= 0 && k.accuracyProgress <= 1 && k.lessons >= 1)).toBe(true);
    expect(result.nextKey.keys.some((k) => !k.speedReached && k.lesson != null && k.lesson.hits > 0)).toBe(true);

    const next = startKeysLesson(d, deps, projectRoot);
    const half = typed(next, 200);
    expect(() => completeKeysLesson(d, deps, projectRoot, next.lessonId, { ...half, charsTyped: 5 })).toThrow(/whole text/);
    // inflated counters (XP) and invented key facts (a key opened for good) are refused
    expect(() => completeKeysLesson(d, deps, projectRoot, next.lessonId, { ...half, charsTyped: 10_000_000 })).toThrow(/whole text/);
    const absent = "abcdefghijklmnopqrstuvwxyz".split("").find((l) => !half.keys.some((k) => k.letter === l))!;
    expect(() => completeKeysLesson(d, deps, projectRoot, next.lessonId, { ...half, keys: [...half.keys, { letter: absent, hits: 0, misses: 0, meanMs: 40 }] })).toThrow(/does not match/);
    expect(() => completeKeysLesson(d, deps, projectRoot, next.lessonId, { ...half, keys: half.keys.slice(1) })).toThrow(/Every letter/);
    expect(() => completeKeysLesson(d, deps, projectRoot, next.lessonId, { ...half, keys: half.keys.map((k, i) => (i === 0 ? { ...k, misses: 3 } : k)) })).toThrow(/misses/);
    expect(() => completeKeysLesson(d, deps, projectRoot, next.lessonId, { ...half, keyStats: [{ pair: "qz", count: 1, totalMs: 100, errors: 0 }] })).toThrow(/Pair qz/);
    expect(() => completeKeysLesson(d, deps, projectRoot, next.lessonId, { ...half, bestCharStreak: 100000 })).toThrow(/streak/);
    const w = next.tokens.find((t) => t.text.length >= 2)!.text;
    completeKeysLesson(d, deps, projectRoot, next.lessonId, { ...half, keyStats: [{ pair: w.slice(0, 2), count: 1, totalMs: 150, errors: 0 }], bestCharStreak: 20 });
    expect((d.prepare("SELECT COUNT(*) AS n FROM typing_key_pairs WHERE lesson_id = ?").get(next.lessonId) as { n: number }).n).toBe(1);
    expect((d.prepare("SELECT best_char_streak AS b FROM typing_key_lessons WHERE id = ?").get(next.lessonId) as { b: number }).b).toBe(20);
    const third = startKeysLesson(d, deps, projectRoot);
    abortKeysLesson(d, deps, third.lessonId, { activeMs: 3000, charsTyped: 10, errors: 1 });
    expect((d.prepare("SELECT COUNT(*) AS n FROM typing_key_hits WHERE lesson_id = ?").get(third.lessonId) as { n: number }).n).toBe(0);
    expect(keysOverview(d, projectRoot).nextLesson).toBe(3);
  });

  it("the target follows the learner's real speed up to the goal; opened keys stay open; analytics forecast the goal", async () => {
    const d = await setup();
    let opened = 6;
    // lessons at 400 ms per key = 150 CPM; then much faster lessons raise the target, which must not close opened keys
    for (let i = 0; i < 12; i++) {
      const lesson = startKeysLesson(d, deps, projectRoot);
      const ms = i < 6 ? 400 : 200 - i * 5;
      const r = completeKeysLesson(d, deps, projectRoot, lesson.lessonId, typed(lesson, ms));
      const open = r.keys.filter((k) => k.included).length;
      expect(open).toBeGreaterThanOrEqual(opened);
      opened = open;
      if (i === 5) expect(r.currentCpm).toBe(150);
      expect(r.targetCpm).toBeLessThanOrEqual(r.goalCpm);
    }
    const a = typingAnalytics(d, { mode: "keys", days: null, timezone: "Australia/Brisbane", now: new Date(clock), projectRoot });
    expect(a.summary.completed).toBe(12);
    expect(a.series.wpm).toHaveLength(12);
    expect(a.series.keyProgress).toHaveLength(12);
    const kp = a.series.keyProgress!;
    expect(kp[0]!.newKeys).toEqual([]);
    // every letter that opened after the first lesson is reported once, on the first lesson that had it open
    const reported = kp.flatMap((p) => p.newKeys);
    expect(new Set(reported).size).toBe(reported.length);
    expect(kp[kp.length - 1]!.open - kp[0]!.open).toBe(reported.length);
    expect(kp.every((p) => p.wpm > 0 && p.accuracy !== null && p.accuracyLimit === 95)).toBe(true);
    expect(a.keyboard!.forecast).not.toBeNull(); // 10+ lessons with a rising trend
    const kb = a.summary.keyBuilder!;
    // each stage keeps the target its first lesson was made with
    const firstOfStage = d.prepare("SELECT target_cpm AS t FROM typing_key_lessons WHERE status = 'completed' AND json_array_length(json_extract(keys_json, '$.open')) = ? ORDER BY ended_at LIMIT 1").get(kb.openKeys) as { t: number } | undefined;
    if (firstOfStage && kb.openKeys < 26) expect(kb.targetCpm).toBe(Math.min(kb.goalCpm, firstOfStage.t));
    const e = a.keyboard!.keys.find((k) => k.letter === "e")!;
    expect(e.cpm).toBeGreaterThan(0);
    expect(e.curve.length).toBe(12);
  });
});
