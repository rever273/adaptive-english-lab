import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DISCOVERY_V1, rankProbeCandidates, type DiscoveryConfig } from "../../../packages/learning/src/index.js";
import { disputeAssessment } from "../../../apps/server/src/domain/attempts/assessments.js";
import { recordAttempt } from "../../../apps/server/src/domain/attempts/attempts.js";
import { reviewFinding } from "../../../apps/server/src/domain/attempts/findings.js";
import type { Assessor, AttemptDeps, FindingInput } from "../../../apps/server/src/domain/attempts/ports.js";
import { upsertModelVersion } from "../../../apps/server/src/domain/attempts/transcripts.js";
import { currentReviewWatermark, runDiscovery } from "../../../apps/server/src/domain/analytics/discoveryAdapter.js";
import { currentWatermark } from "../../../apps/server/src/domain/analytics/evidence.js";
import { runMastery } from "../../../apps/server/src/domain/analytics/runs.js";
import { SKILL_B, SKILL_C, advance, exactSetAssessor, makeEnv, one, revealedSlot, rows, type Env } from "../attempts/fixtures.js";

const COHORT = { criterionVersion: "rubric-v1", difficulty: "B2" as const };
const SUSPECT = SKILL_C; // countability.mass_nouns: sorts AFTER SKILL_B, so a bonus visibly reorders equal priorities
const OTHER = SKILL_B; // articles.indefinite

let env: Env;
let qualified: DiscoveryConfig;
let modelId: string;
let modelKey: string;

beforeEach(async () => {
  env = await makeEnv({ assessor: exactSetAssessor() });
  modelId = upsertModelVersion(env.db, randomUUID, { tag: "qwen3:14b", digest: "sha256:test-digest", runtime: "ollama", runtimeVersion: "0.40.12", parameters: {} });
  modelKey = "qwen3:14b@sha256:test-digest";
  qualified = { ...DISCOVERY_V1, qualifiedModels: [{ key: modelKey, qualificationId: "qual-test-1" }] };
});
afterEach(() => env.cleanup());

const asOf = () => env.deps.now().toISOString();

/** An open production answer analysed by a model: tentative verdict plus tentative findings. Never confirmed. */
function openAnswerWithFindings(findings: Array<Partial<FindingInput>>, o: { contextId?: string; modelVersionId?: string } = {}) {
  const assessor: Assessor = {
    assess: () => ({
      verdict: "incorrect",
      confirmation: "tentative",
      source: "model",
      rationale: "model analysis (tentative)",
      modelVersionId: o.modelVersionId ?? modelId,
      findings: findings.map((f) => ({ skillId: SUSPECT, explanationRu: "возможная ошибка", findingType: "grammar" as const, verdict: "tentative" as const, confidence: 0.9, modelVersionId: o.modelVersionId ?? modelId, ...f })),
    }),
  };
  const deps: AttemptDeps = { ...env.deps, assessor };
  const { slotId } = revealedSlot(env, { type: "guided_short_answer", dimension: "production", target: OTHER, contextId: o.contextId });
  const r = recordAttempt(env.db, deps, { slotId, submissionId: randomUUID(), answer: "Their free text answer.", inputMode: "text" });
  advance(env, 1000);
  return r.body;
}

/** Confirmed unaided evidence that Mastery sees. */
function confirmedAnswers(n: number) {
  for (let i = 0; i < n; i++) {
    const { slotId } = revealedSlot(env, { target: OTHER });
    recordAttempt(env.db, env.deps, { slotId, submissionId: randomUUID(), answer: [i % 3 === 0 ? "b" : "a"], inputMode: "text" });
    advance(env, 1000);
  }
}

const bonusFor = (skillId = SUSPECT) => runDiscovery(env.db, { asOf: asOf(), taxonomyId: env.taxonomyId, config: qualified }).skills.find((s) => s.skillId === skillId)?.bonus ?? 0;
const ranking = () => {
  const bonus = runDiscovery(env.db, { asOf: asOf(), taxonomyId: env.taxonomyId, config: qualified });
  const bonusBySkill = Object.fromEntries(bonus.skills.map((s) => [s.skillId, s.bonus]));
  const cand = (skillId: string) => ({ skillId, basePriority: 0.5, planMultiplier: 1, dimension: "correction" as const, bankRole: "practice" as const });
  return rankProbeCandidates([cand(SUSPECT), cand(OTHER)], bonusBySkill).map((r) => r.skillId);
};

