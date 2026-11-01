import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { CreateSessionResponse, SessionSnapshot } from "../../../packages/contracts/src/index.js";
import { recordAttempt } from "../../../apps/server/src/domain/attempts/attempts.js";
import { recordSessionEvent } from "../../../apps/server/src/domain/attempts/sessionEvents.js";
import { NO_MISTAKE_ID } from "../../../apps/server/src/domain/content/grader.js";
import { createPracticeSession } from "../../../apps/server/src/domain/sessions/create.js";
import { getFeedback } from "../../../apps/server/src/domain/sessions/feedback.js";
import { finishSession } from "../../../apps/server/src/domain/sessions/finish.js";
import { takeLease } from "../../../apps/server/src/domain/sessions/lease.js";
import { computeReadiness } from "../../../apps/server/src/domain/sessions/readiness.js";
import { revealSlot } from "../../../apps/server/src/domain/sessions/reveal.js";
import { getSnapshot } from "../../../apps/server/src/domain/sessions/snapshot.js";
import { ApiError } from "../../../apps/server/src/errors.js";
import { advanceClock, buildSliceTemplate, disposeSliceTemplate, openSliceCopy, type SliceEnv } from "./slice-fixture.js";

let env: SliceEnv;
beforeAll(() => {
  buildSliceTemplate();
}, 180_000);
afterAll(() => disposeSliceTemplate());
afterEach(() => env?.cleanup());

const TAB = "tab-1";
const begin = (e: SliceEnv, seed = "seed-1"): CreateSessionResponse => createPracticeSession(e.db, e.deps, { purpose: "practice", blueprintRevisionId: e.blueprintRevisionId, seed, timezone: "Australia/Brisbane" });
const one = <T = Record<string, unknown>>(sql: string, ...p: unknown[]) => env.db.prepare(sql).get(...p) as T;
const rows = <T = Record<string, unknown>>(sql: string, ...p: unknown[]) => env.db.prepare(sql).all(...p) as T[];
const count = (t: string) => (one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)).n;
const failsWith = (fn: () => unknown, status: number, code: string) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    expect({ status: (e as ApiError).status, code: (e as ApiError).code }).toEqual({ status, code });
    return e as ApiError;
  }
  throw new Error(`expected ApiError ${status} ${code}`);
};

/** The answer a learner would give to be correct, read from the stored exercise (the test acts as the learner). */
function correctRaw(slotId: string): { answer?: string | string[]; } {
  const r = one<{ type: string; content: string; q: string | null }>("SELECT er.type AS type, er.content_json AS content, ss.question_id AS q FROM session_slots ss JOIN exercise_revisions er ON er.id = ss.exercise_revision_id WHERE ss.id = ?", slotId);
  const c = JSON.parse(r.content) as { payload: any };
  if (r.type === "detect_error") return { answer: c.payload.no_mistake ? [NO_MISTAKE_ID] : c.payload.accepted_segment_ids };
  if (r.type === "context_reading") return { answer: c.payload.questions.find((q: any) => q.id === r.q).accepted_option_ids };
  if (r.type === "choose_form" || r.type === "choose_missing_fragment") return { answer: c.payload.accepted_option_ids };
  return { answer: c.payload.accepted_answers[0] };
}

const lease = (sessionId: string, tab = TAB) => takeLease(env.db, env.deps, sessionId, tab);
const reveal = (sessionId: string, slotId: string, tab = TAB) => revealSlot(env.db, env.deps, sessionId, slotId, tab);
const answer = (slotId: string, a: string | string[], submissionId = randomUUID()) => recordAttempt(env.db, env.deps, { slotId, submissionId, answer: a, inputMode: "text" });

/** Plays a whole session: reveal, answer correctly (or skip), read feedback, continue. */
function playAll(sessionId: string, mode: "answer" | "skip") {
  lease(sessionId);
  for (const s of getSnapshot(env.db, sessionId).slots) {
    reveal(sessionId, s.slotId);
    if (mode === "answer") {
      answer(s.slotId, correctRaw(s.slotId).answer!);
      getFeedback(env.db, env.deps, sessionId, s.slotId);
      recordSessionEvent(env.db, env.deps, sessionId, { slotId: s.slotId, type: "continue", clientEventId: randomUUID() });
    } else {
      recordSessionEvent(env.db, env.deps, sessionId, { slotId: s.slotId, type: "skip", clientEventId: randomUUID() });
    }
  }
}
/** D68: sentences of the slots that are NOT labelled repeats - these must always be new */
const freshFingerprints = (sessionId: string): string[] =>
  rows<{ f: string }>("SELECT DISTINCT u.fingerprint AS f FROM prompt_units u JOIN revision_prompt_units rpu ON rpu.unit_id = u.id JOIN session_slots ss ON ss.exercise_revision_id = rpu.revision_id WHERE ss.session_id = ? AND COALESCE(json_extract(ss.cohort_json, '$.repeat'), 0) <> 1", sessionId).map((r) => r.f);
