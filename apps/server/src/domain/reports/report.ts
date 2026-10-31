import { createHash, randomUUID } from "node:crypto";
import { MASTERY_V1, canonicalJson } from "@english-lab/learning";
import type { Db } from "../../db/open.js";
import { ApiError } from "../../errors.js";
import { loadActivity, loadEvidence } from "../analytics/evidence.js";
import { localDateIn } from "../attempts/canonical.js";
import { currentWatermarks, loadAttemptFacts, loadSlotFacts, type ReportCohort, type Watermarks } from "./facts.js";
import { vocabularyTotals } from "../vocabulary/repository.js";
import { MIN_COMPARISON_N, REPORT_VERSION, buildMetrics, type Report } from "./metrics.js";

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
/** reports are dated in this computer's time zone unless a request names one */
export const DEFAULT_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
export const DEFAULT_COHORT: ReportCohort = { criterionVersion: "rubric-v1", difficulty: "B2", protocol: "practice" };
export const REPORT_CONFIG_HASH = sha256(canonicalJson({ version: REPORT_VERSION, minComparisonN: MIN_COMPARISON_N, wilsonZ: MASTERY_V1.wilsonZ, delayedProbeMinDays: MASTERY_V1.delayedProbeMinDays }));

export interface ReportRequest {
  asOf?: string;
  timezone?: string;
  cohort?: Partial<ReportCohort>;
  /** replay at an older state of the history (default: everything recorded so far) */
  watermarks?: Watermarks;
}
export interface SavedReport {
  id: string;
  /** true when an identical earlier report was returned instead of writing another one */
  reused: boolean;
  inputHash: string;
  createdAt: string;
  watermarks: Watermarks;
  taxonomyId: string;
  report: Report;
}
interface Deps {
  now: () => Date;
  newId?: () => string;
}

function progressOf(db: Db): { sessionId: string | null; closed: number; total: number; completedBlueprints: number; publishedBlueprints: number } {
  const s = (db.prepare("SELECT id FROM sessions s WHERE status = 'active' AND NOT EXISTS (SELECT 1 FROM vocabulary_sessions v WHERE v.session_id = s.id) ORDER BY created_at DESC LIMIT 1").get() ?? db.prepare("SELECT id FROM sessions s WHERE NOT EXISTS (SELECT 1 FROM vocabulary_sessions v WHERE v.session_id = s.id) ORDER BY created_at DESC, rowid DESC LIMIT 1").get()) as { id: string } | undefined;
  let closed = 0;
  let total = 0;
  if (s) {
    total = (db.prepare("SELECT COUNT(*) AS n FROM session_slots WHERE session_id = ?").get(s.id) as { n: number }).n;
    closed = (db.prepare("SELECT COUNT(*) AS n FROM session_slots ss WHERE ss.session_id = ? AND EXISTS (SELECT 1 FROM session_events e WHERE e.slot_id = ss.id AND e.event_type IN ('skip','continue'))").get(s.id) as { n: number }).n;
  }
  const published = (db.prepare("SELECT COUNT(*) AS n FROM blueprint_revisions br WHERE br.revision = (SELECT MAX(x.revision) FROM blueprint_revisions x WHERE x.blueprint_id = br.blueprint_id) AND br.status IN ('approved','published')").get() as { n: number }).n;
  const completed = (db.prepare("SELECT COUNT(DISTINCT br.blueprint_id) AS n FROM sessions s JOIN blueprint_revisions br ON br.id = s.blueprint_revision_id WHERE s.status = 'completed' AND s.purpose = 'practice'").get() as { n: number }).n;
  return { sessionId: s?.id ?? null, closed, total, completedBlueprints: completed, publishedBlueprints: published };
}

/**
 * Default time of a report: the moment of the latest recorded event, so asking again with no new data returns the very same saved report
 * (and a report never depends on the wall clock). An empty history falls back to the current hour.
 */
export function defaultAsOf(db: Db, now: Date): string {
  const m = (db.prepare("SELECT MAX(x) AS m FROM (SELECT MAX(submitted_at) AS x FROM attempts UNION ALL SELECT MAX(server_at) FROM session_events UNION ALL SELECT MAX(created_at) FROM assessment_revisions UNION ALL SELECT MAX(created_at) FROM finding_review_events)").get() as { m: string | null }).m;
  if (m) return new Date(m).toISOString();
  const hour = new Date(now);
  hour.setUTCMinutes(0, 0, 0);
  return hour.toISOString();
}

/**
 * Builds (or replays) a report. Everything in it is derived from raw events at the stored watermarks; an identical request returns the saved
 * report, and any new attempt, assessment correction or review makes a NEW report. Old reports stay readable. Models never contribute a number.
 */
