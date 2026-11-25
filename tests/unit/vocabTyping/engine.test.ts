import { describe, expect, it } from "vitest";
import { createTyper, keyStatsOf, typeKey, typingFacts, typingTarget } from "../../../apps/web/src/game/vocabTypeEngine.js";

function type(text: string, keys: string, step = 200) {
  let s = createTyper(text);
  let t = 1000;
  for (const k of keys) {
    s = typeKey(s, k, t).state;
    t += step;
  }
  return s;
}

describe("vocabulary typing engine", () => {
  it("advances on right keys, counts a wrong key without moving and without erasing", () => {
    let s = createTyper("cat");
    s = typeKey(s, "c", 0).state;
    const bad = typeKey(s, "x", 100);
    expect(bad.result).toBe("error");
    expect(bad.state).toMatchObject({ pos: 1, errors: 1, wrong: true, chars: 1 });
    const ok = typeKey(bad.state, "a", 200);
    expect(ok.state).toMatchObject({ pos: 2, wrong: false, errors: 1 });
    expect(typeKey(ok.state, "t", 300).state.done).toBe(true);
  });

  it("ignores keys that are not one character and keys after the end", () => {
    const s = createTyper("hi");
    expect(typeKey(s, "Shift", 0).result).toBe("ignored");
    expect(typeKey(s, "F4", 0).result).toBe("ignored");
    expect(typeKey(s, "Tab", 0).result).toBe("ignored");
    const done = type("hi", "hi");
    expect(typeKey(done, "x", 9999).result).toBe("ignored");
  });

  it("accepts a capital typed in lower case, and sentence punctuation", () => {
    const s = type("It is OK.", "it is ok.");
    expect(s.done).toBe(true);
    expect(s.errors).toBe(0);
  });

  it("caps each gap at 5 seconds so thinking time is not typing time", () => {
    let s = createTyper("ab");
    s = typeKey(s, "a", 0).state;
    s = typeKey(s, "b", 60_000).state;
    expect(s.activeMs).toBe(5000);
    expect(typingFacts(s)).toEqual({ activeMs: 5000, chars: 2, errors: 0 });
  });

  it("straightens typographic quotes in the text to type", () => {
    expect(typingTarget("It’s “fine”.")).toBe("It's \"fine\".");
  });

  it("collects letter-pair facts the server accepts", () => {
    const s = type("the", "txhe");
    const stats = keyStatsOf(s.pairs);
    expect(stats.find((p) => p.pair === "th")).toMatchObject({ count: 1, errors: 1 });
    expect(stats.find((p) => p.pair === "he")).toMatchObject({ count: 1 });
    expect(stats.every((p) => /^[a-z-]{2}$/.test(p.pair))).toBe(true);
  });
});

describe("missed letters (Key Builder look)", () => {
  it("remembers the position of a wrong key once, and keeps it after the right key", () => {
    let s = createTyper("cat");
    s = typeKey(s, "x", 0).state;
    s = typeKey(s, "y", 10).state;
    s = typeKey(s, "c", 20).state;
    s = typeKey(s, "a", 30).state;
    expect(s.missed).toEqual([0]);
    expect(s.pos).toBe(2);
  });
});
