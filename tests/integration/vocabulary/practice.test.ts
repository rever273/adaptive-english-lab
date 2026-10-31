import { afterAll, afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REVIEW_CHECKLIST_KEYS } from "../../../packages/contracts/src/index.js";
import * as repo from "../../../apps/server/src/domain/content/repository.js";
import { recordAttempt } from "../../../apps/server/src/domain/attempts/attempts.js";
import { recordSessionEvent } from "../../../apps/server/src/domain/attempts/sessionEvents.js";
import { takeLease } from "../../../apps/server/src/domain/sessions/lease.js";
import { revealSlot } from "../../../apps/server/src/domain/sessions/reveal.js";
import { finishSession } from "../../../apps/server/src/domain/sessions/finish.js";
import { getFeedback } from "../../../apps/server/src/domain/sessions/feedback.js";
import { createPracticeSession } from "../../../apps/server/src/domain/sessions/create.js";
import { currentSessionId } from "../../../apps/server/src/domain/sessions/snapshot.js";
import { activityProgress } from "../../../apps/server/src/domain/sessions/xp.js";
import { addWord, listWords, patchWord, removeWord } from "../../../apps/server/src/domain/vocabulary/repository.js";
import { createVocabularySession, exportVocabulary, vocabularyCoverage, vocabularyPracticeStatus } from "../../../apps/server/src/domain/vocabulary/practice.js";
import { loadBlockedFingerprints } from "../../../apps/server/src/domain/sessions/bank.js";
import { getSnapshot } from "../../../apps/server/src/domain/sessions/snapshot.js";
import { vocabularyAnalytics } from "../../../apps/server/src/domain/vocabulary/analytics.js";
import { ApiError } from "../../../apps/server/src/errors.js";
import { projectRoot } from "../helpers.js";
import { advanceClock, disposeSliceTemplate, openSliceCopy, type SliceEnv } from "../reservations/slice-fixture.js";

let env: SliceEnv | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});
afterAll(() => disposeSliceTemplate());

const REVIEWER = "agent:test-reviewer@vocab-test-v1";
type Item = { id: string; type: string; payload: { options?: Array<{ id: string; text: string }>; accepted_option_ids?: string[]; accepted_answers?: string[] }; vocabulary: { family: string; target: { lemma: string } } };

/** the starter pack, published through the same repository calls `npm run pack -- publish` uses (individual review, then release) */
async function publishStarter(e: SliceEnv): Promise<Item[]> {
  const { pack } = (await import(pathToFileURL(path.join(projectRoot, "content", "packs", "vocab-starter", "index.mjs")).href)) as { pack: { items: Item[] } };
  const actor = { type: "agent" as const, id: "test-author@v1" };
  const reviewer = { type: "agent" as const, id: "test-reviewer@vocab-test-v1" };
  const ids: string[] = [];
  for (const content of pack.items) {
    // the pack's corrected revision is the FIRST one in this fresh database (same rule as scripts/content-pack.mjs)
    const r = repo.registerRevision(e.db, e.deps, { content: { ...content, revision: 1 }, actor, reason: "test" });
    repo.submitForReview(e.db, e.deps, r.revisionId, reviewer);
    const checklist = Object.fromEntries(REVIEW_CHECKLIST_KEYS.map((k) => [k, true])) as Record<string, boolean | "n/a">;
    checklist.no_mistake_case_correct = "n/a";
    if (content.type === "guided_short_answer") checklist.distractors_valid = "n/a";
    repo.submitReview(e.db, e.deps, { revisionId: r.revisionId, reviewer: REVIEWER, reviewVersion: "pack-review-v1", contentHash: r.contentHash, checklist, verdict: "approved" } as never);
    repo.approveRevision(e.db, e.deps, { revisionId: r.revisionId, actor: reviewer, reason: "test" });
    ids.push(r.revisionId);
  }
  repo.publishRelease(e.db, e.deps, { revisionIds: ids, reviewer: REVIEWER });
  return pack.items;
}

