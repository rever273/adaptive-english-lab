import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DISCOVERY_V1, type DiscoveryConfig } from "../../../packages/learning/src/index.js";
import { REVIEW_CHECKLIST_KEYS, type ReviewChecklist } from "../../../packages/contracts/src/index.js";
import { runMastery } from "../../../apps/server/src/domain/analytics/runs.js";
import { disputeAssessment } from "../../../apps/server/src/domain/attempts/assessments.js";
import { recordAttempt } from "../../../apps/server/src/domain/attempts/attempts.js";
import { reviewFinding } from "../../../apps/server/src/domain/attempts/findings.js";
import type { Assessor, AttemptDeps } from "../../../apps/server/src/domain/attempts/ports.js";
import { recordSessionEvent } from "../../../apps/server/src/domain/attempts/sessionEvents.js";
import { upsertModelVersion } from "../../../apps/server/src/domain/attempts/transcripts.js";
import { approveRevision, publishRelease, registerRevision, submitForReview, submitReview } from "../../../apps/server/src/domain/content/repository.js";
import { createPracticeSession } from "../../../apps/server/src/domain/sessions/create.js";
import { getFeedback } from "../../../apps/server/src/domain/sessions/feedback.js";
import { finishSession } from "../../../apps/server/src/domain/sessions/finish.js";
import { takeLease } from "../../../apps/server/src/domain/sessions/lease.js";
import { revealSlot } from "../../../apps/server/src/domain/sessions/reveal.js";
import { getSnapshot } from "../../../apps/server/src/domain/sessions/snapshot.js";
import { openDatabase } from "../../../apps/server/src/db/open.js";
import { uniq, fixture, type Exercise } from "../../fixtures/exercises/load.js";
import { buildSliceTemplate, disposeSliceTemplate, openSliceCopy, type SliceEnv } from "./slice-fixture.js";

let env: SliceEnv;
beforeAll(() => {
  buildSliceTemplate();
}, 180_000);
afterAll(() => disposeSliceTemplate());
afterEach(() => env?.cleanup());

