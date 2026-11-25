import { afterEach, describe, expect, it } from "vitest";
import { buildOverview, listWords, restoreWord } from "../../../apps/server/src/domain/vocabTyping/overview.js";
import { prepareLexicon } from "../../../apps/server/src/domain/vocabTyping/lexicon.js";
import { completeSession, recordActivity, recordScreening, startScreening } from "../../../apps/server/src/domain/vocabTyping/sessions.js";
import { sessionState } from "../../../apps/server/src/domain/vocabTyping/view.js";
import { makeDeps, seedPool, setup, typing, uuid, type Env } from "./fixtures.js";
import { SCREENING_LOOKAHEAD, type VtScreeningCard } from "@english-lab/contracts";

let env: Env | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

const xp = (db: Env["db"]): number => (db.prepare("SELECT COALESCE(SUM(amount),0) AS n FROM mode_xp_events WHERE source = 'vocabTyping'").get() as { n: number }).n;
const planOf = (db: Env["db"], id: string): Array<{ lemma: string; probe: boolean }> => (JSON.parse((db.prepare("SELECT plan_json AS p FROM vocab_typing_sessions WHERE id = ?").get(id) as { p: string }).p) as { words: Array<{ lemma: string; probe: boolean }> }).words;
const answer = (db: Env["db"], deps: ReturnType<typeof makeDeps>, sessionId: string, kind: "screen_known" | "screen_unknown" | "screen_archived" = "screen_known", clientEventId = uuid()): string => {
  const card = sessionState(db, sessionId).card as VtScreeningCard;
  recordScreening(db, deps, sessionId, { clientEventId, tabId: "t", lemma: card.word.lemma, kind, typing });
  return card.word.lemma;
};

describe("vtyping:prepare", () => {
  it("gives every word its rank and band, is idempotent and never touches a cleanup decision", async () => {
    env = await setup();
    const { db } = env;
    const { csv } = seedPool(db, 1500);
    expect(db.prepare("SELECT freq_rank AS r, band FROM vocab_typing_lexicon WHERE lemma = 'waaa'").get()).toEqual({ r: 1, band: 1 });
    expect(db.prepare("SELECT band FROM vocab_typing_lexicon WHERE freq_rank = 1001").get()).toEqual({ band: 2 });
    db.prepare("UPDATE vocab_typing_lexicon SET eligibility = 'excluded', exclusion_reason = 'name' WHERE lemma = 'waab'").run();
    const again = prepareLexicon(db, csv, new Date());
    expect(again).toMatchObject({ inserted: 0, updated: 0, unchanged: 1500, withoutRank: 0 });
    expect(db.prepare("SELECT eligibility, exclusion_reason AS r FROM vocab_typing_lexicon WHERE lemma = 'waab'").get()).toEqual({ eligibility: "excluded", r: "name" });
    // the word bank is only read
    expect((db.prepare("SELECT COUNT(*) AS n FROM typing_word_bank").get() as { n: number }).n).toBe(1500);
    // a changed order moves the ranks without colliding with itself
    const swapped = csv.replace("1;waaa", "x;waaa").replace("2;waab", "1;waab").replace("x;waaa", "2;waaa");
    expect(prepareLexicon(db, swapped, new Date())).toMatchObject({ updated: 2, unchanged: 1498 });
    expect(db.prepare("SELECT freq_rank AS r FROM vocab_typing_lexicon WHERE lemma = 'waab'").get()).toEqual({ r: 1 });
  });
});

