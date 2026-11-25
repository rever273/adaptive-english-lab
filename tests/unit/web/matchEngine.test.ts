import { describe, expect, it } from "vitest";
import { matchResults, COOLDOWN, ROUNDS, clearWrong, createMatch, pickCell, replacePair, rushRows, type Cell, type MatchState, type MatchWord } from "../../../apps/web/src/game/matchEngine.js";

const words = (n: number): MatchWord[] => Array.from({ length: n }, (_, i) => ({ id: `w${i}`, en: `word${i}`, ru: `слово${i}` }));
const seeded = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const live = (cells: Array<Cell | null>) => cells.filter((c): c is Cell => c !== null && !c.matched);
const cellOf = (s: MatchState, side: "left" | "right", wordId: string) => (side === "left" ? s.left : s.right).find((c) => c?.wordId === wordId && !c.matched)!;

describe("matching game: selection", () => {
  it("selects, unselects on a second tap, and moves the selection inside one column", () => {
    let s = createMatch(words(4), "once", seeded(1));
    const [a, b] = live(s.left);
    s = pickCell(s, "left", a!.key).state;
    expect(s.selected).toEqual({ side: "left", key: a!.key });
    s = pickCell(s, "left", a!.key).state;
    expect(s.selected).toBeNull();
    s = pickCell(s, "left", a!.key).state;
    s = pickCell(s, "left", b!.key).state;
    expect(s.selected).toEqual({ side: "left", key: b!.key });
  });

  it("matches in both directions and ignores matched buttons", () => {
    for (const first of ["left", "right"] as const) {
      let s = createMatch(words(4), "once", seeded(2));
      const second = first === "left" ? "right" : "left";
      s = pickCell(s, first, cellOf(s, first, "w1").key).state;
      const r = pickCell(s, second, cellOf(s, second, "w1").key);
      expect(r.event).toMatchObject({ kind: "match", wordId: "w1" });
      expect(r.state.selected).toBeNull();
      expect(r.state.matches).toBe(1);
      const matched = r.state.left.find((c) => c?.wordId === "w1")!;
      expect(matched.matched).toBe(true);
      expect(pickCell(r.state, "left", matched.key).state).toBe(r.state);
    }
  });

  it("a wrong pair is marked, the selection disappears, nothing is matched, and clicks wait until it is cleared", () => {
    let s = createMatch(words(4), "once", seeded(3));
    s = pickCell(s, "left", cellOf(s, "left", "w0").key).state;
    const r = pickCell(s, "right", cellOf(s, "right", "w1").key);
    expect(r.event).toEqual({ kind: "wrong" });
    expect(r.state.selected).toBeNull();
    expect(r.state.wrong).not.toBeNull();
    expect(r.state.matches).toBe(0);
    expect(pickCell(r.state, "left", cellOf(r.state, "left", "w2").key).state).toBe(r.state);
    const cleared = clearWrong(r.state);
    expect(cleared.wrong).toBeNull();
    expect(live(cleared.left)).toHaveLength(4);
    expect(pickCell(cleared, "left", cellOf(cleared, "left", "w2").key).state.selected).not.toBeNull();
  });

  it("once mode finishes after every word is matched exactly once", () => {
    let s = createMatch(words(5), "once", seeded(4));
    expect(s.total).toBe(5);
    for (let i = 0; i < 5; i++) {
      s = pickCell(s, "left", cellOf(s, "left", `w${i}`).key).state;
      s = pickCell(s, "right", cellOf(s, "right", `w${i}`).key).state;
      expect(s.done).toBe(i === 4);
    }
    expect(pickCell(s, "left", s.left[0]!.key).state).toBe(s);
  });
});

