import { describe, expect, it } from "vitest";
import { applyHint, boardFromOpened, builtWords, clearPlaced, emptyBoard, hintSlot, placeTile, removeAt, removeLast } from "../../../apps/web/src/game/tileBoard.js";

// answer "cat": tiles c a t + two extras (x, a)
const tiles = ["c", "a", "t", "x", "a"];
const word = (b: ReturnType<typeof emptyBoard>) => builtWords(b, tiles, [3]);

describe("tile board", () => {
  it("a hint replaces a wrong letter placed after the hinted ones", () => {
    let b = emptyBoard(3);
    b = applyHint(b, hintSlot(b), "c", tiles);
    b = applyHint(b, hintSlot(b), "a", tiles);
    b = placeTile(b, 3); // wrong "x" in slot 2
    expect(word(b)).toBe("cax");
    b = applyHint(b, hintSlot(b), "t", tiles);
    expect(word(b)).toBe("cat");
    expect(b.locks).toEqual([true, true, true]);
  });
  it("hinted slots cannot be removed, cleared or overwritten by placing", () => {
    let b = applyHint(emptyBoard(3), 1, "a", tiles);
    b = placeTile(b, 0);
    b = placeTile(b, 2);
    expect(word(b)).toBe("cat");
    expect(removeAt(b, 1)).toBe(b);
    expect(word(clearPlaced(b))).toBe("a");
    expect(word(removeLast(b))).toBe("ca");
  });
  it("a locked empty slot is never created and tiles never sit in two slots", () => {
    let b = emptyBoard(3);
    b = placeTile(b, 1); // the first "a" in slot 0
    b = applyHint(b, 1, "a", tiles); // the hint prefers the unplaced "a" (index 4)
    expect(b.placed).toEqual([1, 4, null]);
    b = applyHint(b, 0, "c", tiles);
    expect(b.placed).toEqual([0, 4, null]);
    expect(new Set(b.placed.filter((x) => x !== null)).size).toBe(2);
    expect(applyHint(b, 2, "z", tiles)).toBe(b);
  });
  it("hint on a slot already holding the right letter keeps it and locks it", () => {
    let b = placeTile(emptyBoard(3), 0);
    b = applyHint(b, 0, "C", tiles);
    expect(b.placed[0]).toBe(0);
    expect(b.locks[0]).toBe(true);
  });
  it("a hint moves a letter from another unlocked slot when no spare tile is left", () => {
    const t = ["c", "a", "t"];
    let b = emptyBoard(3);
    b = placeTile(b, 1); // a in slot 0
    b = applyHint(b, 0, "c", t); // slot 0 gets c; a goes back to the pool
    expect(b.placed).toEqual([0, null, null]);
  });
  it("opened letters are placed and locked when switching to tiles", () => {
    const b = boardFromOpened(3, tiles, (k) => (k === 2 ? "t" : null));
    expect(b.placed).toEqual([null, null, 2]);
    expect(b.locks).toEqual([false, false, true]);
  });
  it("multi-word patterns build the words with a space", () => {
    const t = ["a", "b", "c", "d"];
    let b = emptyBoard(4);
    for (let i = 0; i < 4; i++) b = placeTile(b, i);
    expect(builtWords(b, t, [2, 2])).toBe("ab cd");
  });
});
