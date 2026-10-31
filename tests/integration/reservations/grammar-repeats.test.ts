import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { CreateSessionResponse } from "../../../packages/contracts/src/index.js";
import { recordAttempt } from "../../../apps/server/src/domain/attempts/attempts.js";
import { recordSessionEvent } from "../../../apps/server/src/domain/attempts/sessionEvents.js";
import { NO_MISTAKE_ID } from "../../../apps/server/src/domain/content/grader.js";
import { lessonPlanView } from "../../../apps/server/src/domain/content/batches/lessonNeeds.js";
import { createBatch } from "../../../apps/server/src/domain/content/batches/repository.js";
import { replenishmentStock } from "../../../apps/server/src/domain/content/batches/stock.js";
import { createPracticeSession } from "../../../apps/server/src/domain/sessions/create.js";
import { getFeedback } from "../../../apps/server/src/domain/sessions/feedback.js";
import { finishSession } from "../../../apps/server/src/domain/sessions/finish.js";
import { takeLease } from "../../../apps/server/src/domain/sessions/lease.js";
import { computeReadiness } from "../../../apps/server/src/domain/sessions/readiness.js";
import { loadCandidates } from "../../../apps/server/src/domain/sessions/bank.js";
import { shownGrammarRevisions, withRepeats } from "../../../apps/server/src/domain/sessions/repeats.js";
import { revealSlot } from "../../../apps/server/src/domain/sessions/reveal.js";
import { getSnapshot } from "../../../apps/server/src/domain/sessions/snapshot.js";
import { advanceClock, buildSliceTemplate, disposeSliceTemplate, openSliceCopy, type SliceEnv } from "./slice-fixture.js";

let env: SliceEnv;
beforeAll(() => {
  buildSliceTemplate();
}, 180_000);
afterAll(() => disposeSliceTemplate());
afterEach(() => env?.cleanup());

