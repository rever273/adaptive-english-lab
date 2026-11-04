import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { fingersFor, keyFor, TypingKeyboard } from "../../../apps/web/src/components/TypingKeyboard.js";
import { firstTranslation, fmtTotalTime } from "../../../apps/web/src/format.js";

describe("firstTranslation", () => {
  it("keeps only the first translation", () => {
    expect(firstTranslation("согласовывать, примирять, сводить (счета)")).toBe("согласовывать");
    expect(firstTranslation("кот; кошка")).toBe("кот");
    expect(firstTranslation("ставить (на кон, всерьёз), делать")).toBe("ставить (на кон, всерьёз)");
    expect(firstTranslation("окно")).toBe("окно");
    expect(firstTranslation(null)).toBe("");
  });
});

describe("fmtTotalTime", () => {
  it("switches units at 60 minutes and drops minutes from 100 hours", () => {
    expect(fmtTotalTime(42)).toBe("42 s");
    expect(fmtTotalTime(59 * 60)).toBe("59 min");
    expect(fmtTotalTime(65 * 60)).toBe("1 h 5 min");
    expect(fmtTotalTime(3 * 3600)).toBe("3 h");
    expect(fmtTotalTime(100 * 3600 + 20 * 60)).toBe("100 h");
  });
});

describe("typing keyboard hint", () => {
  it("maps characters to fingers", () => {
    expect(fingersFor("f")).toEqual(["li"]);
    expect(fingersFor("p")).toEqual(["rp"]);
    expect(fingersFor(" ")).toEqual(["th"]);
    expect(fingersFor("A")).toEqual(["lp", "rp"]); // shift is pressed by the opposite hand
    expect(fingersFor("J")).toEqual(["ri", "lp"]);
    expect(fingersFor("?")).toEqual(["rp", "lp"]);
    expect(keyFor("7")).toBeNull();
  });

  it("renders without any text outside the keys", () => {
    const html = renderToStaticMarkup(createElement(TypingKeyboard, { next: "g" }));
    expect(html).toContain('data-next="g"');
    expect(renderToStaticMarkup(createElement(TypingKeyboard, { next: null }))).toContain("<svg");
  });
});
