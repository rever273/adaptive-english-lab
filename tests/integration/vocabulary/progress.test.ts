import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { insertSentence } from "../../../apps/server/src/domain/contextLoop/sentences.js";
import { answerCard, sessionState, startSession } from "../../../apps/server/src/domain/contextLoop/sessions.js";
import { checkDraft, targetOf } from "../../../apps/server/src/domain/contextLoop/validate.js";
import { vocabularyProgress } from "../../../apps/server/src/domain/vocabulary/progress.js";
import { senseOf } from "../../../apps/server/src/domain/wordLessons/generate.js";
import { eligibleWords } from "../../../apps/server/src/domain/wordLessons/selection.js";
import { deps, saveWord, setup, type Env } from "../wordLessons/fixtures.js";

let env: Env | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

const SENTENCES: Record<string, string[]> = {
  overlook: ["Please do not overlook the small print.", "It is easy to overlook quiet colleagues.", "Never overlook a polite email."],
  scarce: ["Water is scarce in the desert in summer.", "Good builders are scarce this year.", "Fresh bread was scarce after the storm."],
};

function seed(db: Env["db"], word: string, translation: string): string {
  const id = saveWord(db, word, translation);
  const w = eligibleWords(db).eligible.find((x) => x.entryId === id)!;
  const t = targetOf(id, w.lemma, senseOf(db, w));
  for (const text of SENTENCES[word]!) {
    const r = checkDraft({ text, target_surface: word, context_label: "life", difficulty: "easy" }, t);
    if (!r.ok) throw new Error(r.message);
    db.transaction(() => insertSentence(db, deps, { target: t, checked: r.sentence, source: "model", status: "validated", actor: "model" }))();
  }
  return id;
}

it("vocabulary-progress-v1 and the Context Loop summary count the same answers: per word, per day, by strength, never stored", async () => {
  env = await setup();
  const { db } = env;
  const overlook = seed(db, "overlook", "упустить");
  seed(db, "scarce", "дефицитный");
  saveWord(db, "vivid", "яркий"); // saved, never practised
  const s = startSession(db, deps, "tab");
  // overlook recalled, scarce missed on their first cards
  for (let i = 0; i < 2; i++) {
    const card = sessionState(db, s.sessionId).card!;
    if (card.kind !== "card") throw new Error("expected a card");
    answerCard(db, deps, s.sessionId, { id: randomUUID(), tabId: "tab", cardIndex: i, outcome: card.entryId === overlook ? "recalled" : "not_recalled", aids: {} });
  }
  const sum = sessionState(db, s.sessionId).summary;
  expect(sum.perWord).toEqual([
    { lemma: expect.any(String), success: expect.any(Number), miss: expect.any(Number), done: false },
    { lemma: expect.any(String), success: expect.any(Number), miss: expect.any(Number), done: false },
  ]);
  expect(sum.perWord.find((w) => w.lemma === "overlook")).toMatchObject({ success: 1, miss: 0 });
  expect(sum.perWord.find((w) => w.lemma === "scarce")).toMatchObject({ success: 0, miss: 1 });

  const before = (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master").get() as { n: number }).n;
  const p = vocabularyProgress(db, { days: 7, now: deps.now() });
  expect(p.points).toHaveLength(7);
  const today = p.points.at(-1)!;
  expect(today).toMatchObject({ total: 3, notStarted: 1, learning: 2, strong: 0, right: 1, missed: 1, words: 2 });
  expect(p.practisedWords).toBe(2);
  expect(p.bands.reduce((n, b) => n + b.words, 0)).toBe(2);
  expect(p.groups.active).toHaveLength(2);
  expect(p.groups.weak).toEqual([]); // fewer than three answers per word
  const track = p.tracks.find((t) => t.entryId === overlook)!;
  expect(track.strength.at(-1)).toBeGreaterThan(0);
  expect(track.right.reduce((a, b) => a + b, 0)).toBe(1);
  expect(vocabularyProgress(db, { days: null, now: deps.now() }).points.at(-1)).toMatchObject({ total: 3 });
  expect((db.prepare("SELECT COUNT(*) AS n FROM sqlite_master").get() as { n: number }).n).toBe(before);
});