describe("regression: two tentative Qwen findings change probe ranking, never Mastery", () => {
  it("bonus appears after two qualified findings in different contexts; scores, confirmed counts and error rates are bitwise unchanged", () => {
    confirmedAnswers(6);
    const FIXED_AS_OF = "2026-10-29T00:00:00.000Z"; // one as_of for both runs, later than every event
    const run0 = runMastery(env.db, { asOf: FIXED_AS_OF, cohort: COHORT, now: env.deps.now });
    const confirmedBefore = JSON.stringify(rows(env.db, "SELECT skill_revision_id, dimension, result FROM confirmed_opportunities ORDER BY id"));
    const snapBefore = JSON.stringify(rows(env.db, "SELECT skill_id, dimension, score, n, days, confidence_status, components_json FROM mastery_snapshots WHERE run_id = ? ORDER BY skill_id, dimension", run0.id));
    const orderBefore = ranking();
    expect(orderBefore).toEqual([OTHER, SUSPECT]); // equal priorities: alphabetical
    expect(bonusFor()).toBe(0);

    openAnswerWithFindings([{}], { contextId: "ctx-A" });
    expect(bonusFor()).toBe(0); // one finding is only a hint
    openAnswerWithFindings([{}], { contextId: "ctx-B" });
    expect(bonusFor()).toBeCloseTo(0.05, 12);
    expect(ranking()).toEqual([SUSPECT, OTHER]); // the suspected skill is probed first

    const run1 = runMastery(env.db, { asOf: FIXED_AS_OF, cohort: COHORT, now: env.deps.now });
    expect(run1.eventWatermark).toBeGreaterThan(run0.eventWatermark); // new raw events exist...
    expect(JSON.stringify(rows(env.db, "SELECT skill_id, dimension, score, n, days, confidence_status, components_json FROM mastery_snapshots WHERE run_id = ? ORDER BY skill_id, dimension", run1.id))).toBe(snapBefore);
    expect(JSON.stringify(rows(env.db, "SELECT skill_revision_id, dimension, result FROM confirmed_opportunities ORDER BY id"))).toBe(confirmedBefore); // ...but no confirmed evidence
    // the suspected skill has no mastery row at all: a hypothesis is not evidence
    expect(rows(env.db, "SELECT 1 FROM mastery_snapshots WHERE run_id = ? AND skill_id = ?", run1.id, SUSPECT)).toEqual([]);
  });

  it("source finding IDs and qualification are reported for the scheduling audit trail", () => {
    openAnswerWithFindings([{}], { contextId: "c1" });
    openAnswerWithFindings([{}], { contextId: "c2" });
    const d = runDiscovery(env.db, { asOf: asOf(), taxonomyId: env.taxonomyId, config: qualified });
    expect(d.skills).toHaveLength(1);
    expect(d.skills[0]).toMatchObject({ skillId: SUSPECT, k: 2, contexts: 2, qualificationIds: ["qual-test-1"] });
    expect(d.sourceFindingIds).toHaveLength(2);
    expect(d.sourceFindingIds.every((id) => one(env.db, "SELECT id FROM error_events WHERE id = ?", id) !== undefined)).toBe(true);
    expect(d.watermark).toBe(currentWatermark(env.db));
  });

  it("reject of one finding -> bonus 0 and the old order; the history keeps both reviews", () => {
    openAnswerWithFindings([{}], { contextId: "c1" });
    openAnswerWithFindings([{}], { contextId: "c2" });
    const watermarkBeforeReview = currentReviewWatermark(env.db);
    expect(bonusFor()).toBeGreaterThan(0);
    const f = rows<{ id: string }>(env.db, "SELECT id FROM error_events ORDER BY rowid")[0]!;
    reviewFinding(env.db, { findingId: f.id, verdict: "rejected", reviewer: "agent:test", reviewVersion: "r1", sourceHash: "h", reason: "style, not grammar", expectedSequence: 0, newId: randomUUID, now: env.deps.now });
    expect(bonusFor()).toBe(0);
    expect(ranking()).toEqual([OTHER, SUSPECT]);
    // replay "as it was before the review" still sees the bonus (review watermark), nothing was overwritten
    const replay = runDiscovery(env.db, { asOf: asOf(), taxonomyId: env.taxonomyId, config: qualified, reviewWatermark: watermarkBeforeReview });
    expect(replay.skills[0]?.bonus).toBeCloseTo(0.05, 12);
    // re-acceptance is a new event, not an overwrite
    reviewFinding(env.db, { findingId: f.id, verdict: "tentative", reviewer: "agent:test", reviewVersion: "r2", sourceHash: "h", reason: "re-checked", expectedSequence: 1, newId: randomUUID, now: env.deps.now });
    expect(bonusFor()).toBeCloseTo(0.05, 12);
  });

  it("disputing one analysed answer removes its finding from the signal", () => {
    const a = openAnswerWithFindings([{}], { contextId: "c1" });
    openAnswerWithFindings([{}], { contextId: "c2" });
    expect(bonusFor()).toBeGreaterThan(0);
    disputeAssessment(env.db, env.deps, { assessmentId: a.assessment.id, reason: "my answer was fine" });
    expect(bonusFor()).toBe(0);
  });

  it("two findings in one answer, low confidence, style, unqualified model and duplicate contexts all give 0", () => {
    openAnswerWithFindings([{}, {}], { contextId: "c1" }); // two findings, ONE attempt = one vote
    expect(bonusFor()).toBe(0);
    openAnswerWithFindings([{ confidence: 0.5 }], { contextId: "c2" });
    openAnswerWithFindings([{ findingType: "style" }], { contextId: "c3" });
    expect(bonusFor()).toBe(0);
    const other = upsertModelVersion(env.db, randomUUID, { tag: "qwen3:8b", digest: "sha256:unqualified", runtime: "ollama", runtimeVersion: "0.40.12", parameters: {} });
    openAnswerWithFindings([{}], { contextId: "c4", modelVersionId: other });
    expect(bonusFor()).toBe(0);
    openAnswerWithFindings([{}], { contextId: "c1" }); // same context as the first one
    expect(bonusFor()).toBe(0);
    openAnswerWithFindings([{}], { contextId: "c5" }); // a second qualified attempt in a new context finally counts
    expect(bonusFor()).toBeCloseTo(0.075, 12); // k = 3 distinct qualified attempts (c1, c1', c5) in 2 contexts
  });

  it("is off before the model quality gate: the default config has no qualified model", () => {
    openAnswerWithFindings([{}], { contextId: "c1" });
    openAnswerWithFindings([{}], { contextId: "c2" });
    expect(runDiscovery(env.db, { asOf: asOf(), taxonomyId: env.taxonomyId }).skills).toEqual([]);
  });

  it("a confirmed unaided probe on the suspected skill retires the old findings; a new hypothesis needs two new ones", () => {
    openAnswerWithFindings([{}], { contextId: "c1" });
    openAnswerWithFindings([{}], { contextId: "c2" });
    expect(bonusFor()).toBeGreaterThan(0);
    const { slotId } = revealedSlot(env, { target: SUSPECT, dimension: "correction" });
    recordAttempt(env.db, env.deps, { slotId, submissionId: randomUUID(), answer: ["a"], inputMode: "text" }); // confirmed probe answer
    advance(env, 1000);
    expect(bonusFor()).toBe(0);
    openAnswerWithFindings([{}], { contextId: "c6" });
    expect(bonusFor()).toBe(0);
    openAnswerWithFindings([{}], { contextId: "c7" });
    expect(bonusFor()).toBeCloseTo(0.05, 12);
  });

  it("model-sourced confirmation is impossible at every layer (service, DB CHECK, finding verdict)", () => {
    const bad: Assessor = { assess: () => ({ verdict: "incorrect", confirmation: "tentative", source: "model", rationale: "x", findings: [{ skillId: SUSPECT, explanationRu: "x", findingType: "grammar", verdict: "confirmed" }] }) };
    const { slotId } = revealedSlot(env);
    expect(() => recordAttempt(env.db, { ...env.deps, assessor: bad }, { slotId, submissionId: randomUUID(), answer: ["a"], inputMode: "text" })).toThrow(/never be confirmed/);
    expect(one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM attempts").n).toBe(0);
  });
});
