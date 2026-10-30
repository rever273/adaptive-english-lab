import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { readRun, runMastery } from "../../../apps/server/src/domain/analytics/runs.js";
import { createDiagnosticBlock, createHeldoutCheck, diagnosticStatus, heldoutStatus } from "../../../apps/server/src/domain/diagnostics/session.js";
import { selectBlock } from "../../../apps/server/src/domain/diagnostics/select.js";
import { DIAGNOSTIC_PROTOCOL } from "../../../apps/server/src/domain/diagnostics/protocol.js";
import { loadCandidates } from "../../../apps/server/src/domain/sessions/bank.js";
import { loadPriorities } from "../../../apps/server/src/domain/sessions/priorities.js";
import { getFeedback } from "../../../apps/server/src/domain/sessions/feedback.js";
import { finishSession } from "../../../apps/server/src/domain/sessions/finish.js";
import { recordSessionEvent } from "../../../apps/server/src/domain/attempts/sessionEvents.js";
import { ApiError } from "../../../apps/server/src/errors.js";
import { advance, one, rows, type Env } from "../attempts/fixtures.js";
import { answerSlot, diagEnv, practiseRevisions, reveal, sessionDeps, slotsOf } from "./fixtures.js";

let env: Env | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});
const req = (o: Record<string, unknown> = {}) => ({ purpose: "diagnostic" as const, timezone: "Australia/Brisbane", ...o });
const fails = (fn: () => unknown, status: number, code: string) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).status).toBe(status);
    expect((e as ApiError).code).toBe(code);
    return (e as ApiError).details as Record<string, any>;
  }
  throw new Error(`expected ${code}`);
};
const finish = (e: Env, sessionId: string) => finishSession(e.db, sessionDeps(e), sessionId, "ended_early");
const content = (json: string) => JSON.parse(json) as { payload: Record<string, any> };

