import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { upsertModelVersion } from "../../../apps/server/src/domain/attempts/transcripts.js";
import { loadSettings } from "../../../apps/server/src/domain/sessions/policy.js";
import { insertSentence } from "../../../apps/server/src/domain/contextLoop/sentences.js";
import { answerCard, answerCheck, checkFirstLetter, completeSession, gradeCheck, sessionState, startSession } from "../../../apps/server/src/domain/contextLoop/sessions.js";
import { checkDraft, targetOf } from "../../../apps/server/src/domain/contextLoop/validate.js";
import { senseOf } from "../../../apps/server/src/domain/wordLessons/generate.js";
import { eligibleWords } from "../../../apps/server/src/domain/wordLessons/selection.js";
import { deps, saveWord, setup, type Env } from "../wordLessons/fixtures.js";

let env: Env | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

const SENTENCES = ["Please do not overlook the small print.", "It is easy to overlook quiet colleagues.", "Never overlook a polite email from a client."];
const DAY = 86_400_000;

function seed(db: Env["db"]): string {
  const id = saveWord(db, "overlook", "упустить из виду");
  const w = eligibleWords(db).eligible.find((x) => x.entryId === id)!;
  const t = targetOf(id, w.lemma, senseOf(db, w));
  for (const text of SENTENCES) {
    const r = checkDraft({ text, target_surface: "overlook", context_label: "life", difficulty: "easy" }, t);
    if (!r.ok) throw new Error(r.message);
    db.transaction(() => insertSentence(db, deps, { target: t, checked: r.sentence, source: "model", status: "validated", actor: "model" }))();
  }
  return id;
}

function setChecks(db: Env["db"], n: number) {
  const cur = loadSettings(db);
  db.prepare("INSERT INTO settings_revisions(id, revision, values_json, created_at) VALUES (?,?,?,?)").run(randomUUID(), cur.revision + 1, JSON.stringify({ ...cur.values, contextLoopChecks: n }), new Date().toISOString());
}

/** a finished session two days ago in which the word was recalled */
function pastSession(db: Env["db"]) {
  const past = { now: () => new Date(Date.now() - 2 * DAY), newId: randomUUID };
  const s = startSession(db, past, "tab");
  const c = sessionState(db, s.sessionId).card!;
  answerCard(db, past, s.sessionId, { id: randomUUID(), tabId: "tab", cardIndex: c.cardIndex, outcome: "recalled", aids: {} });
  completeSession(db, past, s.sessionId);
}

const xp = (db: Env["db"]) => (db.prepare("SELECT COALESCE(SUM(amount),0) AS n FROM mode_xp_events WHERE source = 'contextLoop'").get() as { n: number }).n;

/** today's session up to its check card */
function toCheck(db: Env["db"]) {
  const s = startSession(db, deps, "tab");
  const first = sessionState(db, s.sessionId).card!;
  expect(first.kind).toBe("card");
  answerCard(db, deps, s.sessionId, { id: randomUUID(), tabId: "tab", cardIndex: first.cardIndex, outcome: "recalled", aids: {} });
  return { sessionId: s.sessionId, state: sessionState(db, s.sessionId, true) };
}

