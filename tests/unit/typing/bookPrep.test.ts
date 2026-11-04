import { describe, expect, it } from "vitest";
import { prepareBookText } from "../../../apps/server/src/domain/typing/bookPrep.js";

const HEADER = [
  "",
  "Project Gutenberg Australia",
  "",
  "Title: Nineteen eighty-four",
  "Author: George Orwell",
  "* A Project Gutenberg of Australia eBook *",
  "eBook No.: 0100021.txt",
  "Language: English",
  "Date first posted: August 2001",
  "",
  "Project Gutenberg of Australia eBooks are created from printed editions",
  "which are in the public domain in Australia, unless a copyright notice",
  "is included. We do NOT keep any eBooks in compliance with a particular",
  "paper edition.",
  "",
  "Copyright laws are changing all over the world. Be sure to check the",
  "copyright laws for your country before downloading or redistributing this",
  "file.",
  "",
].join("\n");

const BODY = [
  "PART ONE",
  "",
  "Chapter 1",
  "",
  "It was a bright cold day in April.",
  "",
  "Chapter 2",
  "",
  "The next morning was bright.",
  "",
  "PART TWO",
  "",
  "Chapter 1",
  "",
  "Some more text here.",
  "",
  "THE END",
  "",
  "APPENDIX.",
  "",
  "The Principles of Newspeak.",
  "",
  "THE END",
  "",
  "Project Gutenberg Australia",
].join("\n");

describe("book text preparation", () => {
  it("drops the service header before the first heading", () => {
    const { text } = prepareBookText(HEADER + "\n" + BODY);
    expect(text.startsWith("It was a bright cold day")).toBe(true);
    expect(text).not.toContain("Project Gutenberg");
    expect(text).not.toContain("public domain");
  });

  it("keeps the appendix that follows the first THE END", () => {
    const { text, chapters } = prepareBookText(HEADER + "\n" + BODY);
    const titles = chapters.map((c) => c.title);
    expect(titles).toContain("APPENDIX.");
    expect(text).toContain("The Principles of Newspeak.");
  });

  it("does not treat Roman-numeral chapter quotes or 'Appendix.' mid-sentence as headings", () => {
    const withQuotes =
      HEADER +
      "\n" +
      BODY.replace("Some more text here.", "Some more text here.\nChapter I\nChapter III, and then more words.\nAppendix.]--was startlingly different.");
    const { chapters } = prepareBookText(withQuotes);
    const titles = chapters.map((c) => c.title);
    expect(titles).not.toContain("Chapter I");
    expect(titles).not.toContain("Chapter III");
    // only the real headings remain
    expect(titles).toEqual(["PART ONE", "Chapter 1", "Chapter 2", "PART TWO", "Chapter 1", "APPENDIX."]);
  });

  it("reports only truly unexpected characters (2+2=5 is content, so + and = are flagged)", () => {
    const { issues } = prepareBookText(HEADER + "\n" + BODY.replace("Some more text here.", "2+2=5"));
    expect(issues.join(" ")).toContain('"+"');
    expect(issues.join(" ")).toContain('"="');
  });
});