export function getReport(db: Db, deps: Deps, req: ReportRequest = {}): SavedReport {
  const tz = req.timezone ?? DEFAULT_TIMEZONE;
  try {
    localDateIn(tz, deps.now());
  } catch {
    throw new ApiError(422, "TIMEZONE_INVALID", `Unknown time zone ${tz}`);
  }
  const cohort: ReportCohort = { ...DEFAULT_COHORT, ...req.cohort } as ReportCohort;
  const asOfRaw = req.asOf ?? defaultAsOf(db, deps.now());
  if (Number.isNaN(Date.parse(asOfRaw))) throw new ApiError(400, "VALIDATION_ERROR", "asOf must be an ISO-8601 timestamp");
  const asOf = new Date(asOfRaw).toISOString();

  return db
    .transaction((): SavedReport => {
      const wm = req.watermarks ?? currentWatermarks(db);
      const taxonomyId = (db.prepare("SELECT id FROM taxonomy_versions ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as { id: string }).id;
      const facts = loadAttemptFacts(db, { watermark: wm.assessments, asOf, cohort });
      const allFacts = loadAttemptFacts(db, { watermark: wm.assessments, asOf, cohort: null });
      const slots = loadSlotFacts(db, { sessionEventWatermark: wm.sessionEvents, asOf, cohort });
      const evidence = loadEvidence(db, { watermark: wm.assessments, asOf, taxonomyId, cohort });
      const activity = loadActivity(db, { watermark: wm.assessments, asOf, taxonomyId });
      const contexts = new Map(
        (db.prepare("SELECT o.id AS id, er.context_id AS ctx FROM skill_opportunities o JOIN assessment_revisions a ON a.id = o.assessment_id JOIN attempts t ON t.id = a.attempt_id JOIN session_slots ss ON ss.id = t.slot_id JOIN exercise_revisions er ON er.id = ss.exercise_revision_id").all() as Array<{ id: string; ctx: string }>).map((r) => [r.id, r.ctx]),
      );
      const modelTags = new Map((db.prepare("SELECT id, tag || '@' || substr(digest, 1, 12) AS k FROM model_versions").all() as Array<{ id: string; k: string }>).map((r) => [r.id, r.k]));
      const progress = progressOf(db);
      const report = buildMetrics({
        asOf,
        asOfLocalDate: localDateIn(tz, new Date(asOf)),
        timezone: tz,
        cohort,
        facts,
        allFacts,
        slots,
        evidence,
        activity,
        contextOf: (id) => contexts.get(id) ?? null,
        progress,
        modelTags,
        vocabulary: vocabularyTotals(db),
      });
      const inputHash = sha256(
        canonicalJson({
          version: REPORT_VERSION,
          config: REPORT_CONFIG_HASH,
          asOf,
          tz,
          wm,
          taxonomyId,
          cohort,
          facts: allFacts.map((f) => [f.attemptId, f.verdict, f.confirmation, f.assessmentSource, f.modelVersionId]),
          slots: slots.map((s) => [s.slotId, s.revealed, s.skipped, s.closed]),
          progress,
          vocabulary: vocabularyTotals(db),
        }),
      );
      const found = db.prepare("SELECT id, created_at AS createdAt, report_json AS json FROM analytics_reports WHERE input_hash = ?").get(inputHash) as { id: string; createdAt: string; json: string } | undefined;
      if (found) return { id: found.id, reused: true, inputHash, createdAt: found.createdAt, watermarks: wm, taxonomyId, report: JSON.parse(found.json) as Report };
      const id = (deps.newId ?? randomUUID)();
      const createdAt = deps.now().toISOString();
      db.prepare("INSERT INTO analytics_reports(id, report_version, config_hash, as_of, timezone, event_watermark, taxonomy_id, cohort_json, input_hash, report_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(id, REPORT_VERSION, REPORT_CONFIG_HASH, asOf, tz, JSON.stringify(wm), taxonomyId, canonicalJson(cohort), inputHash, JSON.stringify(report), createdAt);
      return { id, reused: false, inputHash, createdAt, watermarks: wm, taxonomyId, report };
    })
    .immediate();
}

export function listReports(db: Db): Array<{ id: string; asOf: string; createdAt: string; cohort: unknown; inputHash: string }> {
  return (db.prepare("SELECT id, as_of AS asOf, created_at AS createdAt, cohort_json AS cohort, input_hash AS inputHash FROM analytics_reports ORDER BY created_at DESC, rowid DESC LIMIT 100").all() as Array<{ id: string; asOf: string; createdAt: string; cohort: string; inputHash: string }>).map((r) => ({ ...r, cohort: JSON.parse(r.cohort) as unknown }));
}

export function readReport(db: Db, id: string): SavedReport {
  const r = db.prepare("SELECT id, created_at AS createdAt, input_hash AS inputHash, event_watermark AS wm, taxonomy_id AS taxonomyId, report_json AS json FROM analytics_reports WHERE id = ?").get(id) as { id: string; createdAt: string; inputHash: string; wm: string; taxonomyId: string; json: string } | undefined;
  if (!r) throw new ApiError(404, "REPORT_NOT_FOUND", "Unknown report");
  return { id: r.id, reused: true, inputHash: r.inputHash, createdAt: r.createdAt, watermarks: JSON.parse(r.wm) as Watermarks, taxonomyId: r.taxonomyId, report: JSON.parse(r.json) as Report };
}