describe("Vocabulary Typing screening", () => {
  it("plans a batch of unscreened words, never an excluded one, and is the same for the same ids", async () => {
    env = await setup();
    const { db } = env;
    seedPool(db, 400);
    db.prepare("UPDATE vocab_typing_lexicon SET eligibility = 'excluded' WHERE freq_rank <= 5").run();
    const deps = makeDeps();
    const { sessionId, resumed } = startScreening(db, deps, "t");
    expect(resumed).toBe(false);
    const plan = planOf(db, sessionId);
    expect(plan).toHaveLength(20);
    expect(plan.filter((w) => w.probe)).toHaveLength(5);
    const excluded = new Set(["waaa", "waab", "waac", "waad", "waae"]);
    expect(plan.some((w) => excluded.has(w.lemma))).toBe(false);
    // the card the learner gets does not say whether a word is a probe
    expect(JSON.stringify(sessionState(db, sessionId).card)).not.toContain("probe");
    const second = await setup();
    try {
      seedPool(second.db, 400);
      second.db.prepare("UPDATE vocab_typing_lexicon SET eligibility = 'excluded' WHERE freq_rank <= 5").run();
      const again = startScreening(second.db, makeDeps(), "t");
      expect(planOf(second.db, again.sessionId)).toEqual(plan);
    } finally {
      second.cleanup();
    }
  });

  it("the screening card carries the next words, in plan order, and they move up as words are answered", async () => {
    env = await setup();
    const { db } = env;
    seedPool(db, 400);
    const deps = makeDeps();
    const { sessionId } = startScreening(db, deps, "t");
    const plan = planOf(db, sessionId).map((w) => w.lemma);
    const first = sessionState(db, sessionId).card as VtScreeningCard;
    expect(first.word.lemma).toBe(plan[0]);
    expect(first.upcoming.map((w) => w.lemma)).toEqual(plan.slice(1, 1 + SCREENING_LOOKAHEAD));
    answer(db, deps, sessionId);
    const second = sessionState(db, sessionId).card as VtScreeningCard;
    expect(second.word.lemma).toBe(plan[1]);
    expect(second.upcoming.map((w) => w.lemma)).toEqual(plan.slice(2, 2 + SCREENING_LOOKAHEAD));
    expect(second.upcoming.length).toBe(plan.length - 2);
  });

  it("writes one decision per word with XP, and the same client id again changes nothing", async () => {
    env = await setup();
    const { db } = env;
    seedPool(db, 200);
    const deps = makeDeps();
    const { sessionId } = startScreening(db, deps, "t");
    const id = uuid();
    const lemma = answer(db, deps, sessionId, "screen_known", id);
    expect(xp(db)).toBe(1);
    recordScreening(db, deps, sessionId, { clientEventId: id, tabId: "t", lemma, kind: "screen_known", typing });
    expect((db.prepare("SELECT COUNT(*) AS n FROM vocab_typing_events").get() as { n: number }).n).toBe(1);
    expect(xp(db)).toBe(1);
    expect(() => recordScreening(db, deps, sessionId, { clientEventId: id, tabId: "t", lemma, kind: "screen_unknown", typing })).toThrow(/already used/);
    expect(() => recordScreening(db, deps, sessionId, { clientEventId: uuid(), tabId: "t", lemma, kind: "screen_unknown", typing })).toThrow(/already answered/);
    expect(() => recordScreening(db, deps, sessionId, { clientEventId: uuid(), tabId: "other", lemma: "zzz", kind: "screen_known", typing })).toThrow(/another tab/);
    expect(() => recordScreening(db, deps, sessionId, { clientEventId: uuid(), tabId: "t", lemma: "notinplan", kind: "screen_known", typing })).toThrow(/not part of the session/);
    answer(db, deps, sessionId, "screen_unknown");
    expect(xp(db)).toBe(2);
    answer(db, deps, sessionId, "screen_archived");
    expect(xp(db)).toBe(2); // excluding a word earns nothing
    // My Vocabulary is not touched
    expect((db.prepare("SELECT COUNT(*) AS n FROM vocabulary_entries").get() as { n: number }).n).toBe(0);
  });

  it("an interrupted session keeps its answers and continues with the unanswered words; a finished one is not repeated", async () => {
    env = await setup();
    const { db } = env;
    seedPool(db, 200);
    const deps = makeDeps();
    const first = startScreening(db, deps, "t");
    const done = [answer(db, deps, first.sessionId), answer(db, deps, first.sessionId, "screen_unknown")];
    const again = startScreening(db, deps, "t2");
    expect(again).toEqual({ sessionId: first.sessionId, resumed: true });
    const next = sessionState(db, again.sessionId).card as VtScreeningCard;
    expect(done).not.toContain(next.word.lemma);
    expect(sessionState(db, again.sessionId).progress).toEqual({ done: 2, total: 20 });
    // the old tab no longer holds the session
    expect(() => recordScreening(db, deps, first.sessionId, { clientEventId: uuid(), tabId: "t", lemma: next.word.lemma, kind: "screen_known", typing })).toThrow(/another tab/);
    // finish all and complete: metrics come from the decisions
    while (sessionState(db, first.sessionId).card) {
      const lemma = (sessionState(db, first.sessionId).card as VtScreeningCard).word.lemma;
      recordScreening(db, deps, first.sessionId, { clientEventId: uuid(), tabId: "t2", lemma, kind: "screen_known", typing });
    }
    const state = sessionState(db, first.sessionId);
    expect(state.finished).toBe(true);
    completeSession(db, deps, first.sessionId, "t2");
    const metrics = sessionState(db, first.sessionId).metrics!;
    expect(metrics).toMatchObject({ activeMs: 20 * 1200, charsTyped: 100, errors: 20, accuracy: 83.3 });
    expect(metrics.wpm).toBeCloseTo(100 / 5 / (24 / 60), 0);
    const second = startScreening(db, deps, "t2");
    expect(second.resumed).toBe(false);
    const screened = new Set((db.prepare("SELECT lemma FROM vocab_typing_events").all() as Array<{ lemma: string }>).map((r) => r.lemma));
    expect(planOf(db, second.sessionId).some((w) => screened.has(w.lemma))).toBe(false);
  });

  it("the overview counts the pool without excluded words, and a learner exclusion can be restored", async () => {
    env = await setup();
    const { db } = env;
    seedPool(db, 120);
    db.prepare("UPDATE vocab_typing_lexicon SET eligibility = 'excluded' WHERE freq_rank <= 20").run();
    const deps = makeDeps();
    expect(buildOverview(db, deps)).toMatchObject({ poolSize: 100, prepared: true, screening: { screened: 0, remaining: 100 } });
    const { sessionId } = startScreening(db, deps, "t");
    answer(db, deps, sessionId, "screen_known");
    answer(db, deps, sessionId, "screen_unknown");
    const out = answer(db, deps, sessionId, "screen_archived");
    expect(buildOverview(db, deps)).toMatchObject({ poolSize: 99, screening: { screened: 2, known: 1, unknown: 1, notUseful: 1, remaining: 97 }, learning: { learning: 1 } });
    expect(listWords(db, { filter: "excluded", limit: 200, offset: 0 }).total).toBe(21);
    restoreWord(db, deps, out);
    expect(listWords(db, { filter: "unscreened", search: out, limit: 10, offset: 0 }).words).toHaveLength(1);
    expect(buildOverview(db, deps).poolSize).toBe(100);
    expect(() => restoreWord(db, deps, out)).toThrow(/not archived/);
    // a restored word can be drawn again, a not-restored excluded one is not
    completeSession(db, deps, sessionId, "t");
    const s2 = startScreening(db, deps, "t");
    expect(planOf(db, s2.sessionId).length).toBeGreaterThan(0);
  });

  it("measured time is written once, never overlaps another interval and is refused for a stranger's tab", async () => {
    env = await setup();
    const { db } = env;
    seedPool(db, 60);
    const deps = makeDeps("2026-11-24T10:00:00.000Z");
    const { sessionId } = startScreening(db, deps, "t");
    const start = Date.parse("2026-11-24T10:00:00.000Z");
    deps.advance(20_000);
    const a = { id: uuid(), tabId: "t", startMs: start, endMs: start + 10_000 };
    expect(recordActivity(db, deps, sessionId, a)).toEqual({ recorded: true });
    expect(recordActivity(db, deps, sessionId, a)).toEqual({ recorded: false });
    expect(() => recordActivity(db, deps, sessionId, { ...a, id: uuid(), startMs: start + 5_000, endMs: start + 12_000 })).toThrow(/overlaps/);
    expect(() => recordActivity(db, deps, sessionId, { ...a, id: uuid(), tabId: "x", startMs: start + 11_000, endMs: start + 12_000 })).toThrow(/another tab/);
    // the other writers see the interval too
    db.prepare("INSERT INTO journey_typing_intervals(id, session_id, mode, start_ms, end_ms, recorded_at) VALUES ('p1','s','words',?,?,'x')").run(start + 14_000, start + 15_000);
    expect(() => recordActivity(db, deps, sessionId, { ...a, id: uuid(), startMs: start + 14_500, endMs: start + 16_000 })).toThrow(/overlaps/);
  });
});
