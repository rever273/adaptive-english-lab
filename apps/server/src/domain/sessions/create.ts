import { createHash } from "node:crypto";
import type { CreateSessionRequest, CreateSessionResponse } from "@english-lab/contracts";
import {
  DEFAULT_QUOTAS,
  DISCOVERY_V1,
  SELECTION_VERSION,
  canonicalJson,
  clampMultiplier,
  discoveryProbeLimit,
  hardViolations,
  scaleQuotas,
  selectSession,
  type Candidate,
  type DiscoveryConfig,
  type SelectionResult,
} from "@english-lab/learning";
import type { Db } from "../../db/open.js";
import { ApiError } from "../../errors.js";
import { runDiscovery } from "../analytics/discoveryAdapter.js";
import { localDateIn } from "../attempts/canonical.js";
import { loadBlockedFingerprints, loadCandidates, type BankCandidate } from "./bank.js";
import { PLAYABLE_BLUEPRINT_STATUSES, loadBlueprint, loadPlan, loadSettings, type BlueprintPolicy, type SessionDeps } from "./policy.js";
import { loadPriorities } from "./priorities.js";
import { getSnapshot } from "./snapshot.js";

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export interface CreateOptions {
  /** discovery-v1 configuration; the shipped default has no qualified model, so the signal is off */
  discovery?: DiscoveryConfig;
}

export function ensureSelectionVersion(db: Db, deps: SessionDeps, discovery: DiscoveryConfig): string {
  const cfg = { version: SELECTION_VERSION, defaultQuotas: DEFAULT_QUOTAS, familyCap: 0.35, formatCap: 0.4, discovery: discovery.version };
  const json = canonicalJson(cfg);
  const hash = sha256(json);
  const row = db.prepare("SELECT config_hash AS h FROM algorithm_versions WHERE id = ?").get(SELECTION_VERSION) as { h: string } | undefined;
  if (row) return SELECTION_VERSION; // the shape of the config is fixed per version id; a different shape needs a new id
  db.prepare("INSERT INTO algorithm_versions(id, config_json, config_hash, source_version, created_at) VALUES (?,?,?,?,?)").run(SELECTION_VERSION, json, hash, "packages/learning@0.1.0", deps.now().toISOString());
  return SELECTION_VERSION;
}

/** What the allocator needs from the bank, reused by readiness simulation. */
export function solveForBank(args: {
  n: number;
  weakRatio: number;
  voiceTarget: 0 | 1 | 2;
  policy: BlueprintPolicy;
  seed: string;
  candidates: readonly Candidate[];
  blocked: ReadonlySet<string>;
  priority: (skill: string, dimension: "recognition" | "correction" | "production", cohort: string) => number;
  planMultiplier: (skill: string) => number;
  discoveryBonus: Readonly<Record<string, number>>;
}): { result: SelectionResult; quotas: ReturnType<typeof scaleQuotas> } {
  const quotas = scaleQuotas(args.policy.quotas, args.n);
  const exploreSlots = args.n - Math.round(args.n * args.weakRatio);
  const result = selectSession({
    n: args.n,
    weakRatio: args.weakRatio,
    voiceTarget: args.voiceTarget,
    seed: args.seed,
    quotas,
    readingBlocks: args.policy.readingBlocks,
    candidates: args.candidates,
    blocked: args.blocked,
    priority: args.priority,
    planMultiplier: args.planMultiplier,
    discovery: { bonusBySkill: args.discoveryBonus, limit: discoveryProbeLimit(args.n, exploreSlots) },
  });
  return { result, quotas };
}

/**
 * Allocates one practice snapshot in a single BEGIN IMMEDIATE transaction: select -> re-validate every hard rule -> persist
 * session + slots + reservations of ALL sentence units + the scheduling decision. Either everything is stored or nothing,
 * so two concurrent requests can never hand out the same sentence. Nothing is exposed yet (that happens at first reveal).
 */