const TAB = "tab-1";
const DAY = 86_400_000;
const begin = (e: SliceEnv, seed: string): CreateSessionResponse => createPracticeSession(e.db, e.deps, { purpose: "practice", blueprintRevisionId: e.blueprintRevisionId, seed, timezone: "Australia/Brisbane" });
const one = <T = Record<string, unknown>>(sql: string, ...p: unknown[]) => env.db.prepare(sql).get(...p) as T;
const rows = <T = Record<string, unknown>>(sql: string, ...p: unknown[]) => env.db.prepare(sql).all(...p) as T[];
const count = (sql: string, ...p: unknown[]) => one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${sql}`, ...p).n;

function correctRaw(slotId: string): string | string[] {
  const r = one<{ type: string; content: string; q: string | null }>("SELECT er.type AS type, er.content_json AS content, ss.question_id AS q FROM session_slots ss JOIN exercise_revisions er ON er.id = ss.exercise_revision_id WHERE ss.id = ?", slotId);
  const c = JSON.parse(r.content) as { payload: any };
  if (r.type === "detect_error") return c.payload.no_mistake ? [NO_MISTAKE_ID] : c.payload.accepted_segment_ids;
  if (r.type === "context_reading") return c.payload.questions.find((q: any) => q.id === r.q).accepted_option_ids;
  if (r.type === "choose_form" || r.type === "choose_missing_fragment") return c.payload.accepted_option_ids;
  return c.payload.accepted_answers[0];
}
const lease = (id: string) => takeLease(env.db, env.deps, id, TAB);
const reveal = (sid: string, slotId: string) => revealSlot(env.db, env.deps, sid, slotId, TAB);

/** the learner plays a session: per ordinal "ok" (correct), "idk" (a miss) or "skip" */
function play(sessionId: string, how: (ordinal: number) => "ok" | "idk" | "skip") {
  lease(sessionId);
  for (const s of getSnapshot(env.db, sessionId).slots) {
    reveal(sessionId, s.slotId);
    const h = how(s.ordinal);
    if (h === "skip") recordSessionEvent(env.db, env.deps, sessionId, { slotId: s.slotId, type: "skip", clientEventId: randomUUID() });
    else {
      if (h === "ok") recordAttempt(env.db, env.deps, { slotId: s.slotId, submissionId: randomUUID(), answer: correctRaw(s.slotId), inputMode: "text" });
      else recordAttempt(env.db, env.deps, { slotId: s.slotId, submissionId: randomUUID(), idk: true, inputMode: "text" });
      getFeedback(env.db, env.deps, sessionId, s.slotId);
      recordSessionEvent(env.db, env.deps, sessionId, { slotId: s.slotId, type: "continue", clientEventId: randomUUID() });
    }
  }
  finishSession(env.db, env.deps, sessionId, "completed");
}

/** builds sessions with seeds until one contains a labelled repeat (a due repeat is eligible, not guaranteed, in every seed) */
function beginWithRepeat(e: SliceEnv): CreateSessionResponse {
  for (let i = 0; i < 40; i++) {
    const s = begin(e, `find-${i}`);
    if (s.snapshot.slots.some((x) => x.repeat)) return s;
    finishSession(e.db, e.deps, s.sessionId, "ended_early"); // nothing was shown: its reservations are released
  }
  throw new Error("no seed produced a repeat");
}

describe("a missed grammar exercise comes back once as a labelled repeat (D68)", () => {
  it("is practice only: no new reservation/exposure for shown units, independent = 0 evidence, strict no-repeat for fresh slots", () => {
    env = openSliceCopy();
    const first = begin(env, "one");
    const firstSlots = new Map(first.snapshot.slots.map((s) => [s.slotId, one<{ r: string }>("SELECT exercise_revision_id AS r FROM session_slots WHERE id = ?", s.slotId).r]));
    play(first.sessionId, (o) => (o % 3 === 0 ? "idk" : o % 3 === 1 ? "skip" : "ok"));
    const notCorrect = new Set(first.snapshot.slots.filter((s) => s.ordinal % 3 !== 2).map((s) => firstSlots.get(s.slotId)!));
    expect(notCorrect.size).toBe(12);
    expect(shownGrammarRevisions(env.db).size).toBe(18);

    const independentBefore = count("skill_opportunities WHERE independent = 1");
    const exposedBefore = count("exposures");
    const second = beginWithRepeat(env);
    const repeatSlots = second.snapshot.slots.filter((s) => s.repeat);
    expect(repeatSlots.length).toBeGreaterThan(0);
    expect(repeatSlots.length).toBeLessThanOrEqual(5); // 30% of 18
    // only revisions that were missed / skipped last time return (the correct ones are not due for 14 days)
    const repeatRevisions = repeatSlots.map((s) => one<{ r: string }>("SELECT exercise_revision_id AS r FROM session_slots WHERE id = ?", s.slotId).r);
    expect(repeatRevisions.every((r) => notCorrect.has(r))).toBe(true);
    expect(new Set(repeatRevisions).size).toBe(repeatRevisions.length); // never twice in one session
    expect(repeatSlots.every((s) => s.repeat!.reason === "missed")).toBe(true);

    // ledger: creating the session exposed nothing and reserved no unit that was already shown
    expect(count("exposures")).toBe(exposedBefore);
    for (const s of repeatSlots) {
      const c = JSON.parse(one<{ c: string }>("SELECT cohort_json AS c FROM session_slots WHERE id = ?", s.slotId).c) as { repeat?: boolean; reason?: string; repeatOfSlotId?: string };
      expect(c).toMatchObject({ repeat: true, reason: "missed" });
      expect(firstSlots.has(c.repeatOfSlotId!)).toBe(true);
      expect(count("prompt_reservations pr WHERE pr.slot_id = ? AND pr.unit_id IN (SELECT unit_id FROM exposures)", s.slotId)).toBe(0);
    }
    // the decision record carries the repeat information and the new algorithm id
    const decision = one<{ algorithm_id: string; choices_json: string }>("SELECT algorithm_id, choices_json FROM scheduling_decisions WHERE session_id = ?", second.sessionId);
    expect(decision.algorithm_id).toBe("grammar-selection-v2");
    expect((JSON.parse(decision.choices_json).slots as Array<{ repeat: unknown }>).filter((x) => x.repeat).length).toBe(repeatSlots.length);

    // strict no-repeat for everything that is not a labelled repeat
    const shownFps = new Set(rows<{ f: string }>("SELECT u.fingerprint AS f FROM exposures e JOIN prompt_units u ON u.id = e.unit_id").map((r) => r.f));
    const freshFps = rows<{ f: string }>("SELECT DISTINCT u.fingerprint AS f FROM prompt_units u JOIN revision_prompt_units rpu ON rpu.unit_id = u.id JOIN session_slots ss ON ss.exercise_revision_id = rpu.revision_id WHERE ss.session_id = ? AND COALESCE(json_extract(ss.cohort_json, '$.repeat'), 0) <> 1", second.sessionId).map((r) => r.f);
    expect(freshFps.some((f) => shownFps.has(f))).toBe(false);

    // play the repeat slots: attempts are real, but they are not independent evidence
    lease(second.sessionId);
    for (const s of repeatSlots) {
      reveal(second.sessionId, s.slotId);
      expect(count("exposures WHERE slot_id = ?", s.slotId)).toBe(0); // every shown sentence was already in the ledger
      recordAttempt(env.db, env.deps, { slotId: s.slotId, submissionId: randomUUID(), answer: correctRaw(s.slotId), inputMode: "text" });
    }
    const opps = rows<{ independent: number }>("SELECT o.independent FROM skill_opportunities o JOIN assessment_revisions a ON a.id = o.assessment_id JOIN attempts t ON t.id = a.attempt_id WHERE t.slot_id IN (" + repeatSlots.map(() => "?").join(",") + ")", ...repeatSlots.map((s) => s.slotId));
    expect(opps.length).toBeGreaterThan(0);
    expect(opps.every((o) => o.independent === 0)).toBe(true);
    expect(count("skill_opportunities WHERE independent = 1")).toBe(independentBefore); // the inputs of Mastery did not move
    // a fresh slot of the same session still produces independent evidence
    const fresh = second.snapshot.slots.find((s) => !s.repeat)!;
    reveal(second.sessionId, fresh.slotId);
    recordAttempt(env.db, env.deps, { slotId: fresh.slotId, submissionId: randomUUID(), answer: correctRaw(fresh.slotId), inputMode: "text" });
    expect(count("skill_opportunities WHERE independent = 1")).toBeGreaterThan(independentBefore);
    // raw attempts of session 1 are untouched (12 answered, 6 skipped)
    expect(count("attempts a JOIN session_slots ss ON ss.id = a.slot_id WHERE ss.session_id = ?", first.sessionId)).toBe(12);
  }, 120_000);

  it("a correct answer is due again only after 14 days; a miss or skip from the next session on", () => {
    env = openSliceCopy();
    const first = begin(env, "one");
    play(first.sessionId, (o) => (o < 9 ? "ok" : "skip"));
    const all = loadCandidates(env.db, "practice", [], null);
    const now = env.deps.now();
    const reasonsAt = (at: Date) => new Map(withRepeats(env.db, all, at).candidates.filter((c) => c.repeat).map((c) => [c.revisionId, c.repeat!.reason]));
    const day1 = reasonsAt(new Date(now.getTime() + DAY));
    expect([...day1.values()].every((r) => r === "missed")).toBe(true);
    expect(day1.size).toBe(9);
    expect(reasonsAt(new Date(now.getTime() + 13 * DAY)).size).toBe(9);
    const day15 = reasonsAt(new Date(now.getTime() + 15 * DAY));
    expect(day15.size).toBe(18);
    expect([...day15.values()].filter((r) => r === "review")).toHaveLength(9);
    // a repeat lists only the units never exposed; the shown ones are in the ledger already
    const exposedFps = new Set(rows<{ f: string }>("SELECT u.fingerprint AS f FROM exposures e JOIN prompt_units u ON u.id = e.unit_id").map((r) => r.f));
    for (const c of withRepeats(env.db, all, new Date(now.getTime() + 15 * DAY)).candidates.filter((x) => x.repeat)) expect(c.unitFingerprints.some((f) => exposedFps.has(f))).toBe(false);
    // the active (unfinished) session never feeds repeats: an exercise shown now is not yet history
    advanceClock(env, 1000);
  }, 120_000);

  it("a tentative model verdict never schedules a repeat: it stays 'unchecked' (counts like correct, 14 days)", () => {
    env = openSliceCopy();
    const first = begin(env, "one");
    play(first.sessionId, () => "ok");
    // a local-model opinion appended later (tentative incorrect) must not make the exercise due tomorrow
    const attempts = rows<{ id: string; seq: number }>("SELECT t.id AS id, MAX(a.sequence) AS seq FROM attempts t JOIN assessment_revisions a ON a.attempt_id = t.id GROUP BY t.id");
    for (const a of attempts) env.db.prepare("INSERT INTO assessment_revisions(id, attempt_id, sequence, source, verdict, confirmation, criterion_version, supersedes_id, rationale, created_at) SELECT ?, ?, ?, 'model', 'incorrect', 'tentative', criterion_version, (SELECT id FROM assessment_revisions WHERE attempt_id = ? AND sequence = ?), 'model opinion', ? FROM attempts WHERE id = ?").run(randomUUID(), a.id, a.seq + 1, a.id, a.seq, env.deps.now().toISOString(), a.id);
    const all = loadCandidates(env.db, "practice", [], null);
    const day1 = withRepeats(env.db, all, new Date(env.deps.now().getTime() + DAY)).candidates.filter((c) => c.repeat);
    expect(day1).toHaveLength(0);
    expect(withRepeats(env.db, all, new Date(env.deps.now().getTime() + 15 * DAY)).candidates.filter((c) => c.repeat?.reason === "review")).toHaveLength(18);
  }, 120_000);

  it("readiness counts reusable exercises, writes nothing, and a session can really be started from them", () => {
    env = openSliceCopy();
    const strict = computeReadiness(env.db, env.deps, env.blueprintRevisionId).readySessions; // fresh bank only
    expect(strict).toBe(2);
    const first = begin(env, "one");
    play(first.sessionId, () => "skip"); // everything shown and missed: 18 exercises are due repeats
    const reservationsBefore = count("prompt_reservations");
    const ready = computeReadiness(env.db, env.deps, env.blueprintRevisionId);
    expect(ready.readySessions).toBeGreaterThanOrEqual(1);
    expect(count("prompt_reservations")).toBe(reservationsBefore);
    expect(begin(env, "two").snapshot.taskCount).toBe(18);
  }, 180_000);
});

describe("replenishment is planned from the next lesson's deficits (D68)", () => {
  it("a learner with no practice session gets the first lesson, with numbers per format and the +20% recommendation", () => {
    env = openSliceCopy();
    expect(count("sessions")).toBe(0);
    const stock = replenishmentStock(env.db, env.deps.now());
    const key = one<{ key: string }>("SELECT b.stable_key AS key FROM blueprints b JOIN blueprint_revisions br ON br.blueprint_id = b.id WHERE br.id = ?", env.blueprintRevisionId).key;
    expect(stock.grammar).toMatchObject({ scope: "next lesson", lesson: { key } });
    const view = lessonPlanView(env.db, env.deps.now())!;
    const next = view.lessons[view.nextIndex]!;
    expect(next.key).toBe(key);
    const formatSum = next.formats.reduce((a, f) => a + f.deficit, 0);
    expect((stock.grammar as { recommended: number }).recommended).toBe(Math.ceil(next.deficit * 1.2));
    expect(next.deficit).toBeGreaterThanOrEqual(formatSum);
    if (stock.grammar.low) {
      const msg = (stock.grammar as { message: string }).message;
      expect(msg).toContain("needs:");
      expect(msg).not.toContain("warning below");
      for (const f of next.formats.filter((x) => x.deficit > 0)) expect(msg).toContain(`${f.format} ${f.deficit}`);
    }
  });

  it("the learner's level range changes the numbers: a range with no exercise at those levels leaves everything missing", () => {
    env = openSliceCopy();
    const levels = rows<{ d: string }>("SELECT DISTINCT difficulty AS d FROM exercise_revisions WHERE bank_role = 'practice'").map((r) => r.d);
    const wide = lessonPlanView(env.db, env.deps.now())!.lessons[0]!;
    const missingLevel = (["C1", "B2", "B1", "A2"] as const).find((l) => !levels.includes(l))!;
    const v1 = JSON.parse(one<{ values_json: string }>("SELECT values_json FROM settings_revisions WHERE revision = 1").values_json);
    env.db.prepare("INSERT INTO settings_revisions(id, revision, values_json, created_at) VALUES (?,?,?,?)").run(randomUUID(), 2, JSON.stringify({ ...v1, difficultyMin: missingLevel, difficultyMax: missingLevel }), "now");
    const narrow = lessonPlanView(env.db, env.deps.now())!.lessons[0]!;
    expect(narrow.range).toBe(missingLevel);
    expect(narrow.available).toBe(0);
    expect(narrow.deficit).toBeGreaterThan(wide.deficit);
    expect(replenishmentStock(env.db, env.deps.now()).grammar).toMatchObject({ low: true, available: 0 });
  });

  it("reusable (shown) exercises count against the deficit", () => {
    env = openSliceCopy();
    const before = lessonPlanView(env.db, env.deps.now())!.lessons[0]!;
    const first = begin(env, "one");
    play(first.sessionId, () => "skip");
    const after = lessonPlanView(env.db, env.deps.now())!.lessons[0]!;
    // 18 shown exercises are due, but the solver can use at most floor(0.3*18)=5 missed repeats per session: 2 sessions -> 10
    expect(after.reusable).toBe(10);
    expect(after.fresh).toBe(before.fresh - 18);
    expect(after.available).toBe(after.fresh + after.reusable);
  }, 120_000);

  it("an adaptive batch is drawn from the lesson's skill pool and the missing formats, sized by the recommendation", () => {
    env = openSliceCopy();
    const view = lessonPlanView(env.db, env.deps.now())!;
    const next = view.lessons[view.nextIndex]!;
    const rec = Math.max(next.recommended, 6);
    const created = createBatch(env.db, env.deps, { count: rec, mode: "adaptive" });
    expect(created.items).toBe(rec);
    const plans = rows<{ plan_json: string }>("SELECT plan_json FROM batch_items WHERE batch_id = ? ORDER BY ordinal", created.batchId).map((r) => JSON.parse(r.plan_json) as { lesson?: string; target_skill: string; type: string });
    expect(plans.every((p) => p.lesson === next.key)).toBe(true);
    if (next.skillPool.length > 0) expect(plans.every((p) => next.skillPool.includes(p.target_skill))).toBe(true);
    const missing = new Set(next.formats.filter((f) => f.deficit > 0).map((f) => f.format));
    if (missing.size > 0 && next.recommended > 0) expect(plans.every((p) => missing.has(p.type as never))).toBe(true);
    // asking for more than recommended still serves the lesson (a single lesson here: spread over its thinnest skills)
    expect(createBatch(env.db, env.deps, { count: rec + 15, mode: "adaptive" }).items).toBe(rec + 15);
    // an explicit skill list keeps working as before (manual mode)
    const skill = next.skillPool[0] ?? one<{ skill_id: string }>("SELECT skill_id FROM skill_revisions WHERE active = 1 LIMIT 1").skill_id;
    const manual = createBatch(env.db, env.deps, { count: 4, mode: "manual", skills: [skill], types: ["choose_form"] });
    expect(rows<{ plan_json: string }>("SELECT plan_json FROM batch_items WHERE batch_id = ?", manual.batchId).every((r) => !("lesson" in (JSON.parse(r.plan_json) as object)))).toBe(true);
  });
});