const sessionFingerprints = (sessionId: string): string[] =>
  rows<{ f: string }>("SELECT DISTINCT u.fingerprint AS f FROM prompt_units u JOIN revision_prompt_units rpu ON rpu.unit_id = u.id JOIN session_slots ss ON ss.exercise_revision_id = rpu.revision_id WHERE ss.session_id = ?", sessionId).map((r) => r.f);

describe("a default snapshot (N=18, 5/5/5/1/2)", () => {
  it("meets the quota and every hard rule, pins settings/plan/blueprint/seed and exposes nothing yet", () => {
    env = openSliceCopy();
    const { sessionId, snapshot } = begin(env);
    expect(snapshot).toMatchObject({ status: "active", purpose: "practice", taskCount: 18, progress: { closed: 0, total: 18 } });
    const by = (f: string) => snapshot.slots.filter((s) => s.format === f).length;
    expect([by("choose_form"), by("choose_missing_fragment"), by("detect_error"), by("guided_short_answer"), by("russian_to_english_short")]).toEqual([5, 5, 5, 1, 2]);
    expect(snapshot.slots.every((s) => s.state === "unrevealed" && s.attempts === 0 && s.latest === null)).toBe(true);
    expect(snapshot.slots.map((s) => s.ordinal)).toEqual(Array.from({ length: 18 }, (_, i) => i));
    expect(snapshot.slots.filter((s) => s.inputPreference === "voice")).toHaveLength(2); // settings voiceTarget=2, production slots only
    expect(snapshot.slots.filter((s) => s.inputPreference === "voice").every((s) => s.dimension === "production")).toBe(true);

    // hard rules, checked in SQL on the stored rows
    const sel = rows<{ ex: string; cluster: string; family: string; type: string; nm: number }>(
      `SELECT er.exercise_id AS ex, er.template_cluster AS cluster, sr.family AS family, er.type AS type,
              CASE WHEN json_extract(er.content_json, '$.payload.no_mistake') = 1 THEN 1 ELSE 0 END AS nm
         FROM session_slots ss JOIN exercise_revisions er ON er.id = ss.exercise_revision_id
         JOIN exercise_skills es ON es.revision_id = er.id AND es.role = 'target' JOIN skill_revisions sr ON sr.id = es.skill_revision_id WHERE ss.session_id = ?`,
      sessionId,
    );
    expect(new Set(sel.map((s) => s.ex)).size).toBe(18);
    expect(new Set(sel.map((s) => s.cluster)).size).toBe(18);
    const perFamily = new Map<string, number>();
    for (const s of sel) perFamily.set(s.family, (perFamily.get(s.family) ?? 0) + 1);
    expect(Math.max(...perFamily.values())).toBeLessThanOrEqual(7); // ceil(.35 * 18)
    expect(perFamily.size).toBeGreaterThanOrEqual(3);
    expect(sel.some((s) => s.type === "detect_error" && s.nm === 1)).toBe(true); // a No-mistake case with >= 4 detect_error slots

    // pinned versions and the audit decision
    const s = one<{ settings_revision_id: string; plan_id: string; selection_version: string; random_seed: string; blueprint_revision_id: string }>("SELECT * FROM sessions WHERE id = ?", sessionId);
    expect(s).toMatchObject({ selection_version: "grammar-selection-v3", random_seed: "seed-1", blueprint_revision_id: env.blueprintRevisionId });
    expect(one<{ revision: number }>("SELECT revision FROM settings_revisions WHERE id = ?", s.settings_revision_id).revision).toBe(2);
    expect(one<{ reviewer: string }>("SELECT reviewer FROM learning_plans WHERE id = ?", s.plan_id).reviewer).toBe("system:baseline");
    const d = one<{ choices_json: string; deficits_json: string; algorithm_id: string; candidate_hash: string }>("SELECT * FROM scheduling_decisions WHERE session_id = ?", sessionId);
    const choices = JSON.parse(d.choices_json) as { seed: string; stats: { weakTarget: number; weakActual: number }; slots: unknown[]; discovery: { version: string; qualificationIds: string[] } };
    expect(d.algorithm_id).toBe("grammar-selection-v3");
    expect(d.candidate_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(choices).toMatchObject({ seed: "seed-1", stats: { weakTarget: 12, weakActual: 12 }, discovery: { version: "discovery-v1", qualificationIds: [] } });
    expect(choices.slots).toHaveLength(18);
    expect(JSON.parse(d.deficits_json).soft.vocabularyShare).toContain("not tracked"); // soft limits are disclosed, not hidden

    // every unit of every chosen revision is RESERVED; nothing is EXPOSED before the first reveal
    const units = rows("SELECT DISTINCT rpu.unit_id FROM revision_prompt_units rpu JOIN session_slots ss ON ss.exercise_revision_id = rpu.revision_id WHERE ss.session_id = ?", sessionId).length;
    expect(count("prompt_reservations")).toBe(units);
    expect(count("exposures")).toBe(0);
  });

  it("is reproducible: the same seed gives the same slots, another seed a different session", () => {
    env = openSliceCopy();
    const a = begin(env, "repeat");
    const orderA = rows<{ r: string }>("SELECT exercise_revision_id AS r FROM session_slots WHERE session_id = ? ORDER BY ordinal", a.sessionId).map((x) => x.r);
    finishSession(env.db, env.deps, a.sessionId, "ended_early"); // releases the reservations (nothing was shown)
    const b = begin(env, "repeat");
    expect(rows<{ r: string }>("SELECT exercise_revision_id AS r FROM session_slots WHERE session_id = ? ORDER BY ordinal", b.sessionId).map((x) => x.r)).toEqual(orderA);
    finishSession(env.db, env.deps, b.sessionId, "ended_early");
    const c = begin(env, "different");
    expect(rows<{ r: string }>("SELECT exercise_revision_id AS r FROM session_slots WHERE session_id = ? ORDER BY ordinal", c.sessionId).map((x) => x.r)).not.toEqual(orderA);
  });

  it("allows one active session: a second request resumes instead of allocating again", () => {
    env = openSliceCopy();
    const a = begin(env);
    const e = failsWith(() => begin(env, "other"), 409, "SESSION_ACTIVE");
    expect(e.details).toEqual({ sessionId: a.sessionId });
    expect(count("session_slots")).toBe(18);
  });

  it("only practice sessions exist for now; a practice session needs an approved blueprint", () => {
    env = openSliceCopy();
    failsWith(() => createPracticeSession(env.db, env.deps, { purpose: "heldout", timezone: "Australia/Brisbane" }), 422, "PURPOSE_NOT_AVAILABLE");
    failsWith(() => createPracticeSession(env.db, env.deps, { purpose: "practice", timezone: "Australia/Brisbane" }), 422, "BLUEPRINT_REQUIRED");
    failsWith(() => createPracticeSession(env.db, env.deps, { purpose: "practice", blueprintRevisionId: randomUUID(), timezone: "Australia/Brisbane" }), 404, "BLUEPRINT_NOT_FOUND");
    failsWith(() => createPracticeSession(env.db, env.deps, { purpose: "practice", blueprintRevisionId: env.blueprintRevisionId, timezone: "Mars/Olympus" }), 422, "TIMEZONE_INVALID");
  });
});

describe("two allocations never share a sentence (reservations)", () => {
  it("a second snapshot built while the first is still held is disjoint from it", () => {
    env = openSliceCopy();
    const a = begin(env, "first");
    env.db.prepare("UPDATE sessions SET status = 'suspended' WHERE id = ?").run(a.sessionId); // still holds its reservations
    const b = begin(env, "second");
    const fa = new Set(sessionFingerprints(a.sessionId));
    const fb = sessionFingerprints(b.sessionId);
    expect(fb.some((f) => fa.has(f))).toBe(false);
    const exA = new Set(rows<{ e: string }>("SELECT er.exercise_id AS e FROM session_slots ss JOIN exercise_revisions er ON er.id = ss.exercise_revision_id WHERE ss.session_id = ?", a.sessionId).map((r) => r.e));
    expect(rows<{ e: string }>("SELECT er.exercise_id AS e FROM session_slots ss JOIN exercise_revisions er ON er.id = ss.exercise_revision_id WHERE ss.session_id = ?", b.sessionId).some((r) => exA.has(r.e))).toBe(false);
  });

  it("the database itself refuses to reserve a held unit twice, or a shown unit at all", () => {
    env = openSliceCopy();
    const a = begin(env);
    const held = one<{ unit_id: string }>("SELECT unit_id FROM prompt_reservations LIMIT 1").unit_id;
    const otherSlot = one<{ id: string }>("SELECT id FROM session_slots WHERE session_id = ? ORDER BY ordinal DESC LIMIT 1", a.sessionId).id;
    expect(() => env.db.prepare("INSERT INTO prompt_reservations(unit_id, slot_id, created_at) VALUES (?,?,?)").run(held, otherSlot, "now")).toThrow(/UNIQUE|PRIMARY/);
    // expose one unit, release the rest by ending early: the exposed one stays held forever
    lease(a.sessionId);
    reveal(a.sessionId, getSnapshot(env.db, a.sessionId).slots[0]!.slotId);
    finishSession(env.db, env.deps, a.sessionId, "ended_early");
    const shown = one<{ unit_id: string }>("SELECT unit_id FROM exposures LIMIT 1").unit_id;
    expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM prompt_reservations WHERE unit_id = ?", shown).n).toBe(1);
    expect(() => env.db.prepare("DELETE FROM prompt_reservations WHERE unit_id = ?").run(shown)).toThrow(/exposed unit cannot be released/);
    const free = one<{ id: string }>("SELECT id FROM prompt_units WHERE id NOT IN (SELECT unit_id FROM prompt_reservations) LIMIT 1").id;
    expect(() => env.db.prepare("INSERT INTO exposures(id, unit_id, slot_id, exposed_at) VALUES (?,?,?,?)").run(randomUUID(), free, otherSlot, "now")).toThrow(/not reserved/);
    expect(() => env.db.prepare("UPDATE exposures SET exposed_at = 'x'").run()).toThrow(/append-only/);
    expect(() => env.db.prepare("DELETE FROM exposures").run()).toThrow(/append-only/);
  });
});

describe("reveal: exposure before delivery", () => {
  it("needs the practice lease; a second tab is refused while the first holds it", () => {
    env = openSliceCopy();
    const { sessionId, snapshot } = begin(env);
    failsWith(() => reveal(sessionId, snapshot.slots[0]!.slotId), 409, "LEASE_REQUIRED");
    const l = lease(sessionId);
    expect(l.token).toBe(1);
    expect(lease(sessionId).token).toBe(1); // heartbeat of the same tab
    failsWith(() => lease(sessionId, "tab-2"), 409, "LEASE_HELD");
    failsWith(() => reveal(sessionId, snapshot.slots[0]!.slotId, "tab-2"), 409, "LEASE_REQUIRED");
    advanceClock(env, 91_000); // the lease expires after 90 s without a heartbeat
    expect(lease(sessionId, "tab-2").token).toBe(2); // takeover bumps the fencing token
    failsWith(() => reveal(sessionId, snapshot.slots[0]!.slotId, TAB), 409, "LEASE_REQUIRED");
  });

  it("commits the exposure of every shown sentence in the same transaction as the reveal event, and shows prompt + options only", () => {
    env = openSliceCopy();
    const { sessionId, snapshot } = begin(env);
    lease(sessionId);
    const slot = snapshot.slots[0]!;
    const r = reveal(sessionId, slot.slotId);
    expect(r).toMatchObject({ alreadyRevealed: false, state: "revealed", slotId: slot.slotId });
    // nothing the learner must not see is in the payload
    const json = JSON.stringify(r);
    for (const secret of ["accepted", "explanation", "hints_ru", "rubric", "corrections", "no_mistake"]) expect(json).not.toContain(secret);
    expect(JSON.stringify(r.prompt)).not.toMatch(/"correct"/);

    const reveals = rows<{ server_at: string }>("SELECT server_at FROM session_events WHERE slot_id = ? AND event_type = 'reveal'", slot.slotId);
    expect(reveals).toHaveLength(1);
    const exposed = rows<{ role: string; exposed_at: string }>(
      "SELECT DISTINCT rpu.role AS role, e.exposed_at AS exposed_at FROM exposures e JOIN revision_prompt_units rpu ON rpu.unit_id = e.unit_id JOIN session_slots ss ON ss.exercise_revision_id = rpu.revision_id WHERE ss.id = ?",
      slot.slotId,
    );
    expect(exposed.length).toBeGreaterThan(0);
    expect(exposed.every((e) => ["prompt", "option", "passage"].includes(e.role))).toBe(true); // accepted answers are NOT shown yet
    expect(exposed.every((e) => e.exposed_at <= reveals[0]!.server_at)).toBe(true);
    // accepted-answer units are reserved but not exposed
    expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM revision_prompt_units rpu JOIN session_slots ss ON ss.exercise_revision_id = rpu.revision_id WHERE ss.id = ? AND rpu.role = 'answer' AND rpu.unit_id NOT IN (SELECT unit_id FROM exposures)", slot.slotId).n).toBeGreaterThan(0);
  });

  it("resume: revealing again exposes nothing new and returns the same prompt", () => {
    env = openSliceCopy();
    const { sessionId, snapshot } = begin(env);
    lease(sessionId);
    const first = reveal(sessionId, snapshot.slots[0]!.slotId);
    const exposures = count("exposures");
    const again = reveal(sessionId, snapshot.slots[0]!.slotId);
    expect(again).toMatchObject({ alreadyRevealed: true, prompt: first.prompt });
    expect(count("exposures")).toBe(exposures);
    expect(count("session_events")).toBe(1);
  });

  it("rolls back completely when an exposure cannot be written (no reveal event, no half-exposed slot)", () => {
    env = openSliceCopy();
    const { sessionId, snapshot } = begin(env);
    lease(sessionId);
    const slot = snapshot.slots[0]!;
    // sabotage: drop one reservation of the slot's units, so the exposures trigger refuses mid-way
    const unit = one<{ unit_id: string }>("SELECT pr.unit_id FROM prompt_reservations pr WHERE pr.slot_id = ? AND pr.unit_id IN (SELECT unit_id FROM revision_prompt_units WHERE role IN ('prompt','option')) LIMIT 1", slot.slotId).unit_id;
    env.db.prepare("DELETE FROM prompt_reservations WHERE unit_id = ?").run(unit);
    expect(() => reveal(sessionId, slot.slotId)).toThrow(/not reserved/);
    expect([count("exposures"), count("session_events")]).toEqual([0, 0]);
  });

  it("the shown sentences never come back as new: only as labelled repeats (D68)", () => {
    env = openSliceCopy();
    const a = begin(env, "a");
    lease(a.sessionId);
    for (const s of a.snapshot.slots.slice(0, 5)) reveal(a.sessionId, s.slotId);
    const shown = rows<{ f: string }>("SELECT u.fingerprint AS f FROM exposures e JOIN prompt_units u ON u.id = e.unit_id").map((r) => r.f);
    expect(shown.length).toBeGreaterThan(2); // written-answer formats show nothing until feedback
    finishSession(env.db, env.deps, a.sessionId, "ended_early");
    const b = begin(env, "b");
    const fb = new Set(freshFingerprints(b.sessionId));
    expect(shown.some((f) => fb.has(f))).toBe(false);
  });
});

describe("feedback", () => {
  it("is closed until the learner answers, skips or views the answer; the accepted answers are exposed only when it is sent", () => {
    env = openSliceCopy();
    const { sessionId, snapshot } = begin(env);
    lease(sessionId);
    const slot = snapshot.slots.find((s) => s.format === "choose_form")!;
    reveal(sessionId, slot.slotId);
    failsWith(() => getFeedback(env.db, env.deps, sessionId, slot.slotId), 409, "FEEDBACK_NOT_AVAILABLE");
    const before = count("exposures");
    answer(slot.slotId, correctRaw(slot.slotId).answer!);
    expect(count("exposures")).toBe(before); // answering alone exposes no answer sentence
    const f = getFeedback(env.db, env.deps, sessionId, slot.slotId);
    expect(f).toMatchObject({ state: "confirmed", verdict: "correct", message: "Correct." });
    expect(f.explanation_ru).toMatch(/[Ѐ-ӿ]/);
    expect(count("exposures")).toBeGreaterThan(before); // the answer sentence was committed before it was returned
  });

  it("incorrect and IDK show the answer; a written answer that is not an approved alternative stays pending (never wrong)", () => {
    env = openSliceCopy();
    const { sessionId, snapshot } = begin(env);
    lease(sessionId);
    const form = snapshot.slots.find((s) => s.format === "choose_form")!;
    reveal(sessionId, form.slotId);
    answer(form.slotId, ["c"]);
    expect(getFeedback(env.db, env.deps, sessionId, form.slotId)).toMatchObject({ state: "confirmed", verdict: "incorrect", correct: { options: expect.any(Array) } });

    const detect = snapshot.slots.find((s) => s.format === "detect_error")!;
    reveal(sessionId, detect.slotId);
    recordAttempt(env.db, env.deps, { slotId: detect.slotId, submissionId: randomUUID(), idk: true, inputMode: "text" });
    expect(getFeedback(env.db, env.deps, sessionId, detect.slotId)).toMatchObject({ state: "confirmed", verdict: "idk" });

    const prod = snapshot.slots.find((s) => s.format === "guided_short_answer")!;
    reveal(sessionId, prod.slotId);
    const r = answer(prod.slotId, "He quit it two years ago.");
    expect(r.body.assessment).toMatchObject({ verdict: "pending", status: "pending" });
    expect(r.body.feedback).toEqual({ allowed: false, reason: "assessment_pending" });
    const fb = getFeedback(env.db, env.deps, sessionId, prod.slotId);
    expect(fb).toMatchObject({ state: "pending", verdict: "pending", explanation_ru: null });
    expect(fb.message).toContain("AI review after this session");
    expect(fb.message).toContain("not marked wrong");
    expect(fb.message).not.toMatch(/not this time|incorrect/i);
    expect(getSnapshot(env.db, sessionId).slots.find((s) => s.slotId === prod.slotId)).toMatchObject({ state: "answered", latest: { verdict: "pending" } });
  });

  it("an approved alternative is accepted at once (exact match) and a skip is not a mistake", () => {
    env = openSliceCopy();
    const { sessionId, snapshot } = begin(env);
    lease(sessionId);
    const prod = snapshot.slots.find((s) => s.format === "russian_to_english_short")!;
    reveal(sessionId, prod.slotId);
    expect(answer(prod.slotId, correctRaw(prod.slotId).answer!).body.assessment).toMatchObject({ verdict: "correct", confirmation: "confirmed" });
    const form = snapshot.slots.find((s) => s.format === "choose_missing_fragment")!;
    reveal(sessionId, form.slotId);
    recordSessionEvent(env.db, env.deps, sessionId, { slotId: form.slotId, type: "skip", clientEventId: randomUUID() });
    expect(getFeedback(env.db, env.deps, sessionId, form.slotId)).toMatchObject({ state: "skipped", correct: null });
    expect(count("attempts")).toBe(1); // the skip created no attempt
  });

  it("show answer marks later attempts as assisted and the answer sentence is exposed", () => {
    env = openSliceCopy();
    const { sessionId, snapshot } = begin(env);
    lease(sessionId);
    const slot = snapshot.slots.find((s) => s.format === "choose_form")!;
    reveal(sessionId, slot.slotId);
    recordSessionEvent(env.db, env.deps, sessionId, { slotId: slot.slotId, type: "reveal_answer", clientEventId: randomUUID() });
    expect(getFeedback(env.db, env.deps, sessionId, slot.slotId)).toMatchObject({ state: "confirmed", verdict: null, correct: { options: expect.any(Array) } });
    const r = answer(slot.slotId, correctRaw(slot.slotId).answer!);
    expect(r.body).toMatchObject({ assisted: true, firstAttempt: true });
  });
});

describe("skip consumes the sentence (seen)", () => {
  it("a skipped slot's shown sentences can never come back as 'new'", () => {
    env = openSliceCopy();
    const a = begin(env, "s1");
    lease(a.sessionId);
    const slot = a.snapshot.slots[0]!;
    reveal(a.sessionId, slot.slotId);
    recordSessionEvent(env.db, env.deps, a.sessionId, { slotId: slot.slotId, type: "skip", clientEventId: randomUUID() });
    const skippedFps = rows<{ f: string }>("SELECT u.fingerprint AS f FROM exposures e JOIN prompt_units u ON u.id = e.unit_id").map((r) => r.f);
    expect(skippedFps.length).toBeGreaterThan(0);
    finishSession(env.db, env.deps, a.sessionId, "ended_early");
    for (let i = 0; i < 2; i++) {
      const b = begin(env, `again-${i}`);
      expect(freshFingerprints(b.sessionId).some((f) => skippedFps.includes(f))).toBe(false); // D68: a skipped sentence can return, but only as a labelled repeat
      finishSession(env.db, env.deps, b.sessionId, "ended_early");
    }
  });
});

describe("finishing", () => {
  it("completed needs every slot closed; ended_early never claims completion and frees only unshown sentences", () => {
    env = openSliceCopy();
    const a = begin(env);
    lease(a.sessionId);
    const [first, second] = a.snapshot.slots;
    reveal(a.sessionId, first!.slotId);
    answer(first!.slotId, correctRaw(first!.slotId).answer!);
    recordSessionEvent(env.db, env.deps, a.sessionId, { slotId: first!.slotId, type: "continue", clientEventId: randomUUID() });
    reveal(a.sessionId, second!.slotId);
    const e = failsWith(() => finishSession(env.db, env.deps, a.sessionId, "completed"), 409, "SLOTS_OPEN");
    expect(e.details).toEqual({ open: 17 });
    expect(one<{ status: string }>("SELECT status FROM sessions WHERE id = ?", a.sessionId).status).toBe("active");

    const reservedBefore = count("prompt_reservations");
    const sum = finishSession(env.db, env.deps, a.sessionId, "ended_early");
    expect(sum).toMatchObject({ status: "ended_early", total: 18, counts: { correct: 1, unanswered: 17, pending: 0 } });
    expect(sum.notes.join(" ")).toContain("does not count as a completed lesson");
    expect(one<{ status: string; ended_at: string | null }>("SELECT status, ended_at FROM sessions WHERE id = ?", a.sessionId)).toMatchObject({ status: "ended_early" });
    expect(count("prompt_reservations")).toBeLessThan(reservedBefore);
    // exactly the exposed units remain reserved
    expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM prompt_reservations WHERE unit_id NOT IN (SELECT unit_id FROM exposures)").n).toBe(0);
    expect(count("exposures")).toBe(count("prompt_reservations"));
    expect(finishSession(env.db, env.deps, a.sessionId, "ended_early")).toEqual(sum); // idempotent
    failsWith(() => finishSession(env.db, env.deps, a.sessionId, "completed"), 409, "SESSION_NOT_ACTIVE");
    expect(count("practice_leases")).toBe(0);
  });

  it("the completion summary separates confirmed, IDK, assisted, pending and skipped - pending is never wrong", () => {
    env = openSliceCopy();
    const a = begin(env);
    lease(a.sessionId);
    const snap = a.snapshot.slots;
    const close = (slotId: string) => recordSessionEvent(env.db, env.deps, a.sessionId, { slotId, type: "continue", clientEventId: randomUUID() });
    const forms = snap.filter((s) => s.format === "choose_form");
    reveal(a.sessionId, forms[0]!.slotId); answer(forms[0]!.slotId, correctRaw(forms[0]!.slotId).answer!); close(forms[0]!.slotId); // correct
    reveal(a.sessionId, forms[1]!.slotId); answer(forms[1]!.slotId, ["c"]); close(forms[1]!.slotId); // incorrect
    reveal(a.sessionId, forms[2]!.slotId); recordAttempt(env.db, env.deps, { slotId: forms[2]!.slotId, submissionId: randomUUID(), idk: true, inputMode: "text" }); close(forms[2]!.slotId); // idk
    reveal(a.sessionId, forms[3]!.slotId); recordSessionEvent(env.db, env.deps, a.sessionId, { slotId: forms[3]!.slotId, type: "hint", clientEventId: randomUUID() }); answer(forms[3]!.slotId, correctRaw(forms[3]!.slotId).answer!); close(forms[3]!.slotId); // assisted
    reveal(a.sessionId, forms[4]!.slotId); recordSessionEvent(env.db, env.deps, a.sessionId, { slotId: forms[4]!.slotId, type: "skip", clientEventId: randomUUID() }); // skipped
    const prod = snap.find((s) => s.format === "guided_short_answer")!;
    reveal(a.sessionId, prod.slotId); answer(prod.slotId, "Something that is not an approved sentence."); close(prod.slotId); // pending
    const sum = finishSession(env.db, env.deps, a.sessionId, "ended_early");
    expect(sum.counts).toEqual({ correct: 1, incorrect: 1, idk: 1, assisted: 1, pending: 1, skipped: 1, unanswered: 12 });
    expect(sum.pendingAnalysis).toBe(1);
    expect(sum.notes.join(" ")).toMatch(/remain unconfirmed/);
  });

  it("a fully played session completes and its sentences stay seen", () => {
    env = openSliceCopy();
    const a = begin(env);
    playAll(a.sessionId, "answer");
    const sum = finishSession(env.db, env.deps, a.sessionId, "completed");
    expect(sum).toMatchObject({ status: "completed", total: 18 });
    expect(sum.counts.correct + sum.counts.pending).toBe(18 - sum.counts.assisted);
    expect(getSnapshot(env.db, a.sessionId)).toMatchObject({ status: "completed", progress: { closed: 18, total: 18 } });
  });
});

describe("no-repeat across sessions, readiness and shortage (the 45-exercise slice bank)", () => {
  it("simulates readiness sequentially and then proves it: two disjoint sessions, a third one is a shortage with the exact deficits", () => {
    env = openSliceCopy();
    const ready = computeReadiness(env.db, env.deps, env.blueprintRevisionId);
    expect(ready.readySessions).toBe(2); // 12 choose_form / 5 per session = 2; same for the others except guided (4) and translations (5)
    expect(ready.shortage?.deficits.map((d) => d.kind)).toContain("format");
    expect(ready.shortage?.requestedN).toBe(18);
    expect(count("prompt_reservations")).toBe(0); // the simulation wrote nothing
    expect(count("scheduling_decisions")).toBe(0);

    const first = begin(env, "one");
    playAll(first.sessionId, "answer");
    finishSession(env.db, env.deps, first.sessionId, "completed");
    const second = begin(env, "two");
    const f1 = new Set(sessionFingerprints(first.sessionId));
    expect(freshFingerprints(second.sessionId).some((f) => f1.has(f))).toBe(false); // nothing from session 1 comes back as new (a correct answer is not due for 14 days)
    expect(sessionFingerprints(second.sessionId).some((f) => f1.has(f))).toBe(false);
    playAll(second.sessionId, "skip");
    finishSession(env.db, env.deps, second.sessionId, "completed");

    const e = failsWith(() => begin(env, "three"), 409, "CONTENT_SHORTAGE");
    const d = e.details as { deficits: Array<{ kind: string; format: string; needed: number; available: number }>; largestFeasibleN: number | null; requestedN: number };
    expect(d.requestedN).toBe(18);
    expect(d.deficits.length).toBeGreaterThan(0); // session 2 was skipped, so its exercises are due repeats - capped at 30% of the slots, so still not enough for 18
    // the suggestion is only a suggestion: nothing was created, and it really is feasible when asked for explicitly
    expect(count("sessions")).toBe(2);
    if (d.largestFeasibleN !== null) {
      expect(d.largestFeasibleN).toBeLessThan(18);
      const settings = one<{ values_json: string }>("SELECT values_json FROM settings_revisions WHERE revision = 1");
      env.db.prepare("INSERT INTO settings_revisions(id, revision, values_json, created_at) VALUES (?,?,?,?)").run(randomUUID(), 3, JSON.stringify({ ...JSON.parse(settings.values_json), taskCount: d.largestFeasibleN }), "now");
      expect(begin(env, "smaller").snapshot.taskCount).toBe(d.largestFeasibleN);
    }
  });

  it("settings changes apply to the next snapshot only; an existing snapshot keeps its pinned revision", () => {
    env = openSliceCopy();
    const a = begin(env);
    const v1 = JSON.parse(one<{ values_json: string }>("SELECT values_json FROM settings_revisions WHERE revision = 1").values_json);
    env.db.prepare("INSERT INTO settings_revisions(id, revision, values_json, created_at) VALUES (?,?,?,?)").run(randomUUID(), 3, JSON.stringify({ ...v1, taskCount: 10, weakRatio: 0.5 }), "now");
    expect(getSnapshot(env.db, a.sessionId).taskCount).toBe(18);
    finishSession(env.db, env.deps, a.sessionId, "ended_early");
    const b = begin(env, "ten");
    expect(b.snapshot.taskCount).toBe(10);
    expect(JSON.parse(one<{ choices_json: string }>("SELECT choices_json FROM scheduling_decisions WHERE session_id = ?", b.sessionId).choices_json).stats).toMatchObject({ weakTarget: 5, weakActual: 5 });
    expect(one<{ revision: number }>("SELECT sr.revision FROM sessions s JOIN settings_revisions sr ON sr.id = s.settings_revision_id WHERE s.id = ?", b.sessionId).revision).toBe(3);
    expect(one<{ revision: number }>("SELECT sr.revision FROM sessions s JOIN settings_revisions sr ON sr.id = s.settings_revision_id WHERE s.id = ?", a.sessionId).revision).toBe(2);
  });
});
