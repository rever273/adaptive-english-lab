import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ErrorEnvelopeSchema, SessionBootstrapSchema } from "../../../packages/contracts/src/index.js";
import { buildApp } from "../../../apps/server/src/app.js";
import { recordAttempt } from "../../../apps/server/src/domain/attempts/attempts.js";
import { upsertModelVersion } from "../../../apps/server/src/domain/attempts/transcripts.js";
import { NullOutbox, type Assessor } from "../../../apps/server/src/domain/attempts/ports.js";
import { decideExternal, importExternal, listExternal, readExternal } from "../../../apps/server/src/domain/external-assessments/external.js";
import { currentWatermarks } from "../../../apps/server/src/domain/reports/facts.js";
import { findingsForReview, importFindingReviews } from "../../../apps/server/src/domain/reports/findingReview.js";
import { listFindings } from "../../../apps/server/src/domain/reports/findings.js";
import { getReport } from "../../../apps/server/src/domain/reports/report.js";
import { ApiError } from "../../../apps/server/src/errors.js";
import { SKILL_B, SKILL_C, addEvent, makeEnv, makeRevision, makeSession, makeSlot, one, rows, type Env } from "../attempts/fixtures.js";
import { freePort, testConfig } from "../helpers.js";

let env: Env | null = null;
let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
  env?.cleanup();
  env = null;
});
const deps = () => ({ now: () => new Date(env!.clock.current), newId: randomUUID });
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

const MD = ["# Reference check 2026-10-28", "", "## Grammar", "- Articles: 62% correct on 21 items", "- Embedded questions: 35% (n=17)", "Overall the learner hesitates with prepositions.", "", "## Method", "Transcript quality was mixed; <script>alert(1)</script> [x](javascript:alert(1))"].join("\n");
const req = (o: Record<string, unknown> = {}) => ({ format: "md", text: MD, source: "Outside tutor", assessedAt: "2026-10-28", method: "oral interview v1", transcriptQuality: "fair", ...o });

