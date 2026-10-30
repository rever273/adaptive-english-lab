import type { FastifyInstance } from "fastify";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Db } from "../db/open.js";
import { ApiError } from "../errors.js";
import { decideExternal, importExternal, listExternal, readExternal } from "../domain/external-assessments/external.js";
import { findingsForReview, importFindingReviews } from "../domain/reports/findingReview.js";
import { EXPORT_FILES, writeExport, type ExportFile } from "../domain/reports/export.js";
import { currentWatermarks } from "../domain/reports/facts.js";
import { discoveryAudit, listFindings } from "../domain/reports/findings.js";
import { defaultAsOf, getReport, listReports, readReport, DEFAULT_TIMEZONE } from "../domain/reports/report.js";

const CohortQuery = z
  .object({
    asOf: z.string().min(1).max(40).optional(),
    timezone: z.string().min(1).max(64).default(DEFAULT_TIMEZONE),
    criterionVersion: z.string().min(1).max(40).default("rubric-v1"),
    difficulty: z.enum(["A2", "B1", "B2", "C1"]).default("B2"),
    protocol: z.enum(["practice", "diagnostic-v1"]).default("practice"),
    reportId: z.string().min(1).max(64).optional(),
  })
  .strict();
const ExportBody = CohortQuery.omit({ reportId: true }).extend({ reportId: z.string().min(1).max(64).optional() }).strict();

const parse = <T>(schema: z.ZodType<T>, v: unknown): T => {
  const r = schema.safeParse(v);
  if (!r.success) throw new ApiError(400, "VALIDATION_ERROR", "Request is invalid", r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  return r.data;
};

/** Reports, AI-detected findings and exports. Read-mostly: the only writes are saved reports (derived) and export files under the data root. */
export function registerReportRoutes(app: FastifyInstance, db: Db, deps: { now: () => Date; newId?: () => string; exportsRoot: string }): void {
  app.get("/api/v1/analytics/report", async (req) => {
    const q = parse(CohortQuery, req.query);
    if (q.reportId) return readReport(db, q.reportId); // a saved report exactly as it was computed
    return getReport(db, deps, { asOf: q.asOf, timezone: q.timezone, cohort: { criterionVersion: q.criterionVersion, difficulty: q.difficulty, protocol: q.protocol } });
  });

  app.get("/api/v1/analytics/reports", async () => ({ reports: listReports(db) }));

  // AI-detected findings (never counted as verified mistakes) and the discovery audit
  app.get("/api/v1/analytics/findings", async (req) => {
    const q = parse(z.object({ asOf: z.string().min(1).max(40).optional(), limit: z.coerce.number().int().min(1).max(1000).default(200) }).strict(), req.query);
    const asOf = new Date(q.asOf ?? defaultAsOf(db, deps.now())).toISOString();
    const wm = currentWatermarks(db);
    const taxonomyId = (db.prepare("SELECT id FROM taxonomy_versions ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as { id: string }).id;
    return { asOf, watermarks: wm, findings: listFindings(db, { asOf, watermarks: wm, limit: q.limit }), discovery: discoveryAudit(db, { asOf, taxonomyId, watermarks: wm }) };
  });

  // bulk review of AI findings by an audited manifest (finding-review-v1): all or nothing, hash + sequence checked
  app.get("/api/v1/analytics/findings/for-review", async (req) => {
    const q = parse(z.object({ status: z.enum(["tentative", "uncertain", "confirmed", "rejected", "disputed"]).default("tentative"), limit: z.coerce.number().int().min(1).max(500).default(100) }).strict(), req.query);
    return { schema_version: "finding-review-export-v1", findings: findingsForReview(db, q) };
  });
  app.post("/api/v1/analytics/findings/review-import", async (req, reply) => reply.code(201).send(importFindingReviews(db, deps, req.body)));

  // outside reports: a separate series, preview first, the user confirms the RECORD; nothing internal changes
  app.post("/api/v1/external-assessments/import", { bodyLimit: 1_500_000 }, async (req, reply) => {
    const r = importExternal(db, deps, req.body);
    return reply.code(r.created ? 201 : 200).send({ ...r.view, created: r.created });
  });
  app.get("/api/v1/external-assessments", async () => listExternal(db));
  app.get<{ Params: { id: string } }>("/api/v1/external-assessments/:id", async (req) => readExternal(db, req.params.id));
  app.post<{ Params: { id: string } }>("/api/v1/external-assessments/:id/confirm", async (req) => decideExternal(db, deps, req.params.id, "approved"));
  app.post<{ Params: { id: string } }>("/api/v1/external-assessments/:id/reject", async (req) => decideExternal(db, deps, req.params.id, "rejected"));

  app.post("/api/v1/exports", async (req, reply) => {
    const b = parse(ExportBody, req.body ?? {});
    const saved = b.reportId ? readReport(db, b.reportId) : getReport(db, deps, { asOf: b.asOf, timezone: b.timezone, cohort: { criterionVersion: b.criterionVersion, difficulty: b.difficulty, protocol: b.protocol } });
    const out = writeExport(db, deps.exportsRoot, saved, saved.report.asOf);
    return reply.code(201).send({ reportId: saved.id, inputHash: saved.inputHash, ...out });
  });

  // download of a file this server generated: both path parts are checked against an allowlist, never joined from free text
  app.get<{ Params: { dir: string; file: string } }>("/api/v1/exports/:dir/:file", async (req, reply) => {
    const { dir, file } = req.params;
    if (!/^report-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/.test(dir) || !(EXPORT_FILES as readonly string[]).includes(file)) throw new ApiError(404, "EXPORT_NOT_FOUND", "Unknown export file");
    const full = path.join(deps.exportsRoot, dir, file as ExportFile);
    if (!existsSync(full)) throw new ApiError(404, "EXPORT_NOT_FOUND", "Unknown export file");
    const type = file.endsWith(".csv") ? "text/csv; charset=utf-8" : file.endsWith(".json") ? "application/json" : "text/markdown; charset=utf-8";
    return reply.header("content-type", type).header("content-disposition", `attachment; filename="${file}"`).send(createReadStream(full));
  });
}
