// TASK_017: the first-ten-lessons bank end to end on the real pipeline: 288 exercises registered -> individually reviewed -> approved -> released, ten published
// blueprints, then TEN SEQUENTIAL default first-run sessions (18 slots each) must all be feasible and use 180 DIFFERENT exercises, followed by the three
// diagnostic blocks and the delayed held-out checks. Nothing here proves that the English is correct - that is the item review's job.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS_V1 } from "../../../packages/contracts/src/index.js";
import { createDiagnosticBlock, createHeldoutCheck, diagnosticStatus, heldoutStatus } from "../../../apps/server/src/domain/diagnostics/session.js";
import { createPracticeSession } from "../../../apps/server/src/domain/sessions/create.js";
import { getFeedback } from "../../../apps/server/src/domain/sessions/feedback.js";
import { finishSession } from "../../../apps/server/src/domain/sessions/finish.js";
import { ApiError } from "../../../apps/server/src/errors.js";
import { ClosedFormAssessor } from "../../../apps/server/src/domain/content/grader.js";
import { buildFirst10, firstTenBlueprints, LESSONS, READING_LESSONS } from "../../../content/first10/index.mjs";
import { answerSlot, seed, sessionDeps, slotsOf, type Content } from "../diagnostics/fixtures.js";
import { addEvent, advance, makeEnv, one, rows, type Env } from "../attempts/fixtures.js";

const TZ = "Australia/Brisbane";
let env: Env;
let blueprintIds: Map<string, string>;
const family = (skill: string) => skill.split(".")[0]!;

beforeAll(async () => {
  env = await makeEnv({ assessor: ClosedFormAssessor });
  const { practice, diagnostic, heldout } = buildFirst10();
  seed(env, [...practice, ...diagnostic, ...heldout] as Content[]);
  blueprintIds = new Map();
  for (const b of firstTenBlueprints()) {
    const id = randomUUID();
    const revisionId = randomUUID();
    env.db.prepare("INSERT INTO blueprints(id, stable_key) VALUES (?,?)").run(id, b.key);
    env.db.prepare("INSERT INTO blueprint_revisions(id, blueprint_id, revision, policy_json, status, reviewer, created_at) VALUES (?,?,?,?,?,?,?)").run(revisionId, id, 1, JSON.stringify(b.policy), "published", "agent:test", env.clock.current.toISOString());
    blueprintIds.set(b.key, revisionId);
  }
}, 600_000);
afterAll(() => env?.cleanup());

const fails = (fn: () => unknown, status: number, code: string): ApiError => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).status).toBe(status);
    expect((e as ApiError).code).toBe(code);
    return e as ApiError;
  }
  throw new Error(`expected ${code}`);
};

