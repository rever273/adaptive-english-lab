import { createHash } from "node:crypto";
import type { CreateSessionRequest, CreateSessionResponse } from "@english-lab/contracts";
import { canonicalJson } from "@english-lab/learning";
import type { Db } from "../../db/open.js";
import { ApiError } from "../../errors.js";
import { localDateIn } from "../attempts/canonical.js";
import { loadBlockedFingerprints, loadCandidates, type BankCandidate } from "../sessions/bank.js";
import { loadPlan, loadSettings, type SessionDeps } from "../sessions/policy.js";
import { getSnapshot } from "../sessions/snapshot.js";
import { DIAGNOSTIC_PROTOCOL, HELDOUT_PROTOCOL } from "./protocol.js";
import { selectBlock, type ChosenSlot, type Dim } from "./select.js";

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const DAY_MS = 24 * 3600 * 1000;

function ensureProtocolVersion(db: Db, deps: SessionDeps, id: string, config: unknown): string {
  const json = canonicalJson(config);
  const row = db.prepare("SELECT config_hash AS h FROM algorithm_versions WHERE id = ?").get(id) as { h: string } | undefined;
  if (row) {
    if (row.h !== sha256(json)) throw new ApiError(500, "PROTOCOL_CHANGED", `Protocol ${id} changed without a new version id`);
    return id;
  }
  db.prepare("INSERT INTO algorithm_versions(id, config_json, config_hash, source_version, created_at) VALUES (?,?,?,?,?)").run(id, json, sha256(json), "apps/server/diagnostics@1", deps.now().toISOString());
  return id;
}

/** Skills the learner has practised, with the time of the FIRST target attempt (any purpose except a held-out check). */
export function firstPracticeBySkill(db: Db): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT sr.skill_id AS skill, MIN(t.submitted_at) AS first
         FROM attempts t
         JOIN session_slots ss ON ss.id = t.slot_id
         JOIN sessions s ON s.id = ss.session_id AND s.purpose IN ('practice','diagnostic')
         JOIN exercise_skills es ON es.revision_id = ss.exercise_revision_id AND es.role = 'target'
         JOIN skill_revisions sr ON sr.id = es.skill_revision_id
        GROUP BY sr.skill_id`,
    )
    .all() as Array<{ skill: string; first: string }>;
  return new Map(rows.map((r) => [r.skill, r.first]));
}

function skillsUsedBy(db: Db, purpose: "diagnostic" | "heldout"): Set<string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT sr.skill_id AS skill FROM session_slots ss JOIN sessions s ON s.id = ss.session_id AND s.purpose = ?
         JOIN exercise_skills es ON es.revision_id = ss.exercise_revision_id AND es.role = 'target'
         JOIN skill_revisions sr ON sr.id = es.skill_revision_id`,
    )
    .all(purpose) as Array<{ skill: string }>;
  return new Set(rows.map((r) => r.skill));
}

export interface DiagnosticStatus {
  protocol: string;
  blocksTotal: number;
  /** blocks already started (completed or ended early): their sentences are spent */
  blocksUsed: number;
  nextBlock: number | null;
  /** can the next block be built from the current bank? */
  ready: boolean;
  shortage: { deficits: unknown } | null;
}
export interface HeldoutStatus {
  protocol: string;
  /** tasks a check could contain right now */
  availableTasks: number;
  eligibleSkills: number;
  minDelayDays: number;
  ready: boolean;
  reason: string | null;
}

/** fair share of the scarce "No mistake" sentences: with 3 blocks left and 3 available, each block may use 1 */
function noMistakeCap(cands: readonly BankCandidate[], blocked: ReadonlySet<string>, blocksLeft: number): number {
  const avail = cands.filter((c) => c.noMistake && !c.unitFingerprints.some((f) => blocked.has(f))).length;
  return Math.max(DIAGNOSTIC_PROTOCOL.minNoMistakePerBlock, Math.floor(avail / Math.max(1, blocksLeft)));
}

const blockCandidates = (db: Db, role: "diagnostic" | "heldout"): BankCandidate[] => loadCandidates(db, role);