describe("external assessments: a separate series, text only", () => {
  it("imports as a normalised, source-linked PREVIEW; nothing internal changes; percentages stay separate", async () => {
    env = await makeEnv();
    const rev = makeRevision(env, { type: "choose_form", dimension: "recognition" });
    const sid = makeSession(env);
    const slot = makeSlot(env, sid, rev, 0);
    addEvent(env, sid, slot, "reveal");
    recordAttempt(env.db, { ...env.deps, assessor: { assess: () => ({ verdict: "correct", confirmation: "confirmed", source: "deterministic", rationale: "ok" }) }, outbox: NullOutbox }, { slotId: slot, submissionId: randomUUID(), answer: ["a"], inputMode: "text" });
    const counts = () => ["attempts", "assessment_revisions", "skill_opportunities", "error_events", "analytics_reports"].map((t) => one<{ n: number }>(env!.db, `SELECT COUNT(*) AS n FROM ${t}`).n);
    const reportBefore = getReport(env.db, deps(), {}).report.metrics;
    const before = counts();

    const { view, created } = importExternal(env.db, deps(), req());
    expect(created).toBe(true);
    expect(view).toMatchObject({ status: "draft", source: "Outside tutor", assessedAt: "2026-10-28", method: "oral interview v1", transcriptQuality: "fair" });
    expect(view.comparability.comparableToInternalMastery).toBe(false);
    const pct = view.normalized.assertions.filter((a) => a.percent !== null);
    expect(pct.map((a) => a.percent)).toEqual([62, 35]);
    expect(pct[0]).toMatchObject({ kind: "reported_value", status: "uncertain", source: { section: "Reference check 2026-10-28 > Grammar", line: 4 } });
    expect(view.normalized.assertions.every((a) => a.status === "uncertain")).toBe(true); // an outside statement is a hypothesis
    expect(view.normalized.flags.join(" ")).toMatch(/markup or a link scheme/); // flagged, never executed
    expect(counts().slice(0, 4)).toEqual(before.slice(0, 4)); // no attempt, assessment, opportunity or finding was created
    const raw = readExternal(env.db, view.id).originalText;
    expect(raw).toBe(MD); // the raw text is stored exactly as given
    expect(raw).toContain("<script>"); // and it is only ever shown as text
    expect(getReport(env.db, deps(), {}).report.metrics.firstAttemptAccuracy).toEqual(reportBefore.firstAttemptAccuracy); // the internal numbers know nothing about 62% or 35%
  });

  it("is idempotent, needs the user's decision on the RECORD, and the text can never be edited or deleted afterwards", async () => {
    env = await makeEnv();
    const a = importExternal(env.db, deps(), req());
    const again = importExternal(env.db, deps(), req());
    expect(again.created).toBe(false);
    expect(again.view.id).toBe(a.view.id);
    expect(one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM external_assessments").n).toBe(1);
    expect(importExternal(env.db, deps(), req({ assessedAt: "2026-10-29" })).created).toBe(true); // another date is another point in time

    expect(decideExternal(env.db, deps(), a.view.id, "approved")).toMatchObject({ status: "approved" });
    fails(() => decideExternal(env!.db, deps(), a.view.id, "rejected"), 409, "EXTERNAL_DECIDED");
    fails(() => decideExternal(env!.db, deps(), randomUUID(), "approved"), 404, "EXTERNAL_NOT_FOUND");
    expect(() => env!.db.prepare("UPDATE external_assessments SET original_text = 'changed'").run()).toThrow(/immutable/);
    expect(() => env!.db.prepare("UPDATE external_assessments SET status = 'draft'").run()).toThrow(/immutable|once/);
    expect(() => env!.db.prepare("DELETE FROM external_assessments").run()).toThrow(/append-only/);
    const list = listExternal(env.db);
    expect(list.series.map((s) => s.assessedAt)).toEqual(["2026-10-28", "2026-10-29"]); // a time series, each point on its own
    expect(list.note).toMatch(/not by adding percentages/);
  });

  it("refuses oversize, malformed, wrong-shape and future-dated reports; JSON reports use the same normalisation", async () => {
    env = await makeEnv();
    fails(() => importExternal(env!.db, deps(), req({ text: "x".repeat(1024 * 1024 + 1) })), 413, "EXTERNAL_TOO_LARGE");
    fails(() => importExternal(env!.db, deps(), req({ format: "json", text: "{not json" })), 422, "EXTERNAL_INVALID");
    fails(() => importExternal(env!.db, deps(), req({ format: "json", text: JSON.stringify({ measures: [{ label: "x", bonus: 1 }] }) })), 422, "EXTERNAL_INVALID");
    fails(() => importExternal(env!.db, deps(), req({ assessedAt: "2099-01-01" })), 422, "EXTERNAL_INVALID");
    fails(() => importExternal(env!.db, deps(), req({ assessedAt: "last tuesday" })), 422, "EXTERNAL_INVALID");
    fails(() => importExternal(env!.db, deps(), { ...req(), extra: 1 }), 400, "VALIDATION_ERROR");
    expect(one<{ n: number }>(env.db, "SELECT COUNT(*) AS n FROM external_assessments").n).toBe(0);
    const j = importExternal(env.db, deps(), req({ format: "json", text: JSON.stringify({ measures: [{ label: "Articles", value: 62, unit: "%" }, { label: "Fluency", note: "good pace" }], limitations: ["15 minute sample"] }) }));
    expect(j.view.normalized.assertions.map((a) => [a.kind, a.percent])).toEqual([["reported_value", 62], ["note", null]]);
    expect(j.view.normalized.limitations).toEqual(["15 minute sample"]);
  });
});

describe("bulk review of AI findings (finding-review-v1)", () => {
  async function withFindings() {
    env = await makeEnv();
    const modelId = upsertModelVersion(env.db, randomUUID, { tag: "qwen3:8b", digest: "e".repeat(64), runtime: "ollama", runtimeVersion: "0.40", parameters: {} });
    const ai: Assessor = {
      assess: () => ({ verdict: "incorrect", confirmation: "tentative", source: "model", rationale: "AI draft", modelVersionId: modelId, findings: [SKILL_B, SKILL_C].map((s) => ({ skillId: s, fragmentStart: 0, fragmentEnd: 3, correction: "fix", explanationRu: "возможная ошибка", findingType: "grammar" as const, verdict: "tentative" as const, confidence: 0.9, modelVersionId: modelId })) }),
    };
    const rev = makeRevision(env, { type: "choose_form", dimension: "recognition" });
    const sid = makeSession(env);
    const slot = makeSlot(env, sid, rev, 0);
    addEvent(env, sid, slot, "reveal");
    recordAttempt(env.db, { ...env.deps, assessor: ai, outbox: NullOutbox }, { slotId: slot, submissionId: randomUUID(), answer: ["b"], inputMode: "text" });
    return findingsForReview(env.db);
  }
  const manifest = (items: Array<Record<string, unknown>>, reviewer = "agent:strong-reviewer@1") => ({ schema_version: "finding-review-v1", reviewer, review_version: "pass-1", items });
  const item = (f: { finding_id: string; source_hash: string; expected_sequence: number }, verdict: string, reason = "checked") => ({ finding_id: f.finding_id, source_hash: f.source_hash, expected_sequence: f.expected_sequence, verdict, reason });

  it("exports tentative findings with the three values a manifest must echo, then applies a manifest in one go; history is kept", async () => {
    const f = await withFindings();
    expect(f).toHaveLength(2);
    expect(f.every((x) => x.status === "tentative" && x.expected_sequence === 0 && /^[0-9a-f]{64}$/.test(x.source_hash))).toBe(true);
    expect(f[0]).toMatchObject({ model: "qwen3:8b", prompt: expect.any(String), answer: { kind: "options" } });
    const wm0 = currentWatermarks(env!.db);

    const r = importFindingReviews(env!.db, deps(), manifest([item(f[0]!, "rejected", "not an error in standard English"), item(f[1]!, "confirmed", "agree")]));
    expect(r).toMatchObject({ recorded: 2, byVerdict: { rejected: 1, confirmed: 1 }, reviewer: "agent:strong-reviewer@1" });
    const list = listFindings(env!.db, { asOf: new Date(env!.clock.current.getTime() + 1000).toISOString(), watermarks: currentWatermarks(env!.db) });
    const byId = new Map(list.map((x) => [x.findingId, x]));
    expect(byId.get(f[0]!.finding_id)).toMatchObject({ originalStatus: "tentative", effectiveStatus: "rejected" });
    expect(byId.get(f[1]!.finding_id)).toMatchObject({ originalStatus: "tentative", effectiveStatus: "confirmed" });
    expect(byId.get(f[0]!.finding_id)!.history[0]).toMatchObject({ reviewer: "agent:strong-reviewer@1", reason: "not an error in standard English" });
    // the old state is still replayable, and the raw answer and the finding itself are untouched
    expect(listFindings(env!.db, { asOf: new Date(env!.clock.current.getTime() + 1000).toISOString(), watermarks: wm0 }).every((x) => x.effectiveStatus === "tentative")).toBe(true);
    expect(one<{ n: number }>(env!.db, "SELECT COUNT(*) AS n FROM error_events").n).toBe(2);
    expect(findingsForReview(env!.db)).toHaveLength(0); // nothing tentative is left
    expect(findingsForReview(env!.db, { status: "rejected" })).toHaveLength(1);
  });

  it("is all-or-nothing: a stale hash, stale sequence, duplicate, unknown id or bad reviewer refuses everything", async () => {
    const f = await withFindings();
    const n = () => one<{ n: number }>(env!.db, "SELECT COUNT(*) AS n FROM finding_review_events").n;
    const stale = fails(() => importFindingReviews(env!.db, deps(), manifest([item(f[0]!, "rejected"), { ...item(f[1]!, "rejected"), source_hash: "0".repeat(64) }])), 409, "FINDING_REVIEW_REFUSED");
    expect(JSON.stringify(stale.details)).toContain("STALE_HASH");
    expect(n()).toBe(0); // the valid first item was NOT recorded
    expect(JSON.stringify(fails(() => importFindingReviews(env!.db, deps(), manifest([item(f[0]!, "rejected"), item(f[0]!, "confirmed")])), 409, "FINDING_REVIEW_REFUSED").details)).toContain("DUPLICATE_ITEM");
    expect(JSON.stringify(fails(() => importFindingReviews(env!.db, deps(), manifest([{ ...item(f[0]!, "rejected"), finding_id: randomUUID() }])), 409, "FINDING_REVIEW_REFUSED").details)).toContain("FINDING_NOT_FOUND");
    fails(() => importFindingReviews(env!.db, deps(), manifest([item(f[0]!, "rejected")], "somebody")), 422, "REVIEWER_INVALID");
    fails(() => importFindingReviews(env!.db, deps(), manifest([])), 400, "VALIDATION_ERROR");
    fails(() => importFindingReviews(env!.db, deps(), manifest([item(f[0]!, "tentative")])), 400, "VALIDATION_ERROR"); // a review cannot say "still tentative"
    importFindingReviews(env!.db, deps(), manifest([item(f[0]!, "rejected")]));
    // the same manifest again names an old sequence: it conflicts instead of overwriting
    expect(JSON.stringify(fails(() => importFindingReviews(env!.db, deps(), manifest([item(f[0]!, "confirmed")])), 409, "FINDING_REVIEW_REFUSED").details)).toContain("STALE_SEQUENCE");
    expect(n()).toBe(1);
  });

  it("works over HTTP (CSRF-protected) for both external reports and finding manifests", async () => {
    const f = await withFindings();
    const port = await freePort();
    app = await buildApp({ config: testConfig(env!.scratch.root, port), db: env!.db, instanceId: "i", startedAt: "2026-01-01T00:00:00Z", shutdownToken: "t", onShutdown: () => {}, csrfSecret: Buffer.alloc(32, 5), attempts: { now: () => new Date(env!.clock.current), newId: randomUUID } as never });
    const host = `127.0.0.1:${port}`;
    const b = await app.inject({ method: "GET", url: "/api/v1/session", headers: { host } });
    const csrf = SessionBootstrapSchema.parse(b.json()).csrfToken;
    const cookie = String(b.headers["set-cookie"]).split(";")[0]!;
    const post = (u: string, body: unknown, ok = true) => app!.inject({ method: "POST", url: u, payload: body as object, headers: { host, origin: `http://${host}`, cookie, "x-csrf-token": ok ? csrf : "" } });

    expect((await post("/api/v1/external-assessments/import", req(), false)).statusCode).toBe(403);
    const imp = await post("/api/v1/external-assessments/import", req());
    expect(imp.statusCode).toBe(201);
    const view = imp.json() as { id: string; status: string; normalized: { assertions: unknown[] } };
    expect(view.status).toBe("draft");
    expect((await post("/api/v1/external-assessments/import", req())).statusCode).toBe(200); // the same report: the same record
    expect((await post("/api/v1/external-assessments/import", req({ text: "x".repeat(1024 * 1024 + 10) }))).statusCode).toBe(413);
    expect(((await post(`/api/v1/external-assessments/${view.id}/confirm`, {})).json() as { status: string }).status).toBe("approved");
    expect((await post(`/api/v1/external-assessments/${view.id}/reject`, {})).statusCode).toBe(409);
    const got = (await app.inject({ method: "GET", url: `/api/v1/external-assessments/${view.id}`, headers: { host } })).json() as { originalText: string };
    expect(got.originalText).toBe(MD);

    const exp = (await app.inject({ method: "GET", url: "/api/v1/analytics/findings/for-review", headers: { host } })).json() as { findings: Array<{ finding_id: string; source_hash: string; expected_sequence: number }> };
    expect(exp.findings).toHaveLength(2);
    const bad = await post("/api/v1/analytics/findings/review-import", manifest([{ ...item(f[0]!, "rejected"), source_hash: "1".repeat(64) }]));
    expect(bad.statusCode).toBe(409);
    expect(ErrorEnvelopeSchema.parse(bad.json()).error.code).toBe("FINDING_REVIEW_REFUSED");
    const ok = await post("/api/v1/analytics/findings/review-import", manifest(exp.findings.map((x) => item(x, "rejected"))));
    expect(ok.statusCode).toBe(201);
    expect(rows(env!.db, "SELECT 1 FROM finding_review_events")).toHaveLength(2);
  });
});
