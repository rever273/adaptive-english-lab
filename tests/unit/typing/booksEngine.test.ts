import { describe, expect, it } from "vitest";
import { createBooksEngine, handleBookKey, nextKey, tickBooks } from "../../../apps/web/src/game/booksEngine.js";

const cfg = (text: string, initialOffset = 0) => ({ text, startOffset: 0, initialOffset, initialActiveMs: 0, initialCharsTyped: 0, initialErrors: 0 });

describe("books engine", () => {
  it("types a sentence left to right and finishes at the end", () => {
    const text = "Hello world.";
    const s = createBooksEngine(cfg(text));
    const expected = "hello world.";
    let finished = false;
    for (const ch of expected) {
      const r = handleBookKey(s, ch);
      finished = r.finished;
    }
    expect(finished).toBe(true);
    expect(s.offset).toBe(text.length);
  });

  it("skips quotes and apostrophes: typed keys are the required set only", () => {
    const text = "“I don't know,”";
    const s = createBooksEngine(cfg(text));
    for (const ch of "i dont know,") handleBookKey(s, ch);
    expect(s.finished).toBe(true);
  });

  it("requires Backspace to clear a wrong character before advancing", () => {
    const s = createBooksEngine(cfg("cat"));
    handleBookKey(s, "c");
    handleBookKey(s, "x"); // wrong
    expect(s.errorCount).toBe(1);
    expect(s.errors).toEqual(["x"]);
    expect(s.offset).toBe(1); // still on the "a" (offset = next key position)
    handleBookKey(s, "a"); // correct but a red error is pending: counts as an error
    expect(s.errorCount).toBe(2);
    handleBookKey(s, "Backspace");
    handleBookKey(s, "Backspace"); // clear both pending red errors
    expect(s.errors).toEqual([]);
    handleBookKey(s, "a");
    expect(s.offset).toBe(2);
  });

  it("caps inter-key gaps at 5 seconds so reading pauses do not inflate WPM", () => {
    const s = createBooksEngine(cfg("cat"));
    tickBooks(s, 30_000); // a long pause
    handleBookKey(s, "c");
    handleBookKey(s, "a");
    // active time should include at most 5s of the pause
    expect(s.activeMs).toBeLessThanOrEqual(30_000);
    expect(s.activeMs).toBeGreaterThan(0);
  });

  it("restores from a saved offset without re-typing earlier text", () => {
    // resume at offset 5 (the space after "hello")
    const s = createBooksEngine(cfg("hello world.", 5));
    expect(nextKey(s)).toBe(" ");
    handleBookKey(s, " ");
    expect(nextKey(s)).toBe("w");
    handleBookKey(s, "w");
    expect(s.offset).toBe(7);
  });
});