const count = (e: SliceEnv, sql: string, ...a: unknown[]) => (e.db.prepare(sql).get(...a) as { n: number }).n;

/** answer every slot of a session: first try right or wrong by `wrong(i)`, then continue (or skip when `skip(i)`) */
function play(e: SliceEnv, sessionId: string, items: Item[], o: { wrong?: (i: number) => boolean; skip?: (i: number) => boolean; idk?: (i: number) => boolean } = {}) {
  takeLease(e.db, e.deps, sessionId, "tab-1");
  const slots = e.db.prepare("SELECT ss.id, er.exercise_id AS exerciseId FROM session_slots ss JOIN exercise_revisions er ON er.id = ss.exercise_revision_id WHERE ss.session_id = ? ORDER BY ordinal").all(sessionId) as Array<{ id: string; exerciseId: string }>;
  slots.forEach((s, i) => {
    revealSlot(e.db, e.deps, sessionId, s.id, "tab-1");
    if (o.skip?.(i)) {
      recordSessionEvent(e.db, e.deps, sessionId, { slotId: s.id, type: "skip", clientEventId: randomUUID() });
      return;
    }
    const it = items.find((x) => x.id === s.exerciseId)!;
    const right = it.type === "guided_short_answer" ? it.payload.accepted_answers![0]! : it.payload.accepted_option_ids!;
    const wrongAns = it.type === "guided_short_answer" ? "zzzz" : [it.payload.options!.find((x) => !it.payload.accepted_option_ids!.includes(x.id))!.id];
    if (o.idk?.(i)) recordAttempt(e.db, e.deps, { slotId: s.id, submissionId: randomUUID(), idk: true, inputMode: "text" });
    else recordAttempt(e.db, e.deps, { slotId: s.id, submissionId: randomUUID(), answer: o.wrong?.(i) ? wrongAns : right, inputMode: "text" });
    const ev = { slotId: s.id, type: "continue" as const, clientEventId: randomUUID() };
    recordSessionEvent(e.db, e.deps, sessionId, ev);
    recordSessionEvent(e.db, e.deps, sessionId, ev); // a replayed request (reload, second tab) adds nothing
    advanceClock(e, 1000); // attempts of one session get distinct, ordered times
  });
  return slots;
}