const TAB = "tab-1";
const rows = <T = Record<string, unknown>>(sql: string, ...p: unknown[]) => env.db.prepare(sql).all(...p) as T[];
const one = <T = Record<string, unknown>>(sql: string, ...p: unknown[]) => env.db.prepare(sql).get(...p) as T;
const count = (t: string) => one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`).n;
const COHORT = { criterionVersion: "rubric-v1", difficulty: "B2" as const };
const ALL_TRUE = Object.fromEntries(REVIEW_CHECKLIST_KEYS.map((k) => [k, true])) as ReviewChecklist;
const AGENT = { type: "agent" as const, id: "reviewer@1" };

/** Registers, reviews, approves and releases one exercise: the same path real content takes. */
function addApproved(content: Exercise): string {
  const deps = { now: env.deps.now, newId: randomUUID };
  const r = registerRevision(env.db, deps, { content, actor: { type: "agent", id: "author" } });
  submitForReview(env.db, deps, r.revisionId, AGENT);
  submitReview(env.db, deps, { revisionId: r.revisionId, reviewer: "agent:reviewer@1", reviewVersion: "v1", contentHash: r.contentHash, checklist: ALL_TRUE, verdict: "approved" });
  approveRevision(env.db, deps, { revisionId: r.revisionId, actor: AGENT });
  publishRelease(env.db, deps, { revisionIds: [r.revisionId], reviewer: "agent:reviewer@1" });
  return r.revisionId;
}

// ---------------------------------------------------------------------------------------------------------------------
describe("held-out stays out of practice", () => {
  it("a released held-out revision is never selected for a practice snapshot", () => {
    env = openSliceCopy();
    const heldout = fixture("choose_form");
    heldout.bank_role = "heldout";
    const heldoutRevision = addApproved(heldout);
    expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM selectable_revisions WHERE revision_id = ?", heldoutRevision).n).toBe(1);
    for (const seed of ["h1", "h2", "h3", "h4"]) {
      const s = createPracticeSession(env.db, env.deps, { purpose: "practice", blueprintRevisionId: env.blueprintRevisionId, seed, timezone: "Australia/Brisbane" });
      expect(rows("SELECT 1 FROM session_slots WHERE session_id = ? AND exercise_revision_id = ?", s.sessionId, heldoutRevision)).toEqual([]);
      expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM session_slots ss JOIN exercise_revisions er ON er.id = ss.exercise_revision_id WHERE ss.session_id = ? AND er.bank_role <> 'practice'", s.sessionId).n).toBe(0);
      finishSession(env.db, env.deps, s.sessionId, "ended_early");
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("reading passage: one atomic group of 2-3 child slots", () => {
  /** three reading exercises whose every sentence (also the options) is unique */
  const readingVariants = (): Exercise[] =>
    ["Alpha", "Beta", "Gamma"].map((tag) => {
      const c = uniq("context_reading", tag);
      c.payload.paragraphs = c.payload.paragraphs.map((p: string) => p.replace(/\. /g, `. ${tag} `)); // every sentence unique, not only the first
      for (const q of c.payload.questions) for (const o of q.options) o.text = `${tag} ${o.text}`;
      return c;
    });

  function readingEnv(): { blueprintId: string } {
    env = openSliceCopy();
    for (const v of readingVariants()) addApproved(v);
    const bp = randomUUID();
    const bpr = randomUUID();
    env.db.prepare("INSERT INTO blueprints(id, stable_key) VALUES (?,?)").run(bp, "reading-lesson");
    env.db
      .prepare("INSERT INTO blueprint_revisions(id, blueprint_id, revision, policy_json, status, reviewer, created_at) VALUES (?,?,?,?,?,?,?)")
      .run(bpr, bp, 1, JSON.stringify({ schema_version: "blueprint-policy-v1", title: "Reading lesson", readingBlocks: 1 }), "published", "agent:reviewer@1", "now");
    return { blueprintId: bpr };
  }

  it("a 3-question passage replaces choose_form 2 + fragment 1: 3/4/5/1/2/3 = 18, contiguous, one group", () => {
    const { blueprintId } = readingEnv();
    const { sessionId, snapshot } = createPracticeSession(env.db, env.deps, { purpose: "practice", blueprintRevisionId: blueprintId, seed: "reading", timezone: "Australia/Brisbane" });
    const by = (f: string) => snapshot.slots.filter((s) => s.format === f).length;
    expect([by("choose_form"), by("choose_missing_fragment"), by("detect_error"), by("guided_short_answer"), by("russian_to_english_short"), by("context_reading")]).toEqual([3, 4, 5, 1, 2, 3]);
    expect(snapshot.taskCount).toBe(18); // reading child questions count inside N (D15)
    const children = snapshot.slots.filter((s) => s.format === "context_reading");
    expect(new Set(children.map((c) => c.readingGroupId)).size).toBe(1);
    expect(children.map((c) => c.questionId)).toEqual(["q1", "q2", "q3"]);
    const first = snapshot.slots.findIndex((s) => s.format === "context_reading");
    expect(snapshot.slots.slice(first, first + 3).every((s) => s.format === "context_reading")).toBe(true);
    // the passage units are reserved ONCE (by the first child), each child slot points at the same revision
    const rev = rows<{ r: string }>("SELECT DISTINCT exercise_revision_id AS r FROM session_slots WHERE session_id = ? AND reading_group_id IS NOT NULL", sessionId);
    expect(rev).toHaveLength(1);
    expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM prompt_reservations WHERE slot_id = ?", children[0]!.slotId).n).toBeGreaterThan(0);
    expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM prompt_reservations WHERE slot_id IN (?, ?)", children[1]!.slotId, children[2]!.slotId).n).toBe(0);
  });

  it("revealing any child reveals the whole group atomically; the passage is exposed once; each child is graded on its own question", () => {
    const { blueprintId } = readingEnv();
    const { sessionId, snapshot } = createPracticeSession(env.db, env.deps, { purpose: "practice", blueprintRevisionId: blueprintId, seed: "reading", timezone: "Australia/Brisbane" });
    takeLease(env.db, env.deps, sessionId, TAB);
    const children = snapshot.slots.filter((s) => s.format === "context_reading");
    const r2 = revealSlot(env.db, env.deps, sessionId, children[1]!.slotId, TAB); // the MIDDLE child first
    expect(r2.prompt).toMatchObject({ kind: "reading", question: { id: "q2" } });
    expect(rows("SELECT slot_id FROM session_events WHERE event_type = 'reveal' AND slot_id IN (?,?,?)", children[0]!.slotId, children[1]!.slotId, children[2]!.slotId)).toHaveLength(3);
    const passageExposed = one<{ n: number }>("SELECT COUNT(DISTINCT e.unit_id) AS n FROM exposures e JOIN revision_prompt_units rpu ON rpu.unit_id = e.unit_id AND rpu.role = 'passage'").n;
    expect(passageExposed).toBe(4); // 2 sentences in each of 2 paragraphs, exposed exactly once
    const before = count("exposures");
    revealSlot(env.db, env.deps, sessionId, children[0]!.slotId, TAB);
    revealSlot(env.db, env.deps, sessionId, children[2]!.slotId, TAB);
    expect(count("exposures")).toBe(before); // the other children expose nothing new

    const correctFor = (questionId: string) => JSON.parse(one<{ c: string }>("SELECT er.content_json AS c FROM session_slots ss JOIN exercise_revisions er ON er.id = ss.exercise_revision_id WHERE ss.id = ?", children[0]!.slotId).c).payload.questions.find((q: any) => q.id === questionId).accepted_option_ids;
    expect(recordAttempt(env.db, env.deps, { slotId: children[0]!.slotId, submissionId: randomUUID(), answer: correctFor("q1"), inputMode: "text" }).body.assessment.verdict).toBe("correct");
    expect(recordAttempt(env.db, env.deps, { slotId: children[1]!.slotId, submissionId: randomUUID(), answer: ["zzz"], inputMode: "text" }).body.assessment.verdict).toBe("incorrect");
    // the opportunities carry the question's own target skill and evidence group
    expect(rows<{ s: string }>("SELECT sr.skill_id AS s FROM skill_opportunities o JOIN skill_revisions sr ON sr.id = o.skill_revision_id JOIN assessment_revisions a ON a.id = o.assessment_id JOIN attempts t ON t.id = a.attempt_id WHERE t.slot_id IN (?,?) ORDER BY t.attempt_no, t.slot_id", children[0]!.slotId, children[1]!.slotId).map((r) => r.s).sort()).toEqual(["linking.cause", "pronouns.subject_object"]);
  });

  it("without a passage in the bank the lesson is a disclosed shortage, not a silent drop", () => {
    env = openSliceCopy();
    const bpr = randomUUID();
    const bp = randomUUID();
    env.db.prepare("INSERT INTO blueprints(id, stable_key) VALUES (?,?)").run(bp, "needs-reading");
    env.db.prepare("INSERT INTO blueprint_revisions(id, blueprint_id, revision, policy_json, status, created_at) VALUES (?,?,?,?,?,?)").run(bpr, bp, 1, JSON.stringify({ schema_version: "blueprint-policy-v1", title: "Needs reading", readingBlocks: 1 }), "approved", "now");
    try {
      createPracticeSession(env.db, env.deps, { purpose: "practice", blueprintRevisionId: bpr, timezone: "Australia/Brisbane" });
      throw new Error("expected shortage");
    } catch (e) {
      expect((e as { code: string }).code).toBe("CONTENT_SHORTAGE");
      expect(JSON.stringify((e as { details: unknown }).details)).toContain("reading");
    }
    expect(count("sessions")).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("discovery-v1 in session allocation (qualified fixtures; runtime stays off before TASK_009)", () => {
  const MODEL_KEY = "qwen3:14b@sha256:fixture-digest";
  const qualified: DiscoveryConfig = { ...DISCOVERY_V1, qualifiedModels: [{ key: MODEL_KEY, qualificationId: "qual-fixture-1" }] };
  let suspect = "";

  /** Session A: one confirmed answer (real evidence) and two open answers analysed by the (fixture) qualified model. */
  function seedFindings(): { findingIds: string[]; assessmentIds: string[] } {
    env = openSliceCopy();
    const modelId = upsertModelVersion(env.db, randomUUID, { tag: "qwen3:14b", digest: "sha256:fixture-digest", runtime: "ollama", runtimeVersion: "0.40.12", parameters: {} });
    const a = createPracticeSession(env.db, env.deps, { purpose: "practice", blueprintRevisionId: env.blueprintRevisionId, seed: "findings", timezone: "Australia/Brisbane" });
    // revision ids are random per seeded profile, so pick the suspected skill from an R/C exercise that session A does NOT use:
    // it stays unseen and unreserved, hence available as a probe afterwards
    suspect = one<{ s: string }>(
      `SELECT sr.skill_id AS s FROM exercise_revisions er JOIN exercise_skills es ON es.revision_id = er.id AND es.role = 'target' JOIN skill_revisions sr ON sr.id = es.skill_revision_id
        WHERE er.bank_role = 'practice' AND er.type IN ('choose_form','choose_missing_fragment','detect_error') AND er.id NOT IN (SELECT exercise_revision_id FROM session_slots WHERE session_id = ?)
        ORDER BY sr.skill_id, er.id LIMIT 1`,
      a.sessionId,
    ).s;
    takeLease(env.db, env.deps, a.sessionId, TAB);
    const modelAssessor: Assessor = {
      assess: () => ({
        verdict: "pending",
        confirmation: "tentative",
        source: "model",
        rationale: "model analysis (tentative)",
        modelVersionId: modelId,
        findings: [{ skillId: suspect, explanationRu: "возможная ошибка", findingType: "grammar", verdict: "tentative", confidence: 0.9, modelVersionId: modelId }],
      }),
    };
    const modelDeps: AttemptDeps = { ...env.deps, assessor: modelAssessor };
    const prods = a.snapshot.slots.filter((s) => s.dimension === "production");
    const assessmentIds: string[] = [];
    for (const p of prods.slice(0, 2)) {
      revealSlot(env.db, env.deps, a.sessionId, p.slotId, TAB);
      assessmentIds.push(recordAttempt(env.db, modelDeps, { slotId: p.slotId, submissionId: randomUUID(), answer: "A free written answer.", inputMode: "text" }).body.assessment.id);
    }
    const form = a.snapshot.slots.find((s) => s.format === "choose_form")!;
    revealSlot(env.db, env.deps, a.sessionId, form.slotId, TAB);
    const content = JSON.parse(one<{ c: string }>("SELECT er.content_json AS c FROM session_slots ss JOIN exercise_revisions er ON er.id = ss.exercise_revision_id WHERE ss.id = ?", form.slotId).c);
    recordAttempt(env.db, env.deps, { slotId: form.slotId, submissionId: randomUUID(), answer: content.payload.accepted_option_ids, inputMode: "text" });
    finishSession(env.db, env.deps, a.sessionId, "ended_early");
    return { findingIds: rows<{ id: string }>("SELECT id FROM error_events ORDER BY rowid").map((r) => r.id), assessmentIds };
  }
  const startB = (seed: string, cfg?: DiscoveryConfig) => createPracticeSession(env.db, env.deps, { purpose: "practice", blueprintRevisionId: env.blueprintRevisionId, seed, timezone: "Australia/Brisbane" }, { discovery: cfg });
  const discoverySlots = (sessionId: string) => JSON.parse(one<{ c: string }>("SELECT choices_json AS c FROM scheduling_decisions WHERE session_id = ?", sessionId).c).slots.filter((s: { role: string }) => s.role === "discovery") as Array<{ slotId: string; skillId: string; bonus: number; revisionId: string; format: string }>;
  const snap = () => JSON.stringify(rows("SELECT skill_id, dimension, score, n, days, confidence_status, components_json FROM mastery_snapshots ORDER BY run_id, skill_id, dimension"));

  it("two qualified tentative findings in different contexts add one bounded probe for the suspected skill; Mastery is bit-identical", () => {
    const { findingIds } = seedFindings();
    expect(findingIds).toHaveLength(2);
    const asOf = "2026-10-29T00:00:00.000Z";
    const before = runMastery(env.db, { asOf, cohort: COHORT, now: env.deps.now });
    const snapshotBefore = JSON.stringify(rows("SELECT skill_id, dimension, score, n, days, confidence_status, components_json FROM mastery_snapshots WHERE run_id = ? ORDER BY skill_id, dimension", before.id));
    const confirmedBefore = JSON.stringify(rows("SELECT skill_revision_id, dimension, result FROM confirmed_opportunities ORDER BY id"));

    const off = startB("probe"); // default config: nobody is qualified, so the signal is OFF
    expect(discoverySlots(off.sessionId)).toEqual([]);
    finishSession(env.db, env.deps, off.sessionId, "ended_early");

    const on = startB("probe", qualified);
    const probes = discoverySlots(on.sessionId);
    expect(probes).toHaveLength(1); // min(2, floor(.15 * 18), exploration slots), one per suspected skill
    expect(probes[0]).toMatchObject({ skillId: suspect, bonus: 0.05 });
    expect(["choose_form", "choose_missing_fragment", "detect_error"]).toContain(probes[0]!.format);
    const decision = JSON.parse(one<{ c: string }>("SELECT choices_json AS c FROM scheduling_decisions WHERE session_id = ?", on.sessionId).c);
    expect(decision.discovery).toMatchObject({ version: "discovery-v1", qualificationIds: ["qual-fixture-1"], sourceFindingIds: [...findingIds].sort() });
    expect(decision.stats).toMatchObject({ discoveryActual: 1, weakActual: 12 }); // the confirmed weak quota is untouched

    // Mastery, confirmed counts and error evidence are exactly what they were
    const after = runMastery(env.db, { asOf, cohort: COHORT, now: env.deps.now });
    expect(JSON.stringify(rows("SELECT skill_id, dimension, score, n, days, confidence_status, components_json FROM mastery_snapshots WHERE run_id = ? ORDER BY skill_id, dimension", after.id))).toBe(snapshotBefore);
    expect(JSON.stringify(rows("SELECT skill_revision_id, dimension, result FROM confirmed_opportunities ORDER BY id"))).toBe(confirmedBefore);
    expect(rows("SELECT 1 FROM mastery_snapshots WHERE run_id = ? AND skill_id = ?", after.id, suspect)).toEqual([]); // a hypothesis is not evidence
    expect(snap().length).toBeGreaterThan(2);
  });

  it("a rejected finding (or a disputed analysis) removes the bonus from the next snapshot, and review history is append-only", () => {
    const { findingIds, assessmentIds } = seedFindings();
    reviewFinding(env.db, { findingId: findingIds[0]!, verdict: "rejected", reviewer: "agent:test", reviewVersion: "r1", sourceHash: "h", reason: "style, not grammar", expectedSequence: 0, newId: randomUUID, now: env.deps.now });
    const s1 = startB("probe", qualified);
    expect(discoverySlots(s1.sessionId)).toEqual([]);
    finishSession(env.db, env.deps, s1.sessionId, "ended_early");
    reviewFinding(env.db, { findingId: findingIds[0]!, verdict: "tentative", reviewer: "agent:test", reviewVersion: "r2", sourceHash: "h", reason: "re-accepted", expectedSequence: 1, newId: randomUUID, now: env.deps.now });
    const s2 = startB("probe", qualified);
    expect(discoverySlots(s2.sessionId)).toHaveLength(1);
    finishSession(env.db, env.deps, s2.sessionId, "ended_early");
    disputeAssessment(env.db, env.deps, { assessmentId: assessmentIds[1]!, reason: "my answer was fine" });
    const s3 = startB("probe", qualified);
    expect(discoverySlots(s3.sessionId)).toEqual([]);
    expect(count("finding_review_events")).toBe(2);
  });

  it("an undelivered probe is replaced atomically at reveal when its hypothesis is withdrawn meanwhile; shown history is untouched", () => {
    const { findingIds } = seedFindings();
    const b = startB("probe", qualified);
    const probe = discoverySlots(b.sessionId)[0]!;
    const decisionBefore = one<{ choices_json: string }>("SELECT choices_json FROM scheduling_decisions WHERE session_id = ?", b.sessionId).choices_json;
    takeLease(env.db, env.deps, b.sessionId, TAB);

    // another slot is revealed first and stays exactly as it was
    const other = b.snapshot.slots.find((s) => s.slotId !== probe.slotId && s.format === "choose_form")!;
    revealSlot(env.db, env.deps, b.sessionId, other.slotId, TAB);
    const otherRevision = one<{ r: string }>("SELECT exercise_revision_id AS r FROM session_slots WHERE id = ?", other.slotId).r;

    reviewFinding(env.db, { findingId: findingIds[1]!, verdict: "disputed", reviewer: "agent:test", reviewVersion: "r1", sourceHash: "h", reason: "unclear", expectedSequence: 0, newId: randomUUID, now: env.deps.now });
    const exposuresBefore = count("exposures");
    const revealed = revealSlot(env.db, env.deps, b.sessionId, probe.slotId, TAB);
    expect(revealed.alreadyRevealed).toBe(false);

    const replaced = one<{ r: string; cohort: string }>("SELECT exercise_revision_id AS r, cohort_json AS cohort FROM session_slots WHERE id = ?", probe.slotId);
    expect(replaced.r).not.toBe(probe.revisionId);
    expect(JSON.parse(replaced.cohort).role).toBe("explore");
    const ev = one<{ payload_json: string }>("SELECT payload_json FROM session_events WHERE slot_id = ? AND event_type = 'replacement'", probe.slotId);
    expect(JSON.parse(ev.payload_json)).toMatchObject({ reason: "discovery_hypothesis_withdrawn", suspectedSkill: suspect, from: probe.revisionId, to: replaced.r });
    // the old revision's units were released (never shown); the new one's are reserved by this slot and exposed by this reveal
    expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM prompt_reservations pr JOIN revision_prompt_units rpu ON rpu.unit_id = pr.unit_id WHERE rpu.revision_id = ? AND pr.slot_id = ?", probe.revisionId, probe.slotId).n).toBe(0);
    expect(one<{ n: number }>("SELECT COUNT(*) AS n FROM exposures e JOIN revision_prompt_units rpu ON rpu.unit_id = e.unit_id WHERE rpu.revision_id = ?", probe.revisionId).n).toBe(0);
    expect(count("exposures")).toBeGreaterThan(exposuresBefore);
    expect(one<{ r: string }>("SELECT exercise_revision_id AS r FROM session_slots WHERE id = ?", other.slotId).r).toBe(otherRevision);
    // the audit decision is immutable and still says what was decided at creation
    expect(one<{ choices_json: string }>("SELECT choices_json FROM scheduling_decisions WHERE session_id = ?", b.sessionId).choices_json).toBe(decisionBefore);
    expect(() => env.db.prepare("UPDATE scheduling_decisions SET choices_json = '{}'").run()).toThrow(/append-only/);
    // revealing again does not replace a second time
    expect(revealSlot(env.db, env.deps, b.sessionId, probe.slotId, TAB).alreadyRevealed).toBe(true);
    expect(count("session_events")).toBe(rows("SELECT 1 FROM session_events").length);
  });

  it("a probe whose hypothesis still stands is delivered as planned", () => {
    seedFindings();
    const b = startB("probe", qualified);
    const probe = discoverySlots(b.sessionId)[0]!;
    takeLease(env.db, env.deps, b.sessionId, TAB);
    revealSlot(env.db, env.deps, b.sessionId, probe.slotId, TAB);
    expect(one<{ r: string }>("SELECT exercise_revision_id AS r FROM session_slots WHERE id = ?", probe.slotId).r).toBe(probe.revisionId);
    expect(rows("SELECT 1 FROM session_events WHERE event_type = 'replacement'")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("concurrent writers", () => {
  it("a second connection cannot allocate while the first holds the write lock, and sees the first one's reservations afterwards", () => {
    env = openSliceCopy();
    const second = openDatabase(`${env.root}/db/english-lab.sqlite`);
    try {
      second.pragma("busy_timeout = 50");
      env.db.exec("BEGIN IMMEDIATE");
      expect(() => createPracticeSession(second, env.deps, { purpose: "practice", blueprintRevisionId: env.blueprintRevisionId, seed: "x", timezone: "Australia/Brisbane" })).toThrow(/locked|busy/i);
      env.db.exec("ROLLBACK");
      const a = createPracticeSession(env.db, env.deps, { purpose: "practice", blueprintRevisionId: env.blueprintRevisionId, seed: "x", timezone: "Australia/Brisbane" });
      env.db.prepare("UPDATE sessions SET status = 'suspended' WHERE id = ?").run(a.sessionId);
      const b = createPracticeSession(second, env.deps, { purpose: "practice", blueprintRevisionId: env.blueprintRevisionId, seed: "x", timezone: "Australia/Brisbane" });
      const fp = (id: string) => new Set(rows<{ f: string }>("SELECT DISTINCT u.fingerprint AS f FROM prompt_units u JOIN revision_prompt_units rpu ON rpu.unit_id = u.id JOIN session_slots ss ON ss.exercise_revision_id = rpu.revision_id WHERE ss.session_id = ?", id).map((r) => r.f));
      const fa = fp(a.sessionId);
      expect([...fp(b.sessionId)].some((f) => fa.has(f))).toBe(false); // same seed, still disjoint: the reservations decide, not the seed
    } finally {
      second.close();
    }
  });
});

// keep the unused import honest: hints/events helpers are exercised by sessions.test.ts
void recordSessionEvent;
void getFeedback;
void getSnapshot;
