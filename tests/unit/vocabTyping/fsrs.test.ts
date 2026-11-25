import { describe, expect, it } from "vitest";
import { dueDate, replayCard, type RatedReview } from "../../../apps/server/src/domain/vocabTyping/fsrs.js";
import { learningDate } from "../../../apps/server/src/domain/journey/calendar.js";
import { summarise, type VtFact, type VtFactKind } from "../../../apps/server/src/domain/vocabTyping/state.js";

const r = (rating: "good" | "again", at: string): RatedReview => ({ rating, at });
const facts = (...rows: Array<[VtFactKind, string, string]>): VtFact[] => rows.map(([kind, at, date]) => ({ kind, at, date }));

describe("FSRS replay (vt-fsrs-v1)", () => {
  it("has no card before the first rated check", () => {
    expect(replayCard([], 0.9)).toBeNull();
  });

  it("is deterministic (no fuzz): the same reviews give the same card, and later checks come further apart after good answers", () => {
    const rs = [r("good", "2026-11-25T01:00:00Z"), r("good", "2026-11-29T01:00:00Z"), r("good", "2026-12-10T01:00:00Z")];
    const a = replayCard(rs, 0.9)!;
    const b = replayCard(rs, 0.9)!;
    expect(a.due.toISOString()).toBe(b.due.toISOString());
    const one = replayCard(rs.slice(0, 1), 0.9)!;
    const two = replayCard(rs.slice(0, 2), 0.9)!;
    expect(two.due.getTime() - Date.parse(rs[1]!.at)).toBeGreaterThan(one.due.getTime() - Date.parse(rs[0]!.at));
    expect(a.lapses).toBe(0);
  });

  it("a failed check is a lapse on the SAME card, and its history is kept", () => {
    const good = replayCard([r("good", "2026-11-25T01:00:00Z"), r("good", "2026-11-29T01:00:00Z")], 0.9)!;
    const lapsed = replayCard([r("good", "2026-11-25T01:00:00Z"), r("good", "2026-11-29T01:00:00Z"), r("again", "2026-12-20T01:00:00Z")], 0.9)!;
    expect(lapsed.lapses).toBe(1);
    expect(lapsed.reps).toBe(3);
    expect(lapsed.stability).toBeLessThan(good.stability);
    const after = replayCard([r("good", "2026-11-25T01:00:00Z"), r("good", "2026-11-29T01:00:00Z"), r("again", "2026-12-20T01:00:00Z"), r("good", "2026-12-21T01:00:00Z")], 0.9)!;
    expect(after.reps).toBe(4);
    expect(after.lapses).toBe(1);
  });

  it("a higher requested retention schedules sooner", () => {
    const rs = [r("good", "2026-11-25T01:00:00Z"), r("good", "2026-11-29T01:00:00Z")];
    expect(replayCard(rs, 0.97)!.due.getTime()).toBeLessThan(replayCard(rs, 0.8)!.due.getTime());
  });

  it("a self-assessed Learned is checked after N learning days; a verified word follows its card; other states have no check", () => {
    const awaiting = summarise(facts(["screen_unknown", "2026-11-24T02:00:00Z", "2026-11-24"], ["learn_learned", "2026-11-24T03:00:00Z", "2026-11-24"]));
    expect(dueDate(awaiting, [], 0.9, 1)).toBe("2026-11-25");
    expect(dueDate(awaiting, [], 0.9, 3)).toBe("2026-11-27");
    const verified = summarise(facts(["screen_unknown", "2026-11-24T02:00:00Z", "2026-11-24"], ["learn_learned", "2026-11-24T03:00:00Z", "2026-11-24"], ["review_good", "2026-11-25T03:00:00Z", "2026-11-25"]));
    const due = dueDate(verified, [r("good", "2026-11-25T03:00:00Z")], 0.9, 1)!;
    expect(due > "2026-11-25").toBe(true);
    expect(dueDate(summarise(facts(["screen_known", "2026-11-24T02:00:00Z", "2026-11-24"])), [], 0.9, 1)).toBeNull();
    expect(dueDate(summarise(facts(["screen_unknown", "2026-11-24T02:00:00Z", "2026-11-24"])), [], 0.9, 1)).toBeNull();
  });

  it("the learning day changes at 01:00 Brisbane time, so a late-night answer is still on the same day", () => {
    // 2026-11-24T14:30Z is 00:30 on Nov 25 in Brisbane: still learning day Nov 24; 15:30Z is 01:30: Nov 25
    expect(learningDate(Date.parse("2026-11-24T14:30:00Z"))).toBe("2026-11-24");
    expect(learningDate(Date.parse("2026-11-24T15:30:00Z"))).toBe("2026-11-25");
  });
});