describe("Vocabulary Practice (vocabulary TZ)", () => {
  it("offers approved exercises only for words in the dictionary, fresh sentences first (shown ones return only as labelled repeats); never an empty session", async () => {
    env = openSliceCopy();
    const items = await publishStarter(env);
    expect(vocabularyPracticeStatus(env.db)).toMatchObject({ available: 0, words: 0, taskCount: 8 });
    expect(() => createVocabularySession(env!.db, env!.deps, { timezone: "Australia/Brisbane" })).toThrow(ApiError);
    for (const w of ["home", "dog"]) addWord(env.db, env.deps, { word: w });
    const st = vocabularyPracticeStatus(env.db);
    expect(st.available).toBe(items.filter((i) => ["home", "dog"].includes(i.vocabulary.target.lemma)).length);
    expect(st.wordsWithContexts).toBe(2);
    expect(st.shortage).not.toBeNull(); // 6 < 8
    expect(() => createVocabularySession(env!.db, env!.deps, { timezone: "Australia/Brisbane" })).toThrow(/Not enough/);
    // a shorter session on request; words are taken in turn so one word does not fill it
    const s = createVocabularySession(env.db, env.deps, { timezone: "Australia/Brisbane", count: 4 });
    expect(s.snapshot.category).toBe("vocabulary");
    const lemmas = (env.db.prepare("SELECT json_extract(er.content_json, '$.vocabulary.target.lemma') AS l FROM session_slots ss JOIN exercise_revisions er ON er.id = ss.exercise_revision_id WHERE ss.session_id = ?").all(s.sessionId) as Array<{ l: string }>).map((r) => r.l);
    expect(lemmas.filter((l) => l === "home")).toHaveLength(2);
    expect(lemmas.filter((l) => l === "dog")).toHaveLength(2);
    // reserved sentences are no longer offered, and a removed word takes its exercises out of new sessions
    expect(vocabularyPracticeStatus(env.db).available).toBe(2);
    expect(vocabularyCoverage(env.db).words.map((w) => w.lemma).sort()).toEqual(["dog", "home"]);
  });

  it("a full session: separate category, no grammar evidence, Vocabulary XP once per task, first try kept, analytics with honest denominators", async () => {
    env = openSliceCopy();
    const items = await publishStarter(env);
    for (const w of ["home", "endeavour", "dog", "great"]) addWord(env.db, env.deps, { word: w });
    const grammarOpps = count(env, "SELECT COUNT(*) AS n FROM skill_opportunities");
    const s = createVocabularySession(env.db, env.deps, { timezone: "Australia/Brisbane" });
    expect(s.snapshot.slots).toHaveLength(8);
    // the grammar side does not see it as its session, and cannot start another one meanwhile
    expect(currentSessionId(env.db, "grammar")).toBeNull();
    expect(currentSessionId(env.db, "vocabulary")).toBe(s.sessionId);
    expect(() => createPracticeSession(env!.db, env!.deps, { purpose: "practice", blueprintRevisionId: env!.blueprintRevisionId, timezone: "Australia/Brisbane" })).toThrow(/already in progress/);

    const slots = play(env, s.sessionId, items, { wrong: (i) => i === 0, idk: (i) => i === 1, skip: (i) => i === 7 });
    const fb = getFeedback(env.db, env.deps, s.sessionId, slots[0]!.id);
    expect(fb.vocabulary?.lemma).toBeTruthy();
    // the feedback carries the word in Russian (the reviewed one until the learner has their own), the finished sentence and its translation
    expect(fb.vocabulary).toMatchObject({ translationSource: "exercise", sentence: { filled: expect.any(String) }, sentenceRu: expect.any(String), wordRu: expect.any(String) });
    expect(fb.vocabulary!.translationRu).toBe(fb.vocabulary!.wordRu);
    expect(fb.vocabulary!.sentenceRu!.toLowerCase()).toContain(fb.vocabulary!.wordRu!.toLowerCase());
    const ownEntry = env.db.prepare("SELECT id, user_revision AS r FROM vocabulary_entries WHERE lemma = ?").get(fb.vocabulary!.lemma) as { id: string; r: number };
    patchWord(env.db, env.deps, ownEntry.id, { expectedRevision: ownEntry.r, translationRu: "моё слово" });
    expect(getFeedback(env.db, env.deps, s.sessionId, slots[0]!.id).vocabulary).toMatchObject({ translationRu: "моё слово", translationSource: "user" });

    expect(count(env, "SELECT COUNT(*) AS n FROM skill_opportunities")).toBe(grammarOpps); // Grammar Mastery untouched
    expect(activityProgress(env.db, "vocabulary").total).toBe(70); // 7 finished tasks x 10, the skip earns nothing, replays add nothing
    expect(activityProgress(env.db, "grammar").total).toBe(0);

    const summary = finishSession(env.db, env.deps, s.sessionId, "completed");
    expect(summary).toMatchObject({ category: "vocabulary", xpEarned: 70, counts: { correct: 5, incorrect: 1, idk: 1, skipped: 1 } });
    expect(summary.practiseAgain?.length).toBeGreaterThan(0);

    const a = vocabularyAnalytics(env.db, { days: null, now: env.deps.now(), timezone: "Australia/Brisbane" });
    expect(a.overall).toMatchObject({ correct: 5, total: 7, skipped: 1 }); // IDK is a miss; the skip is not in the denominator
    const fam = a.families;
    expect(fam.recognition.total + fam.guided_recall.total + fam.collocation.total).toBe(7);
    expect(a.xp.total).toBe(70);
    // a plain count of answered tasks per word (first tries)
    expect(listWords(env.db).words.reduce((n, w) => n + w.practised, 0)).toBe(7);
    expect(a.weak.every((w) => w.misses >= 2)).toBe(true); // a word is listed only after two missed first tries
    expect(a.weakMinMisses).toBe(2);
    expect(a.encounters.uniqueWordsShown).toBeGreaterThan(0);

    // TASK_020 (D64) updates the old rule "shown sentences never come back" for vocabulary: NEW sentences are still only what was never
    // shown or reserved (all 8 were shown, the skipped one too); shown ones may return only as labelled repeats, counted separately
    const after = vocabularyPracticeStatus(env.db, env.deps.now());
    expect(after.freshAvailable).toBe(items.length - 8);
    expect(after.available).toBeLessThanOrEqual(after.taskCount);
  });

  it("a word is listed as needing another look only after two missed first tries (a miss and an I-don't-know both count)", async () => {
    const run = async (o: { wrong?: (i: number) => boolean; idk?: (i: number) => boolean }) => {
      env?.cleanup();
      env = openSliceCopy();
      const items = await publishStarter(env);
      addWord(env.db, env.deps, { word: "dog" });
      const s = createVocabularySession(env.db, env.deps, { timezone: "Australia/Brisbane", count: 3 });
      play(env, s.sessionId, items, o);
      return vocabularyAnalytics(env.db, { days: null, now: env.deps.now(), timezone: "Australia/Brisbane" }).weak;
    };
    expect(await run({ wrong: (i) => i === 0 })).toEqual([]); // one miss is not yet a pattern
    expect(await run({ wrong: (i) => i === 0, idk: (i) => i === 1 })).toMatchObject([{ lemma: "dog", misses: 2 }]);
  });

  it("guided recall accepts only the reviewed words, case-insensitively, and never a wrong inflection; Learned switches are dated, no XP", async () => {
    env = openSliceCopy();
    const items = await publishStarter(env);
    const w = addWord(env.db, env.deps, { word: "great" }).entry;
    const s = createVocabularySession(env.db, env.deps, { timezone: "Australia/Brisbane", count: 3 });
    takeLease(env.db, env.deps, s.sessionId, "tab-1");
    const slots = env.db.prepare("SELECT ss.id, er.exercise_id AS exerciseId, er.type FROM session_slots ss JOIN exercise_revisions er ON er.id = ss.exercise_revision_id WHERE ss.session_id = ?").all(s.sessionId) as Array<{ id: string; exerciseId: string; type: string }>;
    const recall = slots.find((x) => x.type === "guided_short_answer")!;
    revealSlot(env.db, env.deps, s.sessionId, recall.id, "tab-1");
    expect(recordAttempt(env.db, env.deps, { slotId: recall.id, submissionId: randomUUID(), answer: "Greater", inputMode: "text" }).body.assessment).toMatchObject({ verdict: "incorrect", confirmation: "confirmed" });
    // a later right answer is a new attempt; the first miss stays the first miss
    expect(recordAttempt(env.db, env.deps, { slotId: recall.id, submissionId: randomUUID(), answer: " GREAT ", inputMode: "text" }).body.assessment).toMatchObject({ verdict: "correct" });
    expect((env.db.prepare("SELECT a.verdict AS v FROM attempts t JOIN assessment_revisions a ON a.attempt_id = t.id WHERE t.slot_id = ? AND t.attempt_no = 1").get(recall.id) as { v: string }).v).toBe("incorrect");
    expect(count(env, "SELECT COUNT(*) AS n FROM jobs WHERE kind = 'free_text_analysis'")).toBe(0); // no model on the scoring path
    patchWord(env.db, env.deps, w.id, { learned: true });
    patchWord(env.db, env.deps, w.id, { learned: true }); // no change, no event
    expect(count(env, "SELECT COUNT(*) AS n FROM vocabulary_learned_events")).toBe(1);
    expect(count(env, "SELECT COUNT(*) AS n FROM activity_xp_events")).toBe(0);
    removeWord(env.db, env.deps, w.id);
    expect(items.length).toBe(13);
  });

  it("adaptive selection (D64): a missed word comes back as a labelled repeat that reserves and exposes only its never-exposed units", async () => {
    env = openSliceCopy();
    const items = await publishStarter(env);
    for (const w of ["home", "dog"]) addWord(env.db, env.deps, { word: w });
    const s1 = createVocabularySession(env.db, env.deps, { timezone: "Australia/Brisbane", count: 4, seed: "one" });
    expect(s1.snapshot.slots.every((x) => x.repeat === undefined)).toBe(true); // nothing to repeat yet
    const slots1 = play(env, s1.sessionId, items, { wrong: (i) => i >= 2 }); // the last try of each word is a miss
    finishSession(env.db, env.deps, s1.sessionId, "completed");
    const revOf = (slotId: string) => (env!.db.prepare("SELECT exercise_revision_id AS r FROM session_slots WHERE id = ?").get(slotId) as { r: string }).r;
    const missedSlots = [slots1[2]!.id, slots1[3]!.id];
    const missedRevs = missedSlots.map(revOf);
    const missedUnits = (env.db.prepare("SELECT unit_id AS u FROM revision_prompt_units WHERE revision_id = ?").all(missedRevs[0]!) as Array<{ u: string }>).map((x) => x.u);

    const st = vocabularyPracticeStatus(env.db, env.deps.now());
    expect(st.repeatsAvailable).toBeGreaterThan(0); // the repeat is counted
    expect(st.available).toBeLessThanOrEqual(st.taskCount);
    expect(st.freshAvailable).toBe(2);

    advanceClock(env, 86_400_000 * 2);
    const reservationsBefore = count(env, "SELECT COUNT(*) AS n FROM prompt_reservations");
    const exposuresBefore = count(env, "SELECT COUNT(*) AS n FROM exposures");
    const s2 = createVocabularySession(env.db, env.deps, { timezone: "Australia/Brisbane", count: 3, seed: "two" });
    const repeatSlots = env.db.prepare("SELECT id, exercise_revision_id AS r, cohort_json AS c FROM session_slots WHERE session_id = ? AND json_extract(cohort_json, '$.repeat') = 1").all(s2.sessionId) as Array<{ id: string; r: string; c: string }>;
    const first = env.db.prepare("SELECT exercise_revision_id AS r FROM session_slots WHERE session_id = ? AND ordinal = 0").get(s2.sessionId) as { r: string };
    expect(missedRevs).toContain(first.r); // a missed sentence is the first choice
    expect(repeatSlots).toHaveLength(1); // repeats fill at most 60% of a 3-task session
    const rep = repeatSlots[0]!;
    const answerUnitsBefore = (env.db.prepare("SELECT DISTINCT unit_id AS u FROM revision_prompt_units WHERE revision_id = ? AND unit_id NOT IN (SELECT unit_id FROM exposures)").all(rep.r) as Array<{ u: string }>).map((x) => x.u);
    expect(rep.r).toBe(first.r);
    expect(JSON.parse(rep.c)).toMatchObject({ repeat: true, reason: "missed", repeatOfSlotId: missedSlots[missedRevs.indexOf(first.r)] });
    expect(s2.snapshot.slots.find((x) => x.slotId === rep.id)?.repeat).toEqual({ reason: "missed" });
    // a repeat reserves exactly the units of its revision that were never exposed (the answer sentence); shown ones are not touched
    const reservedFor = (env.db.prepare("SELECT unit_id AS u FROM prompt_reservations WHERE slot_id = ?").all(rep.id) as Array<{ u: string }>).map((x) => x.u).sort();
    expect(answerUnitsBefore.length).toBeGreaterThan(0);
    expect(reservedFor).toEqual([...answerUnitsBefore].sort());
    expect(count(env, "SELECT COUNT(*) AS n FROM prompt_reservations")).toBeGreaterThan(reservationsBefore);

    const played = play(env, s2.sessionId, items, {});
    expect(played).toHaveLength(3);
    for (const sl of played) expect(getFeedback(env.db, env.deps, s2.sessionId, sl.id).state).toBe("confirmed");
    // after feedback the repeat's answer units are in the ledger, written by the repeat slot
    const exposedByRepeat = (env.db.prepare("SELECT unit_id AS u FROM exposures WHERE slot_id = ?").all(rep.id) as Array<{ u: string }>).map((x) => x.u).sort();
    expect(exposedByRepeat).toEqual(reservedFor);
    expect(count(env, "SELECT COUNT(*) AS n FROM exposures")).toBeGreaterThan(exposuresBefore);
    finishSession(env.db, env.deps, s2.sessionId, "completed");
    expect(getSnapshot(env.db, s2.sessionId).slots.some((x) => x.repeat)).toBe(true);
    // the shown sentence stays blocked for everything else (grammar, diagnostic and held-out use this ledger)
    const blocked = loadBlockedFingerprints(env.db);
    const fps = (env.db.prepare(`SELECT fingerprint AS f FROM prompt_units WHERE id IN (${missedUnits.map(() => "?").join(",")})`).all(...missedUnits) as Array<{ f: string }>).map((x) => x.f);
    expect(fps.every((f) => blocked.has(f))).toBe(true);

    // the scheduling decision carries the v2 transparency fields; the algorithm row is v2
    const dec = env.db.prepare("SELECT algorithm_id AS a, choices_json AS c FROM scheduling_decisions WHERE session_id = ?").get(s2.sessionId) as { a: string; c: string };
    expect(dec.a).toBe("vocabulary-selection-v2");
    const choice = (JSON.parse(dec.c) as { slots: Array<Record<string, unknown>> }).slots.find((x) => x.slotId === rep.id)!;
    expect(choice).toMatchObject({ repeat: true, reason: "missed", state: "learning", streak: 0 });
    for (const k of ["lemma", "family", "priority", "dueAt"]) expect(choice).toHaveProperty(k);
    expect(count(env, "SELECT COUNT(*) AS n FROM algorithm_versions WHERE id = 'vocabulary-selection-v2'")).toBe(1);

    // analytics v2: the repeat is summarised apart and stays out of the fresh-sentence rates
    const a = vocabularyAnalytics(env.db, { days: null, now: env.deps.now(), timezone: "Australia/Brisbane" });
    expect(a.version).toBe("vocabulary-analytics-v2");
    const nRepeat = count(env, "SELECT COUNT(*) AS n FROM attempts t JOIN session_slots ss ON ss.id = t.slot_id WHERE t.attempt_no = 1 AND json_extract(ss.cohort_json, '$.repeat') = 1");
    expect(nRepeat).toBeGreaterThan(0);
    expect(a.repeats).toMatchObject({ count: nRepeat, correct: nRepeat, miss: 0, assisted: 0 });
    const allFirst = count(env, "SELECT COUNT(*) AS n FROM attempts WHERE attempt_no = 1");
    expect(a.overall.total).toBe(allFirst - nRepeat);
    expect(a.overall.correct).toBe(allFirst - nRepeat - 2); // only the two first-session misses are misses

    // Content Studio / agent export lists the scheduling facts and the hint
    const ex = exportVocabulary(env.db, env.deps.now());
    expect((ex.json as { words: Array<Record<string, unknown>> }).words[0]).toHaveProperty("freshLeft");
    expect(ex.markdown).toContain("Write new exercises first for words with misses and no fresh sentences");
  });

  it("repeat-only stock still forms a session (all slots are labelled repeats, reservations only for unexposed units); mixed stock starts at count = available", async () => {
    env = openSliceCopy();
    const items = await publishStarter(env);
    addWord(env.db, env.deps, { word: "dog" });
    const s = createVocabularySession(env.db, env.deps, { timezone: "Australia/Brisbane", count: 3 });
    play(env, s.sessionId, items, { wrong: () => true });
    finishSession(env.db, env.deps, s.sessionId, "completed");
    const only = vocabularyPracticeStatus(env.db, env.deps.now());
    expect(only.freshAvailable).toBe(0);
    expect(only.available).toBe(3); // all three missed sentences can come back, the soft cap lets repeats fill the session
    for (const seed of ["a", "b"]) {
      const r = createVocabularySession(env.db, env.deps, { timezone: "Australia/Brisbane", count: only.available, seed });
      expect(r.snapshot.slots).toHaveLength(only.available);
      expect(r.snapshot.slots.every((x) => x.repeat !== undefined)).toBe(true);
      const bad = count(env, `SELECT COUNT(*) AS n FROM prompt_reservations pr JOIN session_slots ss ON ss.id = pr.slot_id JOIN revision_prompt_units rpu ON rpu.unit_id = pr.unit_id AND rpu.revision_id = ss.exercise_revision_id WHERE ss.session_id = ? AND pr.unit_id IN (SELECT unit_id FROM exposures)`, r.sessionId);
      expect(bad).toBe(0); // only never-exposed units are reserved
      finishSession(env.db, env.deps, r.sessionId, "ended_early");
    }
    // skipping a revealed repeat releases its answer-unit reservations and exposes nothing new; its prompt units stay exposed
    const sk = createVocabularySession(env.db, env.deps, { timezone: "Australia/Brisbane", count: 3, seed: "skip" });
    takeLease(env.db, env.deps, sk.sessionId, "tab-1");
    const first = sk.snapshot.slots[0]!;
    revealSlot(env.db, env.deps, sk.sessionId, first.slotId, "tab-1");
    recordSessionEvent(env.db, env.deps, sk.sessionId, { slotId: first.slotId, type: "skip", clientEventId: randomUUID() });
    const rev = (env.db.prepare("SELECT exercise_revision_id AS r FROM session_slots WHERE id = ?").get(first.slotId) as { r: string }).r;
    expect(count(env, "SELECT COUNT(*) AS n FROM prompt_reservations WHERE slot_id = ?", first.slotId)).toBeGreaterThan(0);
    finishSession(env.db, env.deps, sk.sessionId, "ended_early");
    expect(count(env, "SELECT COUNT(*) AS n FROM prompt_reservations WHERE slot_id = ?", first.slotId)).toBe(0);
    expect(count(env, "SELECT COUNT(*) AS n FROM exposures WHERE slot_id = ?", first.slotId)).toBe(0);
    expect(count(env, "SELECT COUNT(*) AS n FROM revision_prompt_units WHERE revision_id = ? AND role <> 'answer' AND unit_id NOT IN (SELECT unit_id FROM exposures)", rev)).toBe(0);
    expect(count(env, "SELECT COUNT(*) AS n FROM revision_prompt_units WHERE revision_id = ? AND role = 'answer' AND unit_id NOT IN (SELECT unit_id FROM exposures)", rev)).toBeGreaterThan(0);

    // a second word with fresh sentences: the status size is startable, whatever the seed
    addWord(env.db, env.deps, { word: "home" });
    const mixed = vocabularyPracticeStatus(env.db, env.deps.now());
    expect(mixed.available).toBeGreaterThan(0);
    expect(mixed.shortage?.message ?? "").toContain(`Only ${mixed.available}`);
    for (const seed of ["a", "b", "c"]) {
      const ok = createVocabularySession(env.db, env.deps, { timezone: "Australia/Brisbane", count: mixed.available, seed });
      expect(ok.snapshot.slots).toHaveLength(mixed.available);
      finishSession(env.db, env.deps, ok.sessionId, "ended_early"); // unshown reservations go back; nothing was revealed
    }
  });
});