describe("Context Loop rare check (D159)", () => {
  it("grades by code: the exact form, another form, a synonym and anything else", () => {
    const sense = { translationRu: "", definitionRu: "", pos: "verb", synonyms: ["miss", "ignore"], surfaceForms: [], irregularForms: [] };
    expect(gradeCheck(" Overlook. ", "overlook", "overlook", sense)).toEqual({ outcome: "correct", formMatch: "exact" });
    expect(gradeCheck("overlooked", "overlook", "overlook", sense)).toEqual({ outcome: "correct", formMatch: "other_form" });
    expect(gradeCheck("ignore", "overlook", "overlook", sense)).toEqual({ outcome: "synonym", formMatch: null });
    expect(gradeCheck("notice", "overlook", "overlook", sense)).toEqual({ outcome: "incorrect", formMatch: null });
  });

  it("asks a word recalled on an earlier day once, without sending the word; a card answer is refused; a right typed answer pays 5 XP", async () => {
    env = await setup();
    const { db } = env;
    seed(db);
    pastSession(db);
    const xp0 = xp(db);
    const { sessionId, state } = toCheck(db);
    expect(state.card).toMatchObject({ kind: "check", voice: true, cue: { translationRu: "упустить из виду" } });
    const json = JSON.stringify(state.card);
    expect(json).not.toMatch(/overlook/i);
    expect(json).toContain("___");
    const ci = state.card!.cardIndex;
    expect(() => answerCard(db, deps, sessionId, { id: randomUUID(), tabId: "tab", cardIndex: ci, outcome: "recalled", aids: {} })).toThrow(/type or say/);
    expect(() => answerCheck(db, deps, sessionId, { id: randomUUID(), tabId: "tab", cardIndex: ci, text: "  ", firstLetter: false })).toThrow(/Type or say/);
    const id = randomUUID();
    answerCheck(db, deps, sessionId, { id, tabId: "tab", cardIndex: ci, text: "Overlook", firstLetter: false });
    answerCheck(db, deps, sessionId, { id, tabId: "tab", cardIndex: ci, text: "Overlook", firstLetter: false }); // the same answer again changes nothing
    expect(() => answerCheck(db, deps, sessionId, { id, tabId: "tab", cardIndex: ci, text: "other", firstLetter: false })).toThrow(/already used/);
    const after = sessionState(db, sessionId);
    expect(after.lastCheck).toMatchObject({ outcome: "correct", formMatch: "exact", expected: "overlook", lemma: "overlook" });
    expect(after.summary.checks).toEqual({ correct: 1, total: 1 });
    expect(xp(db) - xp0).toBe(2 + 5); // the first card and the check
    expect(after.card === null || after.card.kind === "card").toBe(true); // one check per word
  });

  it("the first-letter hint is recorded and earns less; I don't know is skipped with no XP; a spoken answer keeps only text", async () => {
    env = await setup();
    const { db } = env;
    seed(db);
    pastSession(db);
    let { sessionId, state } = toCheck(db);
    const ci = state.card!.cardIndex;
    expect(checkFirstLetter(db, deps, sessionId, "tab", ci)).toEqual({ letter: "o" });
    const x = xp(db);
    // the page forgot the hint (a reload): the server still counts the answer as helped
    answerCheck(db, deps, sessionId, { id: randomUUID(), tabId: "tab", cardIndex: ci, text: "overlooks", firstLetter: false, voice: { asrText: "over looks", sttModelId: upsertModelVersion(db, randomUUID, { tag: "whisper-large-v3", runtime: "groq", runtimeVersion: "api", digest: "provider-managed", parameters: { language: "en" } }) } });
    const row = db.prepare("SELECT input, asr_text AS asr, asr_edited AS edited, first_letter_hint AS hint, outcome, form_match AS fm FROM context_loop_attempts WHERE kind = 'check'").get();
    expect(row).toEqual({ input: "voice", asr: "over looks", edited: 1, hint: 1, outcome: "correct", fm: "other_form" });
    expect(xp(db) - x).toBe(2);
    completeSession(db, deps, sessionId);

    // a new day later the same word is checked again; "I don't know"
    const later = { now: () => new Date(Date.now() + 2 * DAY), newId: randomUUID };
    const s2 = startSession(db, later, "tab");
    const c1 = sessionState(db, s2.sessionId).card!;
    answerCard(db, later, s2.sessionId, { id: randomUUID(), tabId: "tab", cardIndex: c1.cardIndex, outcome: "recalled", aids: {} });
    state = sessionState(db, s2.sessionId);
    sessionId = s2.sessionId;
    expect(state.card!.kind).toBe("check");
    const x2 = xp(db);
    answerCheck(db, later, sessionId, { id: randomUUID(), tabId: "tab", cardIndex: state.card!.cardIndex, text: null, firstLetter: false });
    expect(sessionState(db, sessionId).lastCheck).toMatchObject({ outcome: "skipped", answer: null });
    expect(xp(db)).toBe(x2);
  });

  it("no check without an earlier day, and none when the setting is 0", async () => {
    env = await setup();
    const { db } = env;
    seed(db);
    const s = startSession(db, deps, "tab");
    for (let i = 0; i < 10; i++) {
      const c = sessionState(db, s.sessionId).card;
      if (!c) break;
      expect(c.kind).toBe("card");
      answerCard(db, deps, s.sessionId, { id: randomUUID(), tabId: "tab", cardIndex: c.cardIndex, outcome: "recalled", aids: {} });
    }
    completeSession(db, deps, s.sessionId);
    setChecks(db, 0);
    const later = { now: () => new Date(Date.now() + 2 * DAY), newId: randomUUID };
    const s2 = startSession(db, later, "tab");
    for (let i = 0; i < 10; i++) {
      const c = sessionState(db, s2.sessionId).card;
      if (!c) break;
      expect(c.kind).toBe("card");
      answerCard(db, later, s2.sessionId, { id: randomUUID(), tabId: "tab", cardIndex: c.cardIndex, outcome: "recalled", aids: {} });
    }
  });
});