export function createPracticeSession(db: Db, deps: SessionDeps, req: CreateSessionRequest, opts: CreateOptions = {}): CreateSessionResponse {
  if (req.purpose !== "practice") {
    throw new ApiError(422, "PURPOSE_NOT_AVAILABLE", "Diagnostic and held-out sessions arrive with TASK_013; only practice sessions exist now");
  }
  if (!req.blueprintRevisionId) throw new ApiError(422, "BLUEPRINT_REQUIRED", "A practice session needs blueprintRevisionId");
  const discoveryCfg = opts.discovery ?? DISCOVERY_V1;

  return db
    .transaction((): CreateSessionResponse => {
      try {
        localDateIn(req.timezone, deps.now()); // an unknown IANA zone is refused before anything is written
      } catch {
        throw new ApiError(422, "TIMEZONE_INVALID", `Unknown time zone ${req.timezone}`);
      }
      const active = db.prepare("SELECT id FROM sessions WHERE status = 'active' LIMIT 1").get() as { id: string } | undefined;
      if (active) throw new ApiError(409, "SESSION_ACTIVE", "A session is already in progress: resume it or finish it first", { sessionId: active.id });

      const blueprint = loadBlueprint(db, req.blueprintRevisionId!);
      if (!PLAYABLE_BLUEPRINT_STATUSES.has(blueprint.status)) throw new ApiError(409, "BLUEPRINT_NOT_APPROVED", `Blueprint is ${blueprint.status}, not approved/published`);
      const settings = loadSettings(db, req.settingsRevisionId);
      const plan = loadPlan(db, deps);
      const taxonomyId = (db.prepare("SELECT id FROM taxonomy_versions ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as { id: string }).id;
      const nowIso = deps.now().toISOString();

      const candidates = loadCandidates(db, "practice", blueprint.policy.skillPool);
      const blocked = loadBlockedFingerprints(db);
      const priorities = loadPriorities(db, candidates, nowIso, taxonomyId);
      const discovery = runDiscovery(db, { asOf: nowIso, taxonomyId, config: discoveryCfg });
      const bonusBySkill = Object.fromEntries(discovery.skills.filter((s) => s.bonus > 0).map((s) => [s.skillId, s.bonus]));
      const seed = req.seed ?? deps.newId();
      const n = settings.values.taskCount;

      const solveWith = (bonus: Record<string, number>) =>
        solveForBank({
          n,
          weakRatio: settings.values.weakRatio,
          voiceTarget: settings.values.voiceTarget,
          policy: blueprint.policy,
          seed,
          candidates,
          blocked,
          priority: priorities.lookup,
          planMultiplier: (skill) => clampMultiplier(plan.multipliers[skill]),
          discoveryBonus: bonus,
        });
      let { result, quotas } = solveWith(bonusBySkill);
      let discoveryFallback = false;
      if (!result.feasible && Object.keys(bonusBySkill).length > 0) {
        // a discovery probe is an optional, bounded nudge: it must never be the reason a session cannot be built
        ({ result, quotas } = solveWith({}));
        discoveryFallback = true;
      }
      if (!result.feasible) {
        throw new ApiError(409, "CONTENT_SHORTAGE", `Not enough approved exercises for ${n} tasks`, { deficits: result.deficits, largestFeasibleN: result.largestFeasibleN, requestedN: n });
      }
      const byId = new Map<string, Candidate>(candidates.map((c) => [c.revisionId, c]));
      const violations = hardViolations(result.slots, n, byId, blocked, quotas);
      if (violations.length > 0) throw new ApiError(500, "ALLOCATOR_INVARIANT", "The allocator produced a session that breaks a hard rule", { violations });

      const algorithmId = ensureSelectionVersion(db, deps, discoveryCfg);
      const sessionId = deps.newId();
      db.prepare(
        `INSERT INTO sessions(id, blueprint_revision_id, purpose, settings_revision_id, plan_id, selection_version, random_seed, status, created_at, timezone)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(sessionId, blueprint.id, "practice", settings.id, plan.id, SELECTION_VERSION, seed, "active", nowIso, req.timezone);

      const insSlot = db.prepare("INSERT INTO session_slots(id, session_id, ordinal, exercise_revision_id, question_id, reading_group_id, input_preference, cohort_json) VALUES (?,?,?,?,?,?,?,?)");
      const unitsOf = db.prepare("SELECT DISTINCT rpu.unit_id AS unitId FROM revision_prompt_units rpu WHERE rpu.revision_id = ?");
      const reserve = db.prepare("INSERT INTO prompt_reservations(unit_id, slot_id, created_at) VALUES (?,?,?)");
      const choices: unknown[] = [];
      const reserved = new Set<string>();
      for (const s of result.slots) {
        const cand = byId.get(s.revisionId) as BankCandidate;
        const slotId = deps.newId();
        let questionId: string | null = null;
        if (s.childIndex !== null) {
          const content = JSON.parse((db.prepare("SELECT content_json AS c FROM exercise_revisions WHERE id = ?").get(s.revisionId) as { c: string }).c) as { payload: { questions: Array<{ id: string }> } };
          questionId = content.payload.questions[s.childIndex]!.id;
        }
        insSlot.run(slotId, sessionId, s.ordinal, s.revisionId, questionId, s.readingGroupId, s.inputPreference, JSON.stringify({ criterionVersion: cand.rubricVersion, difficulty: cand.difficulty, role: s.role }));
        // all units of the revision are reserved up front, by the first slot of the revision (a reading passage's children share them)
        if (!reserved.has(s.revisionId)) {
          reserved.add(s.revisionId);
          for (const u of unitsOf.all(s.revisionId) as Array<{ unitId: string }>) reserve.run(u.unitId, slotId, nowIso);
        }
        choices.push({
          slotId,
          ordinal: s.ordinal,
          revisionId: s.revisionId,
          format: s.format,
          skillId: s.skillId,
          family: s.family,
          role: s.role,
          priority: s.priority,
          planMultiplier: s.multiplier,
          bonus: s.bonus,
          readingGroupId: s.readingGroupId,
          childIndex: s.childIndex,
        });
      }

      const candidateHash = sha256(canonicalJson({ candidates: candidates.map((c) => c.revisionId), blocked: blocked.size, evidence: priorities.evidenceHash, watermark: priorities.watermark }));
      db.prepare("INSERT INTO scheduling_decisions(id, session_id, algorithm_id, candidate_hash, choices_json, deficits_json, created_at) VALUES (?,?,?,?,?,?,?)").run(
        deps.newId(),
        sessionId,
        algorithmId,
        candidateHash,
        JSON.stringify({
          selectionVersion: SELECTION_VERSION,
          seed,
          asOf: nowIso,
          quotas,
          settings: { revision: settings.revision, taskCount: n, weakRatio: settings.values.weakRatio, voiceTarget: settings.values.voiceTarget },
          plan: { id: plan.id, revision: plan.revision },
          blueprint: { revisionId: blueprint.id, key: blueprint.key },
          stats: result.stats,
          discovery: {
            version: discoveryCfg.version,
            configHash: sha256(canonicalJson(discoveryCfg)),
            qualificationIds: [...new Set(discovery.skills.flatMap((s) => s.qualificationIds))],
            analysisWatermark: discovery.watermark,
            reviewWatermark: discovery.reviewWatermark,
            sourceFindingIds: discovery.sourceFindingIds,
            bonusBySkill: discoveryFallback ? {} : bonusBySkill,
            fallback: discoveryFallback ? "no_feasible_session_with_probes" : null,
            config: discoveryCfg,
          },
          slots: choices,
        }),
        // soft targets disclosed, not hidden: weak share and voice are met; vocabulary / AI-IT share are not tracked yet
        JSON.stringify({
          soft: {
            weakRatio: { target: result.stats.weakTarget, actual: result.stats.weakActual },
            voice: { target: settings.values.voiceTarget, actual: result.stats.voiceActual },
            vocabularyShare: "not tracked: the exercise schema has no vocabulary flag yet",
            aiItShare: "not tracked: the exercise schema has no topic-domain flag yet",
            sameSessionRemediation: "not applied: the snapshot is fixed at creation; failures are picked up by the next session",
          },
          hard: [],
        }),
        nowIso,
      );
      return { sessionId, snapshot: getSnapshot(db, sessionId) };
    })
    .immediate();
}