describe("matching game: rush mode", () => {
  it("the repeat count is the setting: 3 by default, another value changes the total and nothing else", () => {
    expect(ROUNDS).toBe(3);
    for (const rounds of [1, 3, 7, 10]) {
      const s = createMatch(words(6), "rush", seeded(11), rounds);
      expect(s.total).toBe(6 * rounds);
      expect(Object.values(s.remaining).every((n) => n === rounds)).toBe(true);
    }
    expect(createMatch(words(6), "once", seeded(12), 7).total).toBe(6);
  });

  it("shows at most 5 rows and fewer for small word lists", () => {
    expect([3, 4, 5, 6, 8].map(rushRows)).toEqual([2, 3, 4, 5, 5]);
    expect(live(createMatch(words(8), "rush", seeded(5)).left)).toHaveLength(5);
  });

  it("needs every word matched ROUNDS times, keeps both columns on the same words, never shows a word twice, and honours the cool-down", () => {
    for (const n of [3, 4, 5, 6, 8]) {
      for (let seed = 1; seed <= 20; seed++) {
        const rng = seeded(seed * 31 + n);
        let s = createMatch(words(n), "rush", rng);
        expect(s.total).toBe(n * ROUNDS);
        const counts: Record<string, number> = {};
        let guard = 0;
        while (!s.done && guard++ < 1000) {
          const L = live(s.left);
          const R = live(s.right);
          const ids = L.map((c) => c.wordId);
          expect(new Set(ids).size).toBe(ids.length);
          expect([...ids].sort()).toEqual(R.map((c) => c.wordId).sort());
          // sometimes click a wrong pair first
          if (rng() < 0.3 && L.length > 1) {
            const a = L[0]!;
            const b = R.find((c) => c.wordId !== a.wordId)!;
            let w = pickCell(s, "left", a.key).state;
            w = pickCell(w, "right", b.key).state;
            expect(w.wrong).not.toBeNull();
            s = clearWrong(w);
          }
          const target = live(s.left)[Math.floor(rng() * live(s.left).length)]!;
          const first = rng() < 0.5 ? "left" : "right";
          const second = first === "left" ? "right" : "left";
          s = pickCell(s, first, cellOf(s, first, target.wordId).key).state;
          const r = pickCell(s, second, cellOf(s, second, target.wordId).key);
          s = r.state;
          counts[target.wordId] = (counts[target.wordId] ?? 0) + 1;
          expect(r.event).toMatchObject({ kind: "match" });
          if (r.event?.kind === "match" && !s.done) {
            const before = s.recent.slice(-1 - COOLDOWN, -1);
            s = replacePair(s, r.event.leftKey, r.event.rightKey, rng);
            // when there are enough words, the word that was just matched does not come straight back
            const back = live(s.left).some((c) => c.wordId === target.wordId);
            if (n - rushRows(n) >= COOLDOWN + 1) expect(back).toBe(false);
            expect(before.length).toBeLessThanOrEqual(COOLDOWN);
            // a pair that is already replaced is not replaced again
            expect(replacePair(s, r.event.leftKey, r.event.rightKey, rng)).toBe(s);
          }
        }
        expect(s.done).toBe(true);
        expect(guard).toBeLessThan(1000);
        // the game ends when ONE word is left to go: every other word was matched ROUNDS times, the last one at least once less than needed or fully
        const short = Array.from({ length: n }, (_, i) => `w${i}`).filter((id) => (counts[id] ?? 0) < ROUNDS);
        expect(short.length).toBeLessThanOrEqual(1);
        expect(s.matches).toBe(Object.values(counts).reduce((a, b) => a + b, 0));
        for (const [id, c] of Object.entries(counts)) expect(s.stats[id]!.matched).toBe(c);
      }
    }
  });

  it("a word does not return before COOLDOWN other pairs when there are enough words", () => {
    const rng = seeded(99);
    let s = createMatch(words(10), "rush", rng);
    const order: string[] = [];
    for (let i = 0; i < 40 && !s.done; i++) {
      const target = live(s.left)[0]!;
      s = pickCell(s, "left", target.key).state;
      const r = pickCell(s, "right", cellOf(s, "right", target.wordId).key);
      s = r.state;
      order.push(target.wordId);
      if (r.event?.kind === "match" && !s.done) s = replacePair(s, r.event.leftKey, r.event.rightKey, rng);
    }
    // the very end (the last words) cannot wait that long; check while enough words are still in play
    for (let i = 0; i < order.length - 12; i++) for (let j = i + 1; j <= i + COOLDOWN && j < order.length; j++) expect(order[j]).not.toBe(order[i]);
  });
});

describe("matching game: ending and results", () => {
  it("rush ends when only one word is left, and reports raw matched / wrong counts per word", () => {
    let s = createMatch(words(3), "rush", seeded(7));
    // wrong pair w/ two words: both are charged
    const a = live(s.left)[0]!;
    const b = live(s.right).find((c) => c.wordId !== a.wordId)!;
    s = clearWrong(pickCell(pickCell(s, "left", a.key).state, "right", b.key).state);
    expect(s.stats[a.wordId]!.wrong).toBe(1);
    expect(s.stats[b.wordId]!.wrong).toBe(1);
    // finish two of the three words completely; the third stays at 0 and is accepted as the last one
    const rng = seeded(8);
    const keep = Object.keys(s.remaining).find((id) => id !== a.wordId && id !== b.wordId) ?? a.wordId;
    let guard = 0;
    while (!s.done && guard++ < 200) {
      const target = live(s.left).find((c) => c.wordId !== keep) ?? live(s.left)[0]!;
      s = pickCell(s, "left", target.key).state;
      const r = pickCell(s, "right", cellOf(s, "right", target.wordId).key);
      s = r.state;
      if (r.event?.kind === "match" && !s.done) s = replacePair(s, r.event.leftKey, r.event.rightKey, rng);
    }
    expect(s.done).toBe(true);
    const res = matchResults(s);
    expect(res).toHaveLength(3);
    expect(res.filter((r) => r.matched < ROUNDS).length).toBeLessThanOrEqual(1);
    expect(res.reduce((n, r) => n + r.matched, 0)).toBe(s.matches);
  });

  it("once mode still needs every pair", () => {
    let s = createMatch(words(3), "once", seeded(9));
    for (const id of ["w0", "w1"]) { s = pickCell(s, "left", cellOf(s, "left", id).key).state; s = pickCell(s, "right", cellOf(s, "right", id).key).state; }
    expect(s.done).toBe(false);
  });
  it("puts the returning pair on a different row in each column, so the same two keys do not keep matching", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rng = seeded(seed);
      let s = createMatch(words(8), "rush", rng);
      for (let k = 0; k < 20 && !s.done; k++) {
        // always the first open row of both columns, as a player pressing 1 and Alt+1 would
        const l = s.left.findIndex((c) => c && !c.matched);
        const target = s.left[l]!;
        const r = s.right.findIndex((c) => c && !c.matched && c.wordId === target.wordId);
        const first = pickCell(s, "left", target.key).state;
        const res = pickCell(first, "right", s.right[r]!.key);
        s = res.state;
        if (s.done || res.event?.kind !== "match") break;
        s = replacePair(s, res.event.leftKey, res.event.rightKey, rng);
        const fresh = s.left[l];
        if (fresh && !fresh.matched) expect(s.right[l]?.wordId).not.toBe(fresh.wordId);
        expect([...s.left.filter((c) => c && !c.matched).map((c) => c!.wordId)].sort()).toEqual([...s.right.filter((c) => c && !c.matched).map((c) => c!.wordId)].sort());
      }
    }
  });
});
