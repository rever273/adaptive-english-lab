import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recordAttempt } from "../../../apps/server/src/domain/attempts/attempts.js";
import { reviewFinding } from "../../../apps/server/src/domain/attempts/findings.js";
import { recordSessionEvent } from "../../../apps/server/src/domain/attempts/sessionEvents.js";
import { upsertModelVersion } from "../../../apps/server/src/domain/attempts/transcripts.js";
import type { Assessor, AttemptDeps } from "../../../apps/server/src/domain/attempts/ports.js";
import { NullOutbox } from "../../../apps/server/src/domain/attempts/ports.js";
import { csvCell, writeExport } from "../../../apps/server/src/domain/reports/export.js";
import { currentWatermarks } from "../../../apps/server/src/domain/reports/facts.js";
import { discoveryAudit, listFindings } from "../../../apps/server/src/domain/reports/findings.js";
import { getReport, readReport } from "../../../apps/server/src/domain/reports/report.js";
import { SKILL_B, SKILL_C, addEvent, exactSetAssessor, makeEnv, makeRevision, makeSession, makeSlot, one, rows, type Env } from "../attempts/fixtures.js";

let env: Env | null = null;
const tmp: string[] = [];
afterEach(() => {
  env?.cleanup();
  env = null;
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

const finding = (skillId: string, correction = "x") => ({ skillId, fragmentStart: 0, fragmentEnd: 3, correction, explanationRu: "ошибка", findingType: "grammar" as const, verdict: "confirmed" as const, confidence: 0.9 });
const pendingFor = (type: string): Assessor["assess"] => () => ({ verdict: "pending", confirmation: "tentative", source: "deterministic", rationale: `pending ${type}` });
const base = exactSetAssessor((ok) => (ok ? {} : { findings: [finding(SKILL_B, "should be a"), finding(SKILL_C, "=HYPERLINK(\"http://evil\",\"x\")")] }));
const mixed: Assessor = { assess: (ctx) => (ctx.exerciseType === "choose_form" ? base.assess(ctx) : pendingFor(ctx.exerciseType)(ctx)) };
const deps = (e: Env, assessor: Assessor = mixed): AttemptDeps => ({ ...e.deps, assessor, outbox: NullOutbox });
const tick = (e: Env, s = 60) => (e.clock.current = new Date(e.clock.current.getTime() + s * 1000));

/** one slot in its own session, revealed; returns ids */
function slot(e: Env, o: { rubric?: string; difficulty?: "B2" | "C1" } = {}) {
  const rev = makeRevision(e, { type: "choose_form", dimension: "recognition", rubricVersion: o.rubric ?? "rubric-v1", difficulty: o.difficulty ?? "B2" });
  const sessionId = makeSession(e);
  const slotId = makeSlot(e, sessionId, rev, 0);
  addEvent(e, sessionId, slotId, "reveal");
  return { sessionId, slotId };
}
const answer = (e: Env, slotId: string, a: string, assessor?: Assessor) => recordAttempt(e.db, deps(e, assessor), { slotId, submissionId: randomUUID(), answer: [a], inputMode: "text" });
const sessionEvent = (e: Env, sessionId: string, slotId: string, type: "hint" | "skip" | "continue") => recordSessionEvent(e.db, deps(e), sessionId, { slotId, type, clientEventId: randomUUID() });

/** The known dataset used by the exact-number tests (see the expectations below). */
function knownDataset(e: Env): { aiAttempt: string } {
  // A: 10 unaided first attempts, in order c c c i c c i c c i  (7 correct, 3 incorrect, each incorrect carries TWO findings)
  for (const a of ["a", "a", "a", "b", "a", "a", "b", "a", "a", "b"]) {
    answer(e, slot(e).slotId, a);
    tick(e);
  }
  // B: two assisted first attempts (hint first): one correct, one incorrect
  for (const a of ["a", "b"]) {
    const s = slot(e);
    sessionEvent(e, s.sessionId, s.slotId, "hint");
    answer(e, s.slotId, a);
    tick(e);
  }
  // C: two "I don't know"
  for (let i = 0; i < 2; i++) {
    const s = slot(e);
    recordAttempt(e.db, deps(e), { slotId: s.slotId, submissionId: randomUUID(), idk: true, inputMode: "text" });
    tick(e);
  }
  // D: a wrong first attempt, then a right retry
  const d = slot(e);
  answer(e, d.slotId, "b");
  tick(e);
  answer(e, d.slotId, "a");
  tick(e);
  // E: a written answer nobody has judged yet (guided short answer)
  const rev = makeRevision(e, { type: "guided_short_answer", dimension: "production", content: undefined });
  void rev;
  // F: three revealed-and-skipped slots
  for (let i = 0; i < 3; i++) {
    const s = slot(e);
    sessionEvent(e, s.sessionId, s.slotId, "skip");
    tick(e);
  }
  // G: an AI-analysed answer: model verdict, TENTATIVE, two tentative findings
  const modelId = upsertModelVersion(e.db, randomUUID, { tag: "qwen3:8b", digest: "d".repeat(64), runtime: "ollama", runtimeVersion: "0.40", parameters: {} });
  const ai: Assessor = {
    assess: () => ({ verdict: "incorrect", confirmation: "tentative", source: "model", rationale: "AI draft", modelVersionId: modelId, findings: [{ ...finding(SKILL_B, "tentative fix"), verdict: "tentative", modelVersionId: modelId }, { ...finding(SKILL_C), verdict: "tentative", modelVersionId: modelId }] }),
  };
  const g = slot(e);
  const att = answer(e, g.slotId, "b", ai);
  tick(e);
  return { aiAttempt: att.body.attemptId };
}

const asOf = () => new Date(env!.clock.current.getTime() + 3600_000).toISOString();

describe("exact numbers on a known dataset", () => {
  it("numerators and denominators, strata, pending, IDK/skip and per-skill counts are exactly what the events say", async () => {
    env = await makeEnv();
    knownDataset(env);
    const { report, id, inputHash } = getReport(env.db, env.deps, { asOf: asOf() });
    const m = report.metrics;
    // unaided confirmed first attempts: 10 + 2 IDK + 1 wrong-first = 13, correct 7
    expect(m.firstAttemptAccuracy).toMatchObject({ numerator: 7, denominator: 13 });
    expect(m.firstAttemptAccuracy.rate).toBeCloseTo(7 / 13, 12);
    expect(m.firstAttemptAccuracy.assisted).toEqual({ attempts: 2, correct: 1 }); // a separate stratum, never in the main line
    // practice accuracy: last confirmed answer of each of 15 slots (10 + 2 + 2 + 1), 9 correct, and it says assisted retries are included
    expect(m.practiceAccuracy).toMatchObject({ numerator: 9, denominator: 15 });
    expect(m.practiceAccuracy.note).toContain("assisted");
    expect(m.heldoutAccuracy).toMatchObject({ numerator: 0, denominator: 0, rate: null, wilson: null }); // unknown is not zero
    expect(m.delayedRetention.denominator).toBe(0);
    expect(m.idk).toMatchObject({ numerator: 2, denominator: 16 }); // first attempts of all kinds (10+2+2+1+1 AI)
    expect(m.skip).toMatchObject({ numerator: 3, denominator: 19 }); // revealed slots: 10+2+2+1+3+1
    expect(m.pending).toEqual({ slots: 1, attempts: 1 }); // only the AI-analysed answer: tentative, not wrong, not in any denominator
    // R/C/P: everything here is recognition
    expect(report.byDimension.recognition).toMatchObject({ numerator: 7, denominator: 13 });
    expect(report.byDimension.correction.denominator).toBe(0);
    // per skill (confirmed independent evidence): 6 failures (3 wrong + 2 IDK + 1 wrong-first) in 13
    expect(report.skills).toHaveLength(1);
    expect(report.skills[0]).toMatchObject({ failures: 6, opportunities: 13 });
    // recurrence: the first failure is excluded; after it 9 opportunities, 5 of them failures
    expect(m.errorRecurrence).toMatchObject({ skills: 1, failuresAfterFirst: 5, opportunitiesAfterFirst: 9 });
    expect(report.recurring[0]).toMatchObject({ failuresAfterFirst: 5, opportunitiesAfterFirst: 9 });
    expect(report.recurring[0]!.contexts).toBeGreaterThan(1);
    // Wilson interval is the textbook one and low n is flagged below 10
    const [pp, n, z] = [7 / 13, 13, 1.96];
    const centre = (pp + (z * z) / (2 * n)) / (1 + (z * z) / n);
    const half = (z * Math.sqrt((pp * (1 - pp)) / n + (z * z) / (4 * n * n))) / (1 + (z * z) / n);
    expect(m.firstAttemptAccuracy.wilson!.low).toBeCloseTo(centre - half, 12); // spec/09 formula, written out here independently
    expect(m.firstAttemptAccuracy.wilson!.high).toBeCloseTo(centre + half, 12);
    expect(m.firstAttemptAccuracy.lowN).toBe(false);
    expect(m.skip.lowN).toBe(false);
    expect(report.comparison.status).toBe("insufficient_comparison_data"); // one day of data cannot show change
    expect(id).toBeTruthy();
    expect(inputHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("an identical request returns the SAME saved report; new evidence makes a NEW one; the old one is never rewritten", async () => {
    env = await makeEnv();
    knownDataset(env);
    const a = getReport(env.db, env.deps, { asOf: asOf() });
    const b = getReport(env.db, env.deps, { asOf: asOf() });
    expect(b.id).toBe(a.id);
    expect(b.reused).toBe(true);
    answer(env, slot(env).slotId, "a");
    const c = getReport(env.db, env.deps, { asOf: new Date(env.clock.current.getTime() + 3600_000).toISOString() });
    expect(c.id).not.toBe(a.id);
    expect(c.report.metrics.firstAttemptAccuracy.denominator).toBe(14);
    expect(readReport(env.db, a.id).report.metrics.firstAttemptAccuracy.denominator).toBe(13); // as it was computed
    expect(() => env!.db.prepare("UPDATE analytics_reports SET report_json = '{}'").run()).toThrow(/append-only/);
    expect(() => env!.db.prepare("DELETE FROM analytics_reports").run()).toThrow(/append-only/);
  });

  it("a human correction of an assessment moves the NEW report only", async () => {
    env = await makeEnv();
    knownDataset(env);
    const before = getReport(env.db, env.deps, { asOf: asOf() });
    const wrong = one<{ attempt_id: string }>(env.db, "SELECT a.attempt_id AS attempt_id FROM assessment_revisions a WHERE a.verdict = 'incorrect' AND a.confirmation = 'confirmed' ORDER BY a.rowid LIMIT 1").attempt_id;
    const { disputeAssessment } = await import("../../../apps/server/src/domain/attempts/assessments.js");
    const aid = one<{ id: string }>(env.db, "SELECT id FROM assessment_revisions WHERE attempt_id = ? ORDER BY sequence DESC LIMIT 1", wrong).id;
    disputeAssessment(env.db, deps(env), { assessmentId: aid, reason: "I think this was right" });
    const after = getReport(env.db, env.deps, { asOf: asOf() });
    expect(after.id).not.toBe(before.id);
    expect(after.report.metrics.firstAttemptAccuracy.denominator).toBe(12); // the disputed answer left the confirmed denominator
    expect(after.report.metrics.pending.attempts).toBe(before.report.metrics.pending.attempts + 1); // and is reported as pending, not as correct or wrong
    expect(readReport(env.db, before.id).report.metrics.firstAttemptAccuracy.denominator).toBe(13);
  });
});

describe("time zone and cohorts", () => {
  it("the Brisbane local date decides the day and the week (23:30 Sunday and 00:30 Monday are different weeks, though one UTC day)", async () => {
    env = await makeEnv();
    env.clock.current = new Date("2026-11-01T13:30:00.000Z"); // Sunday 23:30 in Brisbane
    answer(env, slot(env).slotId, "a");
    env.clock.current = new Date("2026-11-01T14:30:00.000Z"); // Monday 00:30 in Brisbane
    answer(env, slot(env).slotId, "b");
    const r = getReport(env.db, env.deps, { asOf: "2026-11-02T03:00:00.000Z" }).report;
    expect(r.activity).toEqual([{ date: "2026-11-01", attempts: 1 }, { date: "2026-11-02", attempts: 1 }]);
    expect(r.weeklyFirstTry.map((w) => [w.week, w.firstTry.denominator])).toEqual([["2026-10-26", 1], ["2026-11-02", 1]]);
  });

  it("a changed rubric or difficulty is a different cohort: never mixed in, and listed so the reader knows", async () => {
    env = await makeEnv();
    answer(env, slot(env).slotId, "a");
    answer(env, slot(env, { rubric: "rubric-v2" }).slotId, "b");
    answer(env, slot(env, { difficulty: "C1" }).slotId, "b");
    const r = getReport(env.db, env.deps, { asOf: asOf() }).report;
    expect(r.metrics.firstAttemptAccuracy).toMatchObject({ numerator: 1, denominator: 1 });
    expect(r.otherCohorts.map((c) => `${c.criterionVersion}|${c.difficulty}|${c.protocol}:${c.attempts}`).sort()).toEqual(["rubric-v1|C1|practice:1", "rubric-v2|B2|practice:1"]);
    const v2 = getReport(env.db, env.deps, { asOf: asOf(), cohort: { criterionVersion: "rubric-v2" } }).report;
    expect(v2.metrics.firstAttemptAccuracy).toMatchObject({ numerator: 0, denominator: 1 });
  });

  it("model changes inside a cohort are shown as markers on the series", async () => {
    env = await makeEnv();
    knownDataset(env);
    const r = getReport(env.db, env.deps, { asOf: asOf() }).report;
    expect(r.changeMarkers).toEqual([expect.objectContaining({ kind: "assessment_model", attempts: 1, id: expect.stringContaining("qwen3:8b@") })]); // the one AI-assessed attempt is flagged as a different kind of series point
  });
});

describe("AI-detected findings stay apart from verified results", () => {
  it("two tentative findings change the findings list and the discovery audit, never the verified numbers; reject/dispute keeps history", async () => {
    env = await makeEnv();
    const before = (() => {
      const x = knownDataset(env!);
      return x;
    })();
    void before;
    const rep = getReport(env.db, env.deps, { asOf: asOf() });
    const wm = currentWatermarks(env.db);
    const list = listFindings(env.db, { asOf: asOf(), watermarks: wm });
    const ai = list.filter((f) => f.provenance.model === "qwen3:8b");
    expect(ai).toHaveLength(2);
    for (const f of ai) {
      expect(f).toMatchObject({ originalStatus: "tentative", effectiveStatus: "tentative", label: "AI-detected, not verified", isLatestAnalysis: true });
      expect(f.provenance).toMatchObject({ model: "qwen3:8b", runtime: "ollama" });
      expect(f.label).not.toMatch(/mistake|error/i); // never worded as a confirmed error
    }
    // confirmed deterministic findings exist too (5 wrong answers x 2: three unaided, one assisted, one retried): listed with their own status, not as AI
    expect(list.filter((f) => f.effectiveStatus === "confirmed" && f.provenance.model === null)).toHaveLength(10);
    // the verified figures know nothing about the AI draft
    expect(rep.report.metrics.firstAttemptAccuracy).toMatchObject({ numerator: 7, denominator: 13 });

    // an agent review rejects one: history is kept, status is effective, numbers are unchanged
    reviewFinding(env.db, { findingId: ai[0]!.findingId, verdict: "rejected", reviewer: "agent:reviewer@1", reviewVersion: "r1", sourceHash: "h", expectedSequence: 0, reason: "not an error", now: () => new Date(), newId: randomUUID } as never);
    const wm2 = currentWatermarks(env.db);
    const list2 = listFindings(env.db, { asOf: asOf(), watermarks: wm2 });
    const rejected = list2.find((f) => f.findingId === ai[0]!.findingId)!;
    expect(rejected).toMatchObject({ originalStatus: "tentative", effectiveStatus: "rejected", label: "Rejected by review" });
    expect(rejected.history).toHaveLength(1);
    expect(rejected.history[0]).toMatchObject({ reviewer: "agent:reviewer@1", reason: "not an error" });
    // replay at the OLD watermarks still shows the old state
    expect(listFindings(env.db, { asOf: asOf(), watermarks: wm }).find((f) => f.findingId === ai[0]!.findingId)!.effectiveStatus).toBe("tentative");
    expect(getReport(env.db, env.deps, { asOf: asOf() }).report.metrics.firstAttemptAccuracy).toMatchObject({ numerator: 7, denominator: 13 });

    const taxonomyId = env.taxonomyId;
    const audit = discoveryAudit(env.db, { asOf: asOf(), taxonomyId, watermarks: wm2 });
    expect(audit).toMatchObject({ enabled: false, disabledReason: "Disabled: model not qualified", config: { qualifiedModels: 0 } });
    expect(audit.skills.every((s) => s.bonus === 0)).toBe(true); // nothing is nudged while no model is qualified
  });
});

describe("exports", () => {
  it("CSV cells can never be formulas; quotes and newlines are escaped", () => {
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("+SUM(A1)")).toBe("'+SUM(A1)");
    expect(csvCell("-2+3")).toBe("'-2+3");
    expect(csvCell("@cmd")).toBe("'@cmd");
    expect(csvCell("\tx")).toBe("'\tx");
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvCell(-3)).toBe("-3"); // a real number is not text
    expect(csvCell(null)).toBe("");
  });

  it("the bundle is written atomically with generated names; its summary reconstructs from the exported rows; AI findings are not in errors.csv", async () => {
    env = await makeEnv();
    knownDataset(env);
    const saved = getReport(env.db, env.deps, { asOf: asOf() });
    const root = mkdtempSync(path.join(os.tmpdir(), "el-export-"));
    tmp.push(root);
    const out = writeExport(env.db, root, saved, saved.report.asOf);
    expect(out.dir).toMatch(/^report-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/);
    expect(out.files.map((f) => f.name)).toEqual(["attempts.csv", "opportunities.csv", "errors.csv", "findings.csv", "summary.csv", "report.json", "report.md"]);
    const read = (n: string) => readFileSync(path.join(root, out.dir, n), "utf8");
    const parse = (t: string) => t.trim().split("\r\n").map((l) => l.split(","));
    // reconstruct First Attempt Accuracy from attempts.csv alone
    const att = parse(read("attempts.csv"));
    const h = att[0]!;
    const col = (r: string[], n: string) => r[h.indexOf(n)]!;
    const unaided = att.slice(1).filter((r) => col(r, "first_attempt") === "1" && col(r, "hints_before") === "0" && col(r, "answer_seen_before") === "0" && col(r, "latest_confirmation") === "confirmed" && ["correct", "incorrect", "idk"].includes(col(r, "latest_verdict")));
    const summary = parse(read("summary.csv"));
    const fa = summary.find((r) => r[0] === "first_attempt_accuracy_unaided")!;
    expect([Number(fa[2]), Number(fa[3])]).toEqual([unaided.filter((r) => col(r, "latest_verdict") === "correct").length, unaided.length]);
    expect(att.length - 1).toBe(one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM attempts").n);
    // errors.csv holds confirmed findings only; the AI's tentative ones are in findings.csv with their status
    const errors = parse(read("errors.csv")).slice(1);
    expect(errors).toHaveLength(10);
    expect(errors.every((r) => r[4] === "confirmed")).toBe(true);
    const fcsv = read("findings.csv");
    expect(fcsv).toContain("tentative");
    expect(fcsv).toContain("qwen3:8b");
    // the model-supplied correction that is a formula is neutralised wherever it appears
    expect(fcsv).toContain("'=HYPERLINK");
    expect(fcsv).not.toMatch(/(^|,)=HYPERLINK/m);
    const json = JSON.parse(read("report.json")) as { schema_version: string; run: { inputHash: string }; findings: unknown[]; discovery: { disabledReason: string } };
    expect(json).toMatchObject({ schema_version: "report-export-v1", run: { inputHash: saved.inputHash }, discovery: { disabledReason: "Disabled: model not qualified" } });
    expect(read("report.md")).toContain("AI-detected findings (NOT verified mistakes");
    expect(read("report.md")).toContain(saved.inputHash);
    expect(rows(env.db, "SELECT 1 FROM sqlite_master WHERE name LIKE '%audio%'")).toEqual([]);
  });
});
