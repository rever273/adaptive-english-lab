import { createHash, randomUUID } from "node:crypto";
import {
  MASTERY_V1,
  canonicalJson,
  computeComponents,
  displayScore,
  markDelayedProbes,
  summarizeSkill,
  type Dimension,
  type MasteryComponents,
  type MasteryConfig,
  type SkillSummary,
} from "@english-lab/learning";
import type { Db } from "../../db/open.js";
import { ApiError } from "../../errors.js";
import { currentWatermark, loadActivity, loadEvidence, type Cohort, type RawEvidenceRow } from "./evidence.js";

export const MASTERY_SOURCE_VERSION = "packages/learning@0.1.0";
const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export interface RunRequest {
  /** ISO-8601 UTC. Evidence after this instant is ignored; it also drives the stale label. */
  asOf: string;
  /** highest assessment_revisions.rowid to include; default = everything recorded so far */
  watermark?: number;
  cohort: Cohort;
  taxonomyId?: string;
  config?: MasteryConfig;
  now?: () => Date;
  newId?: () => string;
}

export interface MasteryRun {
  id: string;
  algorithmId: string;
  asOf: string;
  eventWatermark: number;
  inputHash: string;
  cohort: Cohort;
  /** false when an identical earlier run was reused (same inputs, same hash) */
  created: boolean;
}

export function ensureAlgorithmVersion(db: Db, cfg: MasteryConfig, now: Date): string {
  const json = canonicalJson(cfg);
  const hash = sha256(json);
  const existing = db.prepare("SELECT id, config_hash AS h FROM algorithm_versions WHERE id = ?").get(cfg.version) as { id: string; h: string } | undefined;
  if (existing) {
    if (existing.h !== hash) {
      throw new ApiError(500, "ALGORITHM_CONFIG_DRIFT", `${cfg.version} is stored with a different config; a changed formula needs a new version id`);
    }
    return existing.id;
  }
  db.prepare("INSERT INTO algorithm_versions(id, config_json, config_hash, source_version, created_at) VALUES (?,?,?,?,?)").run(cfg.version, json, hash, MASTERY_SOURCE_VERSION, now.toISOString());
  return cfg.version;
}

interface Group {
  skillId: string;
  dimension: Dimension;
  components: MasteryComponents;
}

/** Pure part of a run: group evidence, mark delayed probes, compute components. Exposed for replay tests. */
export function computeGroups(evidence: readonly RawEvidenceRow[], activity: ReadonlyMap<string, string[]>, asOf: string, cfg: MasteryConfig): Group[] {
  const bySkillDim = new Map<string, RawEvidenceRow[]>();
  for (const e of evidence) (bySkillDim.get(`${e.skillId}|${e.dimension}`) ?? bySkillDim.set(`${e.skillId}|${e.dimension}`, []).get(`${e.skillId}|${e.dimension}`)!).push(e);
  const groups: Group[] = [];
  for (const key of [...bySkillDim.keys()].sort()) {
    const rows = bySkillDim.get(key)!;
    const marked = markDelayedProbes(rows.map((r) => ({ ...r })), activity.get(key) ?? [], cfg);
    const components = computeComponents(
      marked.map((r) => ({ id: r.id, at: r.at, localDate: r.localDate, success: r.success, heldout: r.heldout, delayedProbe: r.delayedProbe, ...(r.aiChecked ? { weight: cfg.aiCheckedWeight ?? 1 } : {}) })),
      asOf,
      cfg,
    );
    groups.push({ skillId: rows[0]!.skillId, dimension: rows[0]!.dimension, components });
  }
  return groups;
}

/**
 * Computes (or replays) a mastery run (v1: confirmed evidence; v2, D65: plus AI-checked evidence at a lower weight). Identical inputs -> identical input_hash and identical snapshots, and an
 * identical earlier run is returned instead of writing a duplicate. Past runs are never modified.
 */
