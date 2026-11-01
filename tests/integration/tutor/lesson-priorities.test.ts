import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { exportLessonPriorities } from "../../../apps/server/src/domain/reports/lessonPriorities.js";
import { loadCandidates } from "../../../apps/server/src/domain/sessions/bank.js";
import { recordAttempt } from "../../../apps/server/src/domain/attempts/attempts.js";
import type { AssessmentDecision } from "../../../apps/server/src/domain/attempts/ports.js";
import { diagEnv } from "../diagnostics/fixtures.js";
import { addEvent, makeRevision, makeSession, makeSlot, type Env } from "../attempts/fixtures.js";

let env: Env | undefined;
afterEach(() => { env?.cleanup(); env = undefined; });

it("exports deterministic confirmed-only planning data without writing learning history", async () => {
  const fixture = await diagEnv({ practice: true, diagnostic: true });
  env = fixture.env;
  const before = env.db.prepare("SELECT count(*) AS n FROM assessment_revisions").get();
  const a = exportLessonPriorities(env.db, "2026-10-31T00:00:00.000Z");
  const b = exportLessonPriorities(env.db, "2026-10-31T00:00:00.000Z");
  expect(a.json).toEqual(b.json);
  expect(a.json).toMatchObject({ schema_version: "lesson-priorities-v1" });
  expect(JSON.stringify(a.json)).not.toContain("answer_text");
  expect(env.db.prepare("SELECT count(*) AS n FROM assessment_revisions").get()).toEqual(before);
});

it("ranks confirmed failures ahead of successes, excludes provisional model verdicts, and plans the requested mix", async () => {
  const fixture = await diagEnv({ practice: true });
  env = fixture.env;
  const candidates = loadCandidates(env.db, "practice").filter((c) => c.format === "choose_form");
  const weak = candidates[0]!;
  const strong = candidates.find((c) => c.skillId !== weak.skillId)!;
  const tentativeOnly = candidates.find((c) => c.skillId !== weak.skillId && c.skillId !== strong.skillId)!;
  expect(tentativeOnly).toBeDefined();
  const add = (revision: string, decision: AssessmentDecision) => {
    const sessionId = makeSession(env!);
    const slotId = makeSlot(env!, sessionId, revision, 0);
    addEvent(env!, sessionId, slotId, "reveal");
    recordAttempt(env!.db, { ...env!.deps, assessor: { assess: () => decision } }, { slotId, submissionId: randomUUID(), answer: ["a"], inputMode: "text" });
  };
  const fixed = (verdict: "correct" | "incorrect"): AssessmentDecision => ({ verdict, confirmation: "confirmed", source: "deterministic", rationale: "test" });
  add(weak.revisionId, fixed("incorrect"));
  add(strong.revisionId, fixed("correct"));
  add(tentativeOnly.revisionId, { verdict: "correct", confirmation: "tentative", source: "model", rationale: "test" });
  const before = ["attempts", "assessment_revisions", "skill_opportunities"].map((t) => env!.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get());
  const report = exportLessonPriorities(env.db, "2026-10-31T00:00:00.000Z", 5).json as { skills: Array<{ id: string; confirmedAttempts: number; priority: number | null; uncertainty: string }>; selection: { practiced: string[]; novel: string[]; targetNovel: number; novelUsed: number; lessons: string[][] } };
  const get = (id: string) => report.skills.find((s) => s.id === id)!;
  expect(get(weak.skillId)).toMatchObject({ confirmedAttempts: 1, uncertainty: "insufficient_evidence" });
  expect(get(strong.skillId)).toMatchObject({ confirmedAttempts: 1, uncertainty: "insufficient_evidence" });
  expect(get(weak.skillId).priority!).toBeGreaterThan(get(strong.skillId).priority!);
  expect(get(tentativeOnly.skillId)).toMatchObject({ confirmedAttempts: 0, priority: null, uncertainty: "insufficient_evidence" });
  expect(report.selection.novel).toContain(tentativeOnly.skillId);
  expect(report.selection.practiced).not.toContain(tentativeOnly.skillId);
  expect(report.selection.targetNovel).toBe(9);
  // Only two skills have confirmed evidence, so each five-skill lesson needs at least three novel skills.
  expect(report.selection.novelUsed).toBe(15);
  expect(report.selection.lessons).toHaveLength(5);
  for (const lesson of report.selection.lessons) expect(new Set(lesson).size).toBe(5);
  const extra = candidates.filter((c) => ![weak.skillId, strong.skillId, tentativeOnly.skillId].includes(c.skillId));
  const third = extra[0]!;
  const fourth = extra.find((c) => c.skillId !== third.skillId)!;
  expect(fourth).toBeDefined();
  add(third.revisionId, fixed("correct"));
  add(fourth.revisionId, fixed("correct"));
  const enough = exportLessonPriorities(env.db, "2026-10-31T00:00:00.000Z", 5).json as { selection: { targetNovel: number; novelUsed: number; lessons: string[][] } };
  expect(enough.selection.targetNovel).toBe(9);
  expect(enough.selection.novelUsed).toBe(9);
  for (const lesson of enough.selection.lessons) expect(new Set(lesson).size).toBe(5);
  const after = ["attempts", "assessment_revisions", "skill_opportunities"].map((t) => (env!.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
  expect(after).toEqual(before.map((v) => (v as { n: number }).n + 2));
  // An old, no-longer-selectable revision must still contribute in its own cohort.
  const oldRevision = makeRevision(env, { target: weak.skillId, difficulty: "B1", rubricVersion: "legacy-rubric" });
  add(oldRevision, fixed("incorrect"));
  const history = exportLessonPriorities(env.db, "2026-10-31T00:00:00.000Z", 5).json as { skills: Array<{ id: string; confirmedAttempts: number; series: Array<{ cohort: string; attempts: number; failures: number; priority: number }> }> };
  const weakHistory = history.skills.find((s) => s.id === weak.skillId)!;
  expect(weakHistory.confirmedAttempts).toBe(2);
  expect(weakHistory.series).toEqual(expect.arrayContaining([expect.objectContaining({ cohort: "legacy-rubric|B1", attempts: 1, failures: 1 })]));
});
