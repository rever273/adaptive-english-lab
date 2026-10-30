import { createHash } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Db } from "../../db/open.js";
import type { Watermarks } from "./facts.js";
import { discoveryAudit, isAiDetected, listFindings, type FindingView } from "./findings.js";
import { REPORT_VERSION, type Ratio } from "./metrics.js";
import type { SavedReport } from "./report.js";

/** Spreadsheet-safe CSV cell: quotes, newlines and delimiters escaped, and a leading = + - @ (or tab/CR) neutralised so a cell can never be a formula. */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const csv = (header: string[], rows: unknown[][]): string => [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

export const EXPORT_FILES = ["attempts.csv", "opportunities.csv", "errors.csv", "findings.csv", "summary.csv", "report.json", "report.md"] as const;
export type ExportFile = (typeof EXPORT_FILES)[number];

const rate = (r: Ratio): string => (r.rate === null ? "unknown" : r.rate.toFixed(4));

function attemptsCsv(db: Db, w: Watermarks, asOf: string): string {
  const rows = db
    .prepare(
      `WITH la AS (SELECT a.*, row_number() OVER (PARTITION BY a.attempt_id ORDER BY a.sequence DESC) AS rn FROM assessment_revisions a WHERE a.rowid <= @w)
       SELECT t.id, t.slot_id, s.id, s.purpose, er.id, er.type, er.dimension, er.difficulty, t.submitted_at, t.local_date, t.timezone, t.input_mode, t.attempt_no, t.first_attempt,
              t.hints_before, t.answer_seen_before, t.idk, t.criterion_version, la.verdict, la.confirmation, la.source
         FROM attempts t JOIN la ON la.attempt_id = t.id AND la.rn = 1 JOIN session_slots ss ON ss.id = t.slot_id JOIN sessions s ON s.id = ss.session_id JOIN exercise_revisions er ON er.id = ss.exercise_revision_id
        WHERE t.submitted_at <= @asOf ORDER BY t.submitted_at, t.id`,
    )
    .raw()
    .all({ w: w.assessments, asOf }) as unknown[][];
  return csv(["attempt_id", "slot_id", "session_id", "session_purpose", "exercise_revision_id", "format", "dimension", "difficulty", "submitted_at_utc", "local_date", "timezone", "input_mode", "attempt_no", "first_attempt", "hints_before", "answer_seen_before", "idk", "criterion_version", "latest_verdict", "latest_confirmation", "assessment_source"], rows);
}

function opportunitiesCsv(db: Db, w: Watermarks, asOf: string): string {
  const rows = db
    .prepare(
      `WITH la AS (SELECT a.id AS id, a.attempt_id AS attempt_id FROM assessment_revisions a WHERE a.rowid <= @w AND a.sequence = (SELECT MAX(b.sequence) FROM assessment_revisions b WHERE b.attempt_id = a.attempt_id AND b.rowid <= @w))
       SELECT o.id, o.assessment_id, ar.attempt_id, sr.skill_id, o.dimension, o.opportunity_type, o.target, o.independent, o.reliability, o.result, (o.assessment_id IN (SELECT id FROM la)) AS from_latest_assessment
         FROM skill_opportunities o JOIN assessment_revisions ar ON ar.id = o.assessment_id AND ar.rowid <= @w JOIN skill_revisions sr ON sr.id = o.skill_revision_id
         JOIN attempts t ON t.id = ar.attempt_id AND t.submitted_at <= @asOf ORDER BY t.submitted_at, o.id`,
    )
    .raw()
    .all({ w: w.assessments, asOf }) as unknown[][];
  return csv(["opportunity_id", "assessment_id", "attempt_id", "skill_id", "dimension", "opportunity_type", "target", "independent", "reliability", "result", "from_latest_assessment"], rows);
}

/** errors.csv = CONFIRMED findings only (spec/09); AI-detected, unverified findings live in findings.csv and are never mixed in */
function errorsCsv(findings: FindingView[]): string {
  return csv(
    ["finding_id", "attempt_id", "skill_id", "finding_type", "confirmation", "correction", "context_id"],
    findings.filter((f) => f.effectiveStatus === "confirmed").map((f) => [f.findingId, f.attemptId, f.skillId, f.findingType, f.effectiveStatus, f.correction, f.contextId]),
  );
}

function findingsCsv(findings: FindingView[]): string {
  const rows: unknown[][] = [];
  for (const f of findings) {
    const last = f.history[f.history.length - 1];
    rows.push([f.findingId, f.attemptId, f.skillId, f.findingType, f.originalStatus, f.effectiveStatus, f.confidence, f.span.start, f.span.end, f.correction, f.inputMode, f.transcriptEdited, f.contextId, f.provenance.model, f.provenance.digest, f.provenance.runtime, f.provenance.prompt, f.history.length, last?.reviewer ?? "", last?.reason ?? "", f.isLatestAnalysis]);
  }
  return csv(["finding_id", "attempt_id", "skill_id", "finding_type", "original_status", "effective_status", "confidence", "span_start_cp", "span_end_cp", "correction", "input_mode", "transcript_edited", "context_id", "model_tag", "model_digest", "runtime", "prompt", "review_steps", "last_reviewer", "last_reason", "is_latest_analysis"], rows);
}

function summaryCsv(s: SavedReport): string {
  const m = s.report.metrics;
  const c = `${s.report.cohort.criterionVersion}|${s.report.cohort.difficulty}|${s.report.cohort.protocol}`;
  const line = (name: string, r: Ratio) => [name, c, r.numerator, r.denominator, rate(r), r.wilson ? r.wilson.low.toFixed(4) : "", r.wilson ? r.wilson.high.toFixed(4) : "", r.lowN, s.id];
  return csv(
    ["metric", "cohort", "numerator", "denominator", "rate", "wilson95_low", "wilson95_high", "low_n", "report_id"],
    [
      line("first_attempt_accuracy_unaided", m.firstAttemptAccuracy),
      line("practice_accuracy_incl_assisted_retries", m.practiceAccuracy),
      line("heldout_accuracy", m.heldoutAccuracy),
      line("delayed_retention", m.delayedRetention),
      line("error_recurrence", m.errorRecurrence.rate),
      line("idk_per_first_attempt", m.idk),
      line("skip_per_revealed_slot", m.skip),
      ...(["recognition", "correction", "production"] as const).map((d) => line(`first_attempt_accuracy_${d}`, s.report.byDimension[d])),
    ],
  );
}

function markdown(s: SavedReport, findings: FindingView[], disc: ReturnType<typeof discoveryAudit>): string {
  const r = s.report;
  const m = r.metrics;
  const L = (name: string, x: Ratio) => `- ${name}: ${x.denominator === 0 ? "unknown (no data)" : `${x.numerator}/${x.denominator} = ${(x.rate! * 100).toFixed(1)}%`}${x.wilson ? ` (95% Wilson ${(x.wilson.low * 100).toFixed(1)}-${(x.wilson.high * 100).toFixed(1)}%)` : ""}${x.lowN && x.denominator > 0 ? " - low n, not interpreted" : ""}`;
  return [
    `# English Lab report ${s.id}`,
    ``,
    `- version ${REPORT_VERSION}; as of ${r.asOf} (${r.timezone}); cohort ${r.cohort.criterionVersion} / ${r.cohort.difficulty} / ${r.cohort.protocol}`,
    `- input hash ${s.inputHash}; event watermarks ${JSON.stringify(s.watermarks)}; created ${s.createdAt}`,
    ``,
    `## Verified results (confirmed, unaided first attempts unless stated)`,
    L("First-attempt accuracy", m.firstAttemptAccuracy),
    `- Assisted first attempts (separate, not unaided evidence): ${m.firstAttemptAccuracy.assisted.correct}/${m.firstAttemptAccuracy.assisted.attempts}`,
    L("Practice accuracy (includes assisted retries)", m.practiceAccuracy),
    L("Held-out accuracy", m.heldoutAccuracy),
    L("Delayed retention", m.delayedRetention),
    L("Error recurrence", m.errorRecurrence.rate),
    L("I don't know", m.idk),
    L("Skipped", m.skip),
    `- Pending (saved, not marked wrong): ${m.pending.slots} slots / ${m.pending.attempts} attempts`,
    ``,
    `## Comparison (last 28 days vs the 28 before, same cohort)`,
    r.comparison.status === "ok" ? `- current ${r.comparison.current.from}..${r.comparison.current.to}: ${r.comparison.current.firstTry.numerator}/${r.comparison.current.firstTry.denominator}; previous ${r.comparison.previous.from}..${r.comparison.previous.to}: ${r.comparison.previous.firstTry.numerator}/${r.comparison.previous.firstTry.denominator}${r.comparison.mixDiffers ? " - the format mix differs, read with care" : ""}` : `- Insufficient comparison data (needs at least 10 observations in each window). No claim of improvement is made.`,
    ``,
    `## AI-detected findings (NOT verified mistakes; not part of any number above): ${findings.filter(isAiDetected).length}`,
    ...findings.filter(isAiDetected).slice(0, 50).map((f) => `- ${f.findingId} [${f.label}] skill ${f.skillId}, attempt ${f.attemptId}, confidence ${f.confidence ?? "n/a"}, model ${f.provenance.model ?? "n/a"}`),
    ``,
    `## Discovery signal`,
    `- ${disc.enabled ? "Enabled" : disc.disabledReason}. ${disc.note}`,
    ``,
  ].join("\n");
}

export interface ExportResult {
  dir: string;
  files: Array<{ name: ExportFile; bytes: number; sha256: string }>;
}

/**
 * Writes the export bundle for a saved report into <exportsRoot>/<generated dir>/ . Names are generated here (never taken from a client), every
 * file is written to a temp name and renamed, so a reader never sees half a file. Raw rows are exported as they are; the summary reconstructs
 * from them. No audio exists to export.
 */
export function writeExport(db: Db, exportsRoot: string, saved: SavedReport, asOf: string): ExportResult {
  const w = saved.watermarks;
  const findings = listFindings(db, { asOf, watermarks: w });
  const disc = discoveryAudit(db, { asOf, taxonomyId: saved.taxonomyId, watermarks: w });
  const dirName = `report-${saved.report.asOf.slice(0, 10)}-${saved.id.slice(0, 8)}`;
  const dir = path.join(exportsRoot, dirName);
  mkdirSync(dir, { recursive: true });
  const contents: Record<ExportFile, string> = {
    "attempts.csv": attemptsCsv(db, w, asOf),
    "opportunities.csv": opportunitiesCsv(db, w, asOf),
    "errors.csv": errorsCsv(findings),
    "findings.csv": findingsCsv(findings),
    "summary.csv": summaryCsv(saved),
    "report.json": JSON.stringify({ schema_version: "report-export-v1", versions: { report: REPORT_VERSION }, run: { id: saved.id, inputHash: saved.inputHash, createdAt: saved.createdAt, watermarks: w, taxonomyId: saved.taxonomyId }, report: saved.report, findings, discovery: disc }, null, 2),
    "report.md": markdown(saved, findings, disc),
  };
  const files: ExportResult["files"] = [];
  for (const name of EXPORT_FILES) {
    const data = Buffer.from(contents[name], "utf8");
    const tmp = path.join(dir, `.${name}.tmp`);
    const final = path.join(dir, name);
    try {
      writeFileSync(tmp, data);
      renameSync(tmp, final);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
    files.push({ name, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") });
  }
  return { dir: dirName, files };
}