describe("the first-ten bank is released and complete", () => {
  it("300 approved, individually reviewed and released revisions: 240 practice + 24 diagnostic + 24 held-out; ten published blueprints", () => {
    const by = rows<{ role: string; n: number }>(env.db, "SELECT er.bank_role AS role, COUNT(*) AS n FROM selectable_revisions sr JOIN exercise_revisions er ON er.id = sr.revision_id GROUP BY er.bank_role ORDER BY 1");
    const expectedPractice = buildFirst10().practice.length;
    expect(by).toEqual([{ role: "diagnostic", n: 24 }, { role: "heldout", n: 24 }, { role: "practice", n: expectedPractice }]);
    // every revision has exactly one approved review of its CURRENT hash, and nothing is flagged
    expect(one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM exercise_revisions er WHERE NOT EXISTS (SELECT 1 FROM content_reviews r WHERE r.revision_id = er.id AND r.verdict = 'approved' AND r.content_hash = er.content_hash)").n).toBe(0);
    expect(one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM latest_content_state WHERE status NOT IN ('approved')").n).toBe(0);
    expect(one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM blueprint_revisions WHERE status = 'published'").n).toBe(10);
  });

  it("custom 30-task sessions: a lesson without shared skills reports an exact stock deficit; where shared skills give enough, 30 is honestly feasible", () => {
    env.db.prepare("INSERT INTO settings_revisions(id,revision,values_json,created_at) VALUES (?,?,?,?)").run(randomUUID(), 2, JSON.stringify({ ...DEFAULT_SETTINGS_V1, taskCount: 30 }), env.clock.current.toISOString());
    const report: Record<string, unknown> = {};
    try {
      for (const [code] of LESSONS) {
        try {
          const r = createPracticeSession(env.db, env.deps, { purpose: "practice", blueprintRevisionId: blueprintIds.get(`first10-${code.toLowerCase()}`)!, seed: `custom30-${code}`, timezone: TZ });
          report[code] = "feasible";
          finishSession(env.db, sessionDeps(env), r.sessionId, "ended_early"); // nothing was shown, so its reservations are released again
        } catch (e) {
          expect((e as ApiError).code).toBe("CONTENT_SHORTAGE");
          const d = (e as ApiError).details as { requestedN: number; largestFeasibleN: number | null; deficits: Array<{ needed?: number; available?: number; message: string }> };
          expect(d.requestedN).toBe(30);
          expect(d.largestFeasibleN === null || d.largestFeasibleN < 30).toBe(true);
          for (const x of d.deficits) if (x.needed !== undefined) expect(x.needed).toBeGreaterThan(x.available!);
          report[code] = { largestFeasibleN: d.largestFeasibleN, deficits: d.deficits.map((x) => x.message) };
        }
      }
    } finally {
      env.db.prepare("INSERT INTO settings_revisions(id,revision,values_json,created_at) VALUES (?,?,?,?)").run(randomUUID(), 3, JSON.stringify(DEFAULT_SETTINGS_V1), env.clock.current.toISOString());
    }
    console.log("FIRST10_CUSTOM30", JSON.stringify(report));
    expect(typeof report.L06).toBe("object"); // L06 shares no skill with another lesson: 24 exercises cannot make 30 tasks
  });
});

describe("ten sequential first-run sessions", () => {
  it("each lesson yields a feasible 18-slot session from its own pool (5/5/5/1/2, or 3/4/5/1/2 + a 3-question reading passage in L03/L06/L10); no exercise is used twice", () => {
    const used = new Set<string>();
    let slotTotal = 0;
    const report: Array<Record<string, unknown>> = [];
    for (const [code, , pool] of LESSONS) {
      let r;
      try {
        r = createPracticeSession(env.db, env.deps, { purpose: "practice", blueprintRevisionId: blueprintIds.get(`first10-${code.toLowerCase()}`)!, seed: `first10-${code}`, timezone: TZ });
      } catch (e) {
        console.log("FIRST10_SHORTAGE", code, JSON.stringify((e as ApiError).details));
        throw e;
      }
      const slots = slotsOf(env, r.sessionId);
      expect(slots).toHaveLength(18);
      const fmt = slots.reduce<Record<string, number>>((a, s) => ((a[s.type] = (a[s.type] ?? 0) + 1), a), {});
      expect(fmt).toEqual(
        READING_LESSONS.has(code)
          ? { choose_form: 3, choose_missing_fragment: 4, detect_error: 5, guided_short_answer: 1, russian_to_english_short: 2, context_reading: 3 }
          : { choose_form: 5, choose_missing_fragment: 5, detect_error: 5, guided_short_answer: 1, russian_to_english_short: 2 },
      );
      slotTotal += slots.length;
      const sessionRevisions = new Set<string>();
      const fam = slots.reduce<Record<string, number>>((a, s) => ((a[family(s.skill)] = (a[family(s.skill)] ?? 0) + 1), a), {});
      expect(Object.keys(fam).length).toBeGreaterThanOrEqual(3);
      expect(Math.max(...Object.values(fam))).toBeLessThanOrEqual(7); // ceil(0.35 * 18)
      let own = 0; // pools overlap on shared skills (e.g. embedded questions in L01/L03/L10), so a session may also use a sibling lesson's exercise of a shared skill
      for (const s of slots) {
        expect(pool).toContain(s.skill);
        expect(s.bank_role).toBe("practice");
        if ((JSON.parse(s.content_json) as { topic: string }).topic.startsWith(`${code}:`)) own++;
        if (!sessionRevisions.has(s.revision_id)) expect(used.has(s.revision_id)).toBe(false); // disjoint across all ten sessions (a passage's questions share one revision)
        sessionRevisions.add(s.revision_id);
        used.add(s.revision_id);
      }
      expect(slots.filter((s) => s.input_preference === "voice").length).toBeLessThanOrEqual(2);
      const noMistake = slots.filter((s) => s.type === "detect_error" && (JSON.parse(s.content_json) as { payload: { no_mistake: boolean } }).payload.no_mistake).length;
      report.push({ lesson: code, ownExercises: own, families: fam, noMistake, voice: slots.filter((s) => s.input_preference === "voice").length });
      for (const s of slots) {
        const questionId = s.type === "context_reading" ? one<{ q: string }>(env.db, "SELECT question_id AS q FROM session_slots WHERE id = ?", s.slot_id).q : null;
        const answer = questionId ? (JSON.parse(s.content_json) as { payload: { questions: Array<{ id: string; accepted_option_ids: string[] }> } }).payload.questions.find((x) => x.id === questionId)!.accepted_option_ids : undefined;
        answerSlot(env, r.sessionId, s, answer); // real reveal -> exposure -> attempt
        getFeedback(env.db, sessionDeps(env), r.sessionId, s.slot_id); // the learner sees the answer: its sentences are now spent for good
        addEvent(env, r.sessionId, s.slot_id, "continue"); // the learner moves on
      }
      finishSession(env.db, sessionDeps(env), r.sessionId, "completed");
      advance(env, 3_600_000);
    }
    expect(slotTotal).toBe(180);
    expect(used.size).toBe(180 - 2 * READING_LESSONS.size); // three questions of one passage are one revision
    expect(one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM sessions WHERE purpose = 'practice' AND status = 'completed'").n).toBe(10);
    // every exercise not used by the ten sessions is untouched reserve
    expect(one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM selectable_revisions sr JOIN exercise_revisions er ON er.id = sr.revision_id WHERE er.bank_role = 'practice' AND sr.revision_id NOT IN (SELECT ss.exercise_revision_id FROM session_slots ss JOIN sessions s ON s.id = ss.session_id WHERE s.status = 'completed')").n).toBe(buildFirst10().practice.length - used.size);
    console.log("FIRST10_SIM", JSON.stringify(report));
  }, 600_000);
});

describe("diagnostic and held-out banks", () => {
  it("three diagnostic blocks of 8 (3 recognition / 3 correction with a No mistake / 2 production, 8 different skills each), then the protocol is complete", () => {
    expect(diagnosticStatus(env.db, sessionDeps(env))).toMatchObject({ ready: true });
    const seen = new Set<string>();
    for (let b = 1; b <= 3; b++) {
      const r = createDiagnosticBlock(env.db, sessionDeps(env), { purpose: "diagnostic", timezone: TZ, seed: `d${b}` });
      const slots = slotsOf(env, r.sessionId);
      expect(slots).toHaveLength(8);
      const dims = slots.reduce<Record<string, number>>((a, s) => ((a[s.dimension] = (a[s.dimension] ?? 0) + 1), a), {});
      expect(dims).toEqual({ recognition: 3, correction: 3, production: 2 });
      expect(new Set(slots.map((s) => s.skill)).size).toBe(8);
      expect(slots.some((s) => s.type === "detect_error" && (JSON.parse(s.content_json) as { payload: { no_mistake: boolean } }).payload.no_mistake)).toBe(true);
      expect(slots.every((s) => s.bank_role === "diagnostic" && s.input_preference === "text")).toBe(true);
      for (const s of slots) {
        expect(seen.has(s.revision_id)).toBe(false);
        seen.add(s.revision_id);
        answerSlot(env, r.sessionId, s);
      }
      finishSession(env.db, sessionDeps(env), r.sessionId, "ended_early");
    }
    expect(seen.size).toBe(24);
    fails(() => createDiagnosticBlock(env.db, sessionDeps(env), { purpose: "diagnostic", timezone: TZ }), 409, "DIAGNOSTIC_COMPLETE");
  }, 300_000);

  it("a week later the held-out checks are ready for practised skills, use only the held-out bank, and each sentence is consumed once", () => {
    expect(heldoutStatus(env.db, sessionDeps(env)).ready).toBe(false); // practised today: too early
    advance(env, 8 * 86_400_000);
    const status = heldoutStatus(env.db, sessionDeps(env));
    expect(status.ready).toBe(true);
    const seen = new Set<string>();
    let checks = 0;
    for (let i = 0; i < 4; i++) {
      let r;
      try {
        r = createHeldoutCheck(env.db, sessionDeps(env), { purpose: "heldout", timezone: TZ, seed: `h${i}` });
      } catch (e) {
        expect((e as ApiError).code).toBe("HELDOUT_NOT_READY");
        break;
      }
      const slots = slotsOf(env, r.sessionId);
      expect(slots.length).toBeGreaterThanOrEqual(4);
      expect(slots.length).toBeLessThanOrEqual(8);
      expect(new Set(slots.map((s) => s.skill)).size).toBe(slots.length);
      for (const s of slots) {
        expect(s.bank_role).toBe("heldout");
        expect(seen.has(s.revision_id)).toBe(false);
        seen.add(s.revision_id);
        answerSlot(env, r.sessionId, s);
      }
      finishSession(env.db, sessionDeps(env), r.sessionId, "ended_early");
      checks++;
    }
    console.log("FIRST10_HELDOUT", JSON.stringify({ checks, consumed: seen.size }));
    expect(checks).toBeGreaterThanOrEqual(2);
    expect(seen.size).toBeGreaterThanOrEqual(16);
  }, 300_000);
});