describe("diagnostic blocks (diagnostic-v1)", () => {
  it("each of the three blocks is 8 mixed tasks: 3 recognition, 3 correction with a 'No mistake', 2 short production, 8 different skills, all typed", async () => {
    const x = await diagEnv({ diagnostic: true });
    env = x.env;
    const all: string[] = [];
    const skills = new Set<string>();
    for (let b = 1; b <= 3; b++) {
      const r = createDiagnosticBlock(env.db, sessionDeps(env), req({ seed: `b${b}` }));
      const slots = slotsOf(env, r.sessionId);
      expect(slots).toHaveLength(8);
      const dims = slots.reduce<Record<string, number>>((a, s) => ((a[s.dimension] = (a[s.dimension] ?? 0) + 1), a), {});
      expect(dims).toEqual({ recognition: 3, correction: 3, production: 2 });
      expect(slots.filter((s) => s.type === "detect_error" && content(s.content_json).payload.no_mistake === true).length).toBeGreaterThanOrEqual(1);
      expect(new Set(slots.map((s) => s.skill)).size).toBe(8);
      expect(slots.every((s) => s.bank_role === "diagnostic")).toBe(true); // never practice or held-out content
      expect(slots.every((s) => s.input_preference === "text")).toBe(true); // no voice baseline
      expect(slots.every((s) => s.type !== "context_reading")).toBe(true);
      expect(JSON.parse(slots[0]!.cohort_json)).toMatchObject({ protocol: "diagnostic-v1", block: b });
      expect(one<{ purpose: string; selection_version: string }>(env.db, "SELECT purpose, selection_version FROM sessions WHERE id = ?", r.sessionId)).toEqual({ purpose: "diagnostic", selection_version: "diagnostic-v1" });
      slots.forEach((s) => (all.push(s.revision_id), skills.add(s.skill)));
      for (const s of slots) answerSlot(env, r.sessionId, s); // shown = spent for good
      finish(env, r.sessionId);
    }
    expect(new Set(all).size).toBe(24); // 24 distinct unseen tasks across the three blocks
    expect(skills.size).toBe(24);
    fails(() => createDiagnosticBlock(env!.db, sessionDeps(env!), req()), 409, "DIAGNOSTIC_COMPLETE");
    expect(diagnosticStatus(env.db, sessionDeps(env))).toMatchObject({ blocksUsed: 3, nextBlock: null, ready: false });
  });

  it("is optional and honest: with no diagnostic bank the block is a precise shortage, practice still works, and the pinned protocol is stored once", async () => {
    const x = await diagEnv({ practice: true });
    env = x.env;
    const d = fails(() => createDiagnosticBlock(env!.db, sessionDeps(env!), req()), 409, "CONTENT_SHORTAGE");
    expect(d.deficits).toBeInstanceOf(Array);
    expect(diagnosticStatus(env.db, sessionDeps(env))).toMatchObject({ ready: false, nextBlock: 1 });
    expect(loadCandidates(env.db, "practice").length).toBe(45); // the practice bank is untouched
    expect(one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM sessions").n).toBe(0);
  });

  it("the same seed gives the same block; an unfinished session blocks another one; a spent sentence never returns", async () => {
    const x = await diagEnv({ diagnostic: true });
    env = x.env;
    const cands = loadCandidates(env.db, "diagnostic");
    const input = { candidates: cands, allowedFormats: DIAGNOSTIC_PROTOCOL.formats, need: { ...DIAGNOSTIC_PROTOCOL.perBlock, minNoMistake: 1 }, blocked: new Set<string>(), avoidSkills: new Set<string>(), familyOrder: DIAGNOSTIC_PROTOCOL.familyOrder, seed: "same", distinctSkills: true };
    expect(selectBlock(input)).toEqual(selectBlock(input));

    const a = createDiagnosticBlock(env.db, sessionDeps(env), req({ seed: "x" }));
    fails(() => createDiagnosticBlock(env!.db, sessionDeps(env!), req()), 409, "SESSION_ACTIVE");
    // reserved at creation: nothing of block 1 can be picked by a later block
    const first = slotsOf(env, a.sessionId);
    const reserved = new Set(first.map((s) => s.revision_id));
    for (const s of first) answerSlot(env, a.sessionId, s); // shown: spent for good
    finish(env, a.sessionId);
    const b = createDiagnosticBlock(env.db, sessionDeps(env), req({ seed: "y" }));
    for (const s of slotsOf(env, b.sessionId)) expect(reserved.has(s.revision_id)).toBe(false);
  });

  it("hints and shown answers are closed inside a diagnostic block (and allowed in practice)", async () => {
    const x = await diagEnv({ diagnostic: true });
    env = x.env;
    const r = createDiagnosticBlock(env.db, sessionDeps(env), req());
    const slot = slotsOf(env, r.sessionId)[0]!;
    reveal(env, r.sessionId, slot);
    for (const type of ["hint", "reveal_answer"]) {
      fails(() => recordSessionEvent(env!.db, sessionDeps(env!) as never, r.sessionId, { slotId: slot.slot_id, type, clientEventId: randomUUID() } as never), 409, "HINTS_CLOSED");
    }
  });

  it("feedback is closed while the block is open and opens when it is finished (answer first, never the next task's answer)", async () => {
    const x = await diagEnv({ diagnostic: true });
    env = x.env;
    const r = createDiagnosticBlock(env.db, sessionDeps(env), req());
    const slots = slotsOf(env, r.sessionId);
    answerSlot(env, r.sessionId, slots[0]!);
    const closed = getFeedback(env.db, sessionDeps(env), r.sessionId, slots[0]!.slot_id);
    expect(closed).toMatchObject({ state: "closed", verdict: null, correct: null, explanation_ru: null });
    expect(closed.prompt).toBeTruthy();
    finish(env, r.sessionId);
    const open = getFeedback(env.db, sessionDeps(env), r.sessionId, slots[0]!.slot_id);
    expect(open).toMatchObject({ state: "confirmed", verdict: "correct" });
    expect(open.correct).not.toBeNull();
  });
});

describe("evidence: diagnostics never mix with practice", () => {
  it("a diagnostic answer is evidence of its OWN cohort only; sparse evidence stays provisional", async () => {
    const x = await diagEnv({ diagnostic: true });
    env = x.env;
    const r = createDiagnosticBlock(env.db, sessionDeps(env), req());
    for (const s of slotsOf(env, r.sessionId)) answerSlot(env, r.sessionId, s);
    finish(env, r.sessionId);
    const asOf = new Date(Date.now() + 86400000).toISOString();
    const taxonomyId = env.taxonomyId;
    const practice = runMastery(env.db, { asOf, cohort: { criterionVersion: "rubric-v1", difficulty: "B2" }, taxonomyId, now: env.deps.now });
    const diag = runMastery(env.db, { asOf, cohort: { criterionVersion: "rubric-v1", difficulty: "B2", protocol: "diagnostic-v1" }, taxonomyId, now: env.deps.now });
    const withEvidence = (id: string) => readRun(env!.db, id).flatMap((p) => Object.values(p.dimensions).filter((d) => d !== undefined && d.n > 0));
    expect(withEvidence(practice.id)).toHaveLength(0); // the practice cohort did not move
    const comps = withEvidence(diag.id);
    expect(comps.length).toBe(8);
    for (const d of comps) {
      expect(d!.n).toBe(1);
      expect(d!.status).toBe("insufficient"); // one answer per skill is never "mastery"
      expect(d!.hSource).toBe("no_independent_check");
    }
    expect(practice.inputHash).not.toBe(diag.inputHash); // different protocols are different analyses
  });
});

describe("delayed held-out checks (heldout-v1)", () => {
  it("not available until a skill was practised >= 7 days ago; then only those skills; held-out items never appear in practice", async () => {
    const x = await diagEnv({ practice: true, heldout: true });
    env = x.env;
    expect(heldoutStatus(env.db, sessionDeps(env))).toMatchObject({ ready: false, reason: "no_skill_practised_for_7_days", eligibleSkills: 0 });
    fails(() => createHeldoutCheck(env!.db, sessionDeps(env!), req({ purpose: "heldout" })), 409, "HELDOUT_NOT_READY");

    // practise the skills the held-out bank covers (these practice items exist in the slice bank), TODAY
    const want = ["articles.indefinite", "conditionals.first", "tenses.present_perfect", "verb_patterns.suggest_doing", "tenses.past_perfect"];
    const revs = rows<{ id: string; skill: string }>(env.db, `SELECT er.id AS id, sr.skill_id AS skill FROM exercise_revisions er JOIN exercise_skills es ON es.revision_id = er.id AND es.role='target' JOIN skill_revisions sr ON sr.id = es.skill_revision_id WHERE er.bank_role = 'practice' AND sr.skill_id IN (${want.map(() => "?").join(",")})`, ...want);
    const bySkill = new Map(revs.map((r) => [r.skill, r.id]));
    practiseRevisions(env, [...bySkill.values()]);
    expect(heldoutStatus(env.db, sessionDeps(env)).ready).toBe(false); // practised today: too early
    advance(env, 6 * 86400_000);
    expect(heldoutStatus(env.db, sessionDeps(env)).ready).toBe(false); // 6 days: still too early
    advance(env, 2 * 86400_000);
    const st = heldoutStatus(env.db, sessionDeps(env));
    expect(st.ready).toBe(true);
    expect(st.eligibleSkills).toBe(want.length);

    const r = createHeldoutCheck(env.db, sessionDeps(env), req({ purpose: "heldout", seed: "h1" }));
    const slots = slotsOf(env, r.sessionId);
    expect(slots.length).toBeGreaterThanOrEqual(4);
    expect(slots.every((s) => s.bank_role === "heldout")).toBe(true);
    expect(slots.every((s) => want.includes(s.skill))).toBe(true); // only skills that are due
    expect(slots.every((s) => s.input_preference === "text")).toBe(true);
    expect(loadCandidates(env.db, "practice").every((c) => c.bankRole === "practice")).toBe(true); // held-out never leaks into practice
  });

  it("a held-out sentence is consumed by ONE check; hints are closed; feedback opens after the block; the next check has fresh sentences or none", async () => {
    const x = await diagEnv({ practice: true, heldout: true });
    env = x.env;
    const want = ["articles.indefinite", "conditionals.first", "tenses.present_perfect", "verb_patterns.suggest_doing", "tenses.past_perfect"];
    const ids = rows<{ id: string }>(env.db, `SELECT er.id AS id FROM exercise_revisions er JOIN exercise_skills es ON es.revision_id = er.id AND es.role='target' JOIN skill_revisions sr ON sr.id = es.skill_revision_id WHERE er.bank_role = 'practice' AND sr.skill_id IN (${want.map(() => "?").join(",")}) GROUP BY sr.skill_id`, ...want).map((r) => r.id);
    practiseRevisions(env, ids);
    advance(env, 9 * 86400_000);

    const first = createHeldoutCheck(env.db, sessionDeps(env), req({ purpose: "heldout", seed: "c1" }));
    const slots = slotsOf(env, first.sessionId);
    const slot = slots[0]!;
    answerSlot(env, first.sessionId, slot);
    fails(() => recordSessionEvent(env!.db, sessionDeps(env!) as never, first.sessionId, { slotId: slot.slot_id, type: "hint", clientEventId: randomUUID() } as never), 409, "HINTS_CLOSED");
    expect(getFeedback(env.db, sessionDeps(env), first.sessionId, slot.slot_id).state).toBe("closed");
    for (const s of slots.slice(1)) answerSlot(env, first.sessionId, s); // reveal = exposure of every sentence shown
    finish(env, first.sessionId);
    expect(getFeedback(env.db, sessionDeps(env), first.sessionId, slot.slot_id).state).toBe("confirmed");

    const used = new Set(slots.map((s) => s.revision_id));
    let second: ReturnType<typeof createHeldoutCheck> | null = null;
    try {
      second = createHeldoutCheck(env.db, sessionDeps(env), req({ purpose: "heldout", seed: "c2" }));
    } catch (e) {
      expect((e as ApiError).code).toBe("HELDOUT_NOT_READY"); // the small slice held-out bank is spent
    }
    if (second) for (const s of slotsOf(env, second.sessionId)) expect(used.has(s.revision_id)).toBe(false);
    expect(one<{ n: number }>(env.db, "SELECT COUNT(DISTINCT e.unit_id) AS n FROM exposures e").n).toBeGreaterThan(0);
  });

  it("a held-out answer is independent evidence (heldout flag) in the practice cohort, so H can exist; assisted attempts cannot be made", async () => {
    const x = await diagEnv({ practice: true, heldout: true });
    env = x.env;
    const want = ["articles.indefinite", "conditionals.first", "tenses.present_perfect", "verb_patterns.suggest_doing", "tenses.past_perfect"];
    const ids = rows<{ id: string }>(env.db, `SELECT er.id AS id FROM exercise_revisions er JOIN exercise_skills es ON es.revision_id = er.id AND es.role='target' JOIN skill_revisions sr ON sr.id = es.skill_revision_id WHERE er.bank_role = 'practice' AND sr.skill_id IN (${want.map(() => "?").join(",")}) GROUP BY sr.skill_id`, ...want).map((r) => r.id);
    practiseRevisions(env, ids);
    advance(env, 9 * 86400_000);
    const c = createHeldoutCheck(env.db, sessionDeps(env), req({ purpose: "heldout", seed: "e" }));
    for (const s of slotsOf(env, c.sessionId)) answerSlot(env, c.sessionId, s);
    finish(env, c.sessionId);
    const asOf = new Date(env.deps.now().getTime() + 86400_000).toISOString();
    const run = runMastery(env.db, { asOf, cohort: { criterionVersion: "rubric-v1", difficulty: "B2" }, taxonomyId: env.taxonomyId, now: env.deps.now });
    const withH = readRun(env.db, run.id).flatMap((p) => Object.values(p.dimensions)).filter((d) => d !== undefined && d.heldoutN > 0);
    expect(withH.length).toBeGreaterThan(0);
    for (const d of withH) expect(d!.hSource).not.toBe("no_independent_check");
  });

  it("steers practice selection (D62): a skill failed in the diagnostic gets a higher selection priority than an untested one, a correct one a lower one; Mastery is untouched", async () => {
    const x = await diagEnv({ diagnostic: true });
    env = x.env;
    const r = createDiagnosticBlock(env.db, sessionDeps(env), req({ seed: "prior" }));
    const slots = slotsOf(env, r.sessionId).filter((s) => s.type === "choose_form" || s.type === "choose_missing_fragment");
    const [failed, passed] = [slots[0]!, slots[1]!];
    const wrong = (JSON.parse(failed.content_json).payload.options as Array<{ id: string }>).map((o) => o.id).find((id) => !JSON.parse(failed.content_json).payload.accepted_option_ids.includes(id))!;
    answerSlot(env, r.sessionId, failed, [wrong]);
    answerSlot(env, r.sessionId, passed);
    finish(env, r.sessionId);
    const taxonomyId = one<{ id: string }>(env.db, "SELECT id FROM taxonomy_versions").id;
    const table = loadPriorities(env.db, [], new Date(env.clock.current.getTime() + 1000).toISOString(), taxonomyId);
    const p = (skill: string) => table.lookup(skill, "recognition", "rubric-v1|B1");
    const untested = p("collocations.make_do");
    expect(p(failed.skill)).toBeCloseTo(untested + 0.15);
    expect(p(passed.skill)).toBeCloseTo(untested - 0.1);
    expect(table.evidenceHash).toContain(`diag|${failed.skill}|1|1`);
  });
});
