import { describe, expect, it } from "vitest";
import { wordStrength, type Evidence } from "../../../apps/server/src/domain/vocabulary/strength.js";

// noon in Brisbane on consecutive days, and "now" one minute after the last event (decay is then negligible)
const at = (day: number, minute = 0) => new Date(Date.UTC(2026, 10, 1 + day, 2, minute)).toISOString();
const now = (day: number) => new Date(Date.parse(at(day)) + 60_000);
const e = (day: number, source: Evidence["source"], w: number, s: number, minute = 0): Evidence => ({ at: at(day, minute), source, w, s });

describe("word-strength-v1", () => {
  it("is 0 with no evidence and grows slowly: one success is 3.3, three on three days 6.7", () => {
    expect(wordStrength([], now(0)).value).toBe(0);
    expect(wordStrength([e(0, "practice", 1, 1)], now(0)).value).toBe(3.3);
    expect(wordStrength([e(0, "practice", 1, 1), e(1, "practice", 1, 1), e(2, "practice", 1, 1)], now(2)).value).toBe(6.7);
  });

  it("does not grow from pressing Recalled again on the same day (daily cap) and counts another day more", () => {
    const once = wordStrength([e(0, "contextLoop", 0.2, 1)], now(0)).value;
    expect(once).toBe(0.9);
    const grind = wordStrength(Array.from({ length: 20 }, (_, i) => e(0, "contextLoop", 0.6, 1, i)), now(0)).value;
    expect(grind).toBe(wordStrength([e(0, "contextLoop", 1.5, 1)], now(0)).value);
    const sameDay = wordStrength([e(0, "practice", 1, 1), e(0, "contextLoop", 0.6, 1, 5)], now(0)).value;
    const nextDay = wordStrength([e(0, "practice", 1, 1), e(1, "contextLoop", 0.6, 1)], now(1)).value;
    expect(nextDay).toBeGreaterThan(sameDay);
  });

  it("misses pull it down, one check does not outweigh a long history, and old evidence fades", () => {
    const good = Array.from({ length: 6 }, (_, d) => e(d, "practice", 1, 1));
    const withMiss = wordStrength([...good, e(6, "checks", 1, 0)], now(6)).value;
    expect(withMiss).toBeLessThan(wordStrength(good, now(6)).value);
    expect(withMiss).toBeGreaterThan(6);
    const fresh = wordStrength([e(0, "practice", 1, 1)], now(0)).value;
    const old = wordStrength([e(0, "practice", 1, 1), e(0, "practice", 1, 0, 5)], new Date(Date.parse(at(0)) + 180 * 86_400_000)).value;
    expect(old).toBeLessThan(fresh);
  });
});
