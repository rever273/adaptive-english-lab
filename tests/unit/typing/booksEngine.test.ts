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

  it("counts active time from the scene clock, with each gap capped at 5 seconds", () => {
    const s = createBooksEngine(cfg("cat"));
    tickBooks(s, 2000);
    handleBookKey(s, "c");
    tickBooks(s, 20_000);
    handleBookKey(s, "a");
    expect(s.activeMs).toBe(2000 + 5000);
  });

  it("does not count Backspace as a typed character", () => {
    const s = createBooksEngine(cfg("cat"));
    handleBookKey(s, "x");
    handleBookKey(s, "Backspace");
    expect(s.charsTyped).toBe(1);
    expect(s.errorCount).toBe(1);
  });

  it("ignores a space that is not expected: no error, nothing counted", () => {
    const s = createBooksEngine(cfg("cat"));
    const r = handleBookKey(s, " ");
    expect(r.kind).toBe("ignored");
    expect(s.errorCount).toBe(0);
    expect(s.charsTyped).toBe(0);
    expect(s.errors).toEqual([]);
  });

  it("remembers which letters were typed after a mistake", () => {
    const s = createBooksEngine(cfg("cat"));
    handleBookKey(s, "c");
    handleBookKey(s, "x");
    handleBookKey(s, "Backspace");
    handleBookKey(s, "a");
    expect([...s.slipped]).toEqual([1]);
  });

  it("accepts a lower-case letter where a capital is expected as a reminder, not an error", () => {
    const s = createBooksEngine(cfg("Winston ran."));
    const r = handleBookKey(s, "w");
    expect(r.kind).toBe("capital");
    expect(s.errorCount).toBe(0);
    expect(s.offset).toBe(1);
    expect([...s.capsMissed]).toEqual([0]);
    expect(handleBookKey(s, "i").kind).toBe("ok");
  });

  it("clears the capital reminder when the letter is retyped with Shift", () => {
    const s = createBooksEngine(cfg("Winston"));
    handleBookKey(s, "w");
    handleBookKey(s, "Backspace");
    expect(handleBookKey(s, "W").kind).toBe("ok");
    expect(s.capsMissed.size).toBe(0);
  });

  it("splits the text into word tokens, one per meteor", () => {
    const s = createBooksEngine(cfg("It was a day. Then night."));
    expect(s.tokens.map((t) => s.text.slice(t.startOffset, t.endOffset))).toEqual(["It", "was", "a", "day.", "Then", "night."]);
  });
});