export function diagnosticStatus(db: Db, deps: SessionDeps): DiagnosticStatus {
  const used = (db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE purpose = 'diagnostic'").get() as { n: number }).n;
  const base = { protocol: DIAGNOSTIC_PROTOCOL.id, blocksTotal: DIAGNOSTIC_PROTOCOL.blocks, blocksUsed: used };
  if (used >= DIAGNOSTIC_PROTOCOL.blocks) return { ...base, nextBlock: null, ready: false, shortage: null };
  const sel = selectBlock({ candidates: blockCandidates(db, "diagnostic"), allowedFormats: DIAGNOSTIC_PROTOCOL.formats, need: { ...DIAGNOSTIC_PROTOCOL.perBlock, minNoMistake: DIAGNOSTIC_PROTOCOL.minNoMistakePerBlock, maxNoMistake: noMistakeCap(blockCandidates(db, "diagnostic"), loadBlockedFingerprints(db), DIAGNOSTIC_PROTOCOL.blocks - used) }, blocked: loadBlockedFingerprints(db), avoidSkills: skillsUsedBy(db, "diagnostic"), familyOrder: DIAGNOSTIC_PROTOCOL.familyOrder, seed: `status-${used}`, distinctSkills: true });
  return { ...base, nextBlock: used + 1, ready: sel.feasible, shortage: sel.feasible ? null : { deficits: sel.deficits } };
}

function heldoutPlan(db: Db, deps: SessionDeps) {
  const first = firstPracticeBySkill(db);
  const cutoff = deps.now().getTime() - HELDOUT_PROTOCOL.minDelayDays * DAY_MS;
  const eligible = new Set([...first].filter(([, at]) => Date.parse(at) <= cutoff).map(([skill]) => skill));
  const all = blockCandidates(db, "heldout");
  const blocked = loadBlockedFingerprints(db);
  const cands = all.filter((c) => eligible.has(c.skillId) && !c.unitFingerprints.some((f) => blocked.has(f)));
  const count = (d: Dim) => new Set(cands.filter((c) => c.dimension === d).map((c) => c.skillId)).size;
  const need = { recognition: Math.min(HELDOUT_PROTOCOL.perCheck.recognition, count("recognition")), correction: Math.min(HELDOUT_PROTOCOL.perCheck.correction, count("correction")), production: Math.min(HELDOUT_PROTOCOL.perCheck.production, count("production")), minNoMistake: 0 };
  return { eligible, cands, blocked, need, total: need.recognition + need.correction + need.production };
}

export function heldoutStatus(db: Db, deps: SessionDeps): HeldoutStatus {
  const p = heldoutPlan(db, deps);
  const ready = p.total >= HELDOUT_PROTOCOL.minSize;
  return { protocol: HELDOUT_PROTOCOL.id, availableTasks: p.total, eligibleSkills: p.eligible.size, minDelayDays: HELDOUT_PROTOCOL.minDelayDays, ready, reason: ready ? null : p.eligible.size === 0 ? "no_skill_practised_for_7_days" : "not_enough_unseen_heldout_tasks" };
}

interface Persist {
  purpose: "diagnostic" | "heldout";
  protocolId: string;
  protocolConfig: unknown;
  slots: ChosenSlot[];
  byId: Map<string, BankCandidate>;
  seed: string;
  timezone: string;
  block: number | null;
  stats: unknown;
}

/** One transaction: session + slots + reservations of ALL sentence units + the decision record. Same guarantees as a practice snapshot. */
function persist(db: Db, deps: SessionDeps, p: Persist): CreateSessionResponse {
  const settings = loadSettings(db);
  const plan = loadPlan(db, deps);
  const nowIso = deps.now().toISOString();
  const algorithmId = ensureProtocolVersion(db, deps, p.protocolId, p.protocolConfig);
  const sessionId = deps.newId();
  db.prepare(
    `INSERT INTO sessions(id, blueprint_revision_id, purpose, settings_revision_id, plan_id, selection_version, random_seed, status, created_at, timezone)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(sessionId, null, p.purpose, settings.id, plan.id, p.protocolId, p.seed, "active", nowIso, p.timezone);
  const insSlot = db.prepare("INSERT INTO session_slots(id, session_id, ordinal, exercise_revision_id, question_id, reading_group_id, input_preference, cohort_json) VALUES (?,?,?,?,?,?,?,?)");
  const unitsOf = db.prepare("SELECT DISTINCT rpu.unit_id AS unitId FROM revision_prompt_units rpu WHERE rpu.revision_id = ?");
  const reserve = db.prepare("INSERT INTO prompt_reservations(unit_id, slot_id, created_at) VALUES (?,?,?)");
  const choices: unknown[] = [];
  for (const s of p.slots) {
    const cand = p.byId.get(s.revisionId)!;
    const slotId = deps.newId();
    // every diagnostic / held-out task is typed: no voice baseline (spec/04)
    insSlot.run(slotId, sessionId, s.ordinal, s.revisionId, null, null, "text", JSON.stringify({ criterionVersion: cand.rubricVersion, difficulty: cand.difficulty, protocol: p.protocolId, block: p.block, role: "check" }));
    for (const u of unitsOf.all(s.revisionId) as Array<{ unitId: string }>) reserve.run(u.unitId, slotId, nowIso);
    choices.push({ slotId, ordinal: s.ordinal, revisionId: s.revisionId, format: s.format, skillId: s.skillId, family: s.family, dimension: s.dimension });
  }
  db.prepare("INSERT INTO scheduling_decisions(id, session_id, algorithm_id, candidate_hash, choices_json, deficits_json, created_at) VALUES (?,?,?,?,?,?,?)").run(
    deps.newId(),
    sessionId,
    algorithmId,
    sha256(canonicalJson({ candidates: [...p.byId.keys()].sort(), seed: p.seed })),
    JSON.stringify({ protocol: p.protocolId, block: p.block, seed: p.seed, asOf: nowIso, stats: p.stats, slots: choices }),
    JSON.stringify({ hard: [], note: "diagnostic/held-out protocols have no soft targets; provisional scores are labelled as such in analytics" }),
    nowIso,
  );
  return { sessionId, snapshot: getSnapshot(db, sessionId) };
}

function preflight(db: Db, deps: SessionDeps, timezone: string): void {
  try {
    localDateIn(timezone, deps.now());
  } catch {
    throw new ApiError(422, "TIMEZONE_INVALID", `Unknown time zone ${timezone}`);
  }
  const active = db.prepare("SELECT id FROM sessions WHERE status = 'active' LIMIT 1").get() as { id: string } | undefined;
  if (active) throw new ApiError(409, "SESSION_ACTIVE", "A session is already in progress: resume it or finish it first", { sessionId: active.id });
}

/** Optional starting diagnostic: block 1..3 of 8 mixed tasks (3 recognition, 3 correction incl. a "No mistake", 2 short production), 8 different skills. */
export function createDiagnosticBlock(db: Db, deps: SessionDeps, req: CreateSessionRequest): CreateSessionResponse {
  return db
    .transaction((): CreateSessionResponse => {
      preflight(db, deps, req.timezone);
      const used = (db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE purpose = 'diagnostic'").get() as { n: number }).n;
      if (used >= DIAGNOSTIC_PROTOCOL.blocks) throw new ApiError(409, "DIAGNOSTIC_COMPLETE", "All three diagnostic blocks have been started. Keep practising; held-out checks come later.");
      const candidates = blockCandidates(db, "diagnostic");
      const blocked = loadBlockedFingerprints(db);
      const seed = req.seed ?? deps.newId();
      const sel = selectBlock({ candidates, allowedFormats: DIAGNOSTIC_PROTOCOL.formats, need: { ...DIAGNOSTIC_PROTOCOL.perBlock, minNoMistake: DIAGNOSTIC_PROTOCOL.minNoMistakePerBlock, maxNoMistake: noMistakeCap(candidates, blocked, DIAGNOSTIC_PROTOCOL.blocks - used) }, blocked, avoidSkills: skillsUsedBy(db, "diagnostic"), familyOrder: DIAGNOSTIC_PROTOCOL.familyOrder, seed, distinctSkills: true });
      if (!sel.feasible) throw new ApiError(409, "CONTENT_SHORTAGE", "Not enough approved diagnostic tasks for the next block", { deficits: sel.deficits, requestedN: DIAGNOSTIC_PROTOCOL.blockSize });
      if (new Set(sel.slots.map((s) => s.skillId)).size !== DIAGNOSTIC_PROTOCOL.blockSize) throw new ApiError(500, "ALLOCATOR_INVARIANT", "A diagnostic block must cover 8 different skills");
      return persist(db, deps, { purpose: "diagnostic", protocolId: DIAGNOSTIC_PROTOCOL.id, protocolConfig: DIAGNOSTIC_PROTOCOL, slots: sel.slots, byId: new Map(candidates.map((c) => [c.revisionId, c])), seed, timezone: req.timezone, block: used + 1, stats: { block: used + 1 } });
    })
    .immediate();
}

/** A delayed independent check from the held-out bank: skills practised >= 7 days ago, sentences never shown, no hints, feedback after the block. */
export function createHeldoutCheck(db: Db, deps: SessionDeps, req: CreateSessionRequest): CreateSessionResponse {
  return db
    .transaction((): CreateSessionResponse => {
      preflight(db, deps, req.timezone);
      const p = heldoutPlan(db, deps);
      if (p.total < HELDOUT_PROTOCOL.minSize) {
        throw new ApiError(409, "HELDOUT_NOT_READY", p.eligible.size === 0 ? "No skill has been practised for 7 days yet, so there is nothing to check independently." : "Not enough unseen held-out tasks for the skills that are due.", { eligibleSkills: p.eligible.size, availableTasks: p.total, minDelayDays: HELDOUT_PROTOCOL.minDelayDays });
      }
      const seed = req.seed ?? deps.newId();
      const sel = selectBlock({ candidates: p.cands, allowedFormats: DIAGNOSTIC_PROTOCOL.formats, need: p.need, blocked: p.blocked, avoidSkills: new Set(), familyOrder: DIAGNOSTIC_PROTOCOL.familyOrder, seed, distinctSkills: false });
      if (!sel.feasible) throw new ApiError(409, "HELDOUT_NOT_READY", "Not enough unseen held-out tasks for the skills that are due.", { deficits: sel.deficits });
      return persist(db, deps, { purpose: "heldout", protocolId: HELDOUT_PROTOCOL.id, protocolConfig: HELDOUT_PROTOCOL, slots: sel.slots, byId: new Map(p.cands.map((c) => [c.revisionId, c])), seed, timezone: req.timezone, block: null, stats: { eligibleSkills: p.eligible.size, size: sel.slots.length } });
    })
    .immediate();
}