export function runMastery(db: Db, req: RunRequest): MasteryRun {
  const cfg = req.config ?? MASTERY_V1;
  const now = (req.now ?? (() => new Date()))();
  const newId = req.newId ?? randomUUID;
  if (Number.isNaN(Date.parse(req.asOf))) throw new ApiError(400, "VALIDATION_ERROR", "asOf must be an ISO-8601 timestamp");
  const asOf = new Date(req.asOf).toISOString();

  return db
    .transaction((): MasteryRun => {
      const taxonomyId = req.taxonomyId ?? (db.prepare("SELECT id FROM taxonomy_versions ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as { id: string }).id;
      const watermark = req.watermark ?? currentWatermark(db);
      const evidence = loadEvidence(db, { watermark, asOf, taxonomyId, cohort: req.cohort, provisional: cfg.aiCheckedWeight !== undefined });
      const activity = loadActivity(db, { watermark, asOf, taxonomyId });
      const groups = computeGroups(evidence, activity, asOf, cfg);
      const algorithmId = ensureAlgorithmVersion(db, cfg, now);
      const cfgHash = sha256(canonicalJson(cfg));
      const inputHash = sha256(
        canonicalJson({
          algorithm: algorithmId,
          configHash: cfgHash,
          asOf,
          watermark,
          taxonomyId,
          cohort: req.cohort,
          evidence: evidence.map((e) => (e.aiChecked ? [e.id, e.skillId, e.dimension, e.at, e.localDate, e.success, e.heldout, "ai"] : [e.id, e.skillId, e.dimension, e.at, e.localDate, e.success, e.heldout])),
          activity: [...activity.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
        }),
      );

      const found = db
        .prepare("SELECT id FROM analytics_runs WHERE algorithm_id = ? AND event_watermark = ? AND as_of = ? AND taxonomy_id = ? AND input_hash = ?")
        .get(algorithmId, String(watermark), asOf, taxonomyId, inputHash) as { id: string } | undefined;
      if (found) return { id: found.id, algorithmId, asOf, eventWatermark: watermark, inputHash, cohort: req.cohort, created: false };

      const id = newId();
      db.prepare("INSERT INTO analytics_runs(id, algorithm_id, event_watermark, as_of, taxonomy_id, cohort_json, input_hash, created_at) VALUES (?,?,?,?,?,?,?,?)").run(
        id,
        algorithmId,
        String(watermark),
        asOf,
        taxonomyId,
        canonicalJson(req.cohort),
        inputHash,
        now.toISOString(),
      );
      const ins = db.prepare("INSERT INTO mastery_snapshots(run_id, skill_id, dimension, score, n, days, confidence_status, components_json) VALUES (?,?,?,?,?,?,?,?)");
      for (const g of groups) {
        ins.run(id, g.skillId, g.dimension, g.components.score, g.components.n, g.components.days, g.components.status, JSON.stringify(g.components));
      }
      return { id, algorithmId, asOf, eventWatermark: watermark, inputHash, cohort: req.cohort, created: true };
    })
    .immediate();
}

export interface SkillProjection {
  skillId: string;
  dimensions: Partial<Record<Dimension, MasteryComponents & { display: number | null }>>;
  summary: SkillSummary & { display: number | null };
}

/** Reads a saved run back as per-skill rows with the R/C/P summary. Dimensions without evidence are absent (= unknown). */
export function readRun(db: Db, runId: string, cfg: MasteryConfig = MASTERY_V1): SkillProjection[] {
  const rows = db.prepare("SELECT skill_id AS skillId, dimension, components_json AS c FROM mastery_snapshots WHERE run_id = ? ORDER BY skill_id, dimension").all(runId) as Array<{
    skillId: string;
    dimension: Dimension;
    c: string;
  }>;
  const bySkill = new Map<string, SkillProjection["dimensions"]>();
  for (const r of rows) {
    const comp = JSON.parse(r.c) as MasteryComponents;
    const dims = bySkill.get(r.skillId) ?? {};
    dims[r.dimension] = { ...comp, display: displayScore(comp.score) };
    bySkill.set(r.skillId, dims);
  }
  return [...bySkill.entries()].map(([skillId, dimensions]) => {
    const s = summarizeSkill(dimensions, cfg);
    return { skillId, dimensions, summary: { ...s, display: displayScore(s.score) } };
  });
}

export function getRun(db: Db, runId: string): MasteryRun | undefined {
  const r = db.prepare("SELECT id, algorithm_id AS algorithmId, as_of AS asOf, event_watermark AS w, input_hash AS inputHash, cohort_json AS cohort FROM analytics_runs WHERE id = ?").get(runId) as
    | { id: string; algorithmId: string; asOf: string; w: string; inputHash: string; cohort: string }
    | undefined;
  return r && { id: r.id, algorithmId: r.algorithmId, asOf: r.asOf, eventWatermark: Number(r.w), inputHash: r.inputHash, cohort: JSON.parse(r.cohort) as Cohort, created: false };
}
