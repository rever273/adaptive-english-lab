import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { NullOutbox, PendingAssessor, type AttemptDeps, type Assessor, type AssessmentDecision, type FindingInput, type Outbox } from "../../../apps/server/src/domain/attempts/ports.js";
import { runMigrations } from "../../../apps/server/src/db/migrate.js";
import { openDatabase, type Db } from "../../../apps/server/src/db/open.js";
import { makeScratchRoot, projectRoot, testConfig } from "../helpers.js";

export const TARGET = "articles.definite";
export const SKILL_B = "articles.indefinite";
export const SKILL_C = "countability.mass_nouns";

export interface Env {
  db: Db;
  deps: AttemptDeps;
  clock: { current: Date };
  scratch: ReturnType<typeof makeScratchRoot>;
  planId: string;
  taxonomyId: string;
  settingsId: string;
  cleanup: () => void;
}

export interface EnvOptions {
  assessor?: Assessor;
  outbox?: Outbox;
}

/** Real temp SQLite with migrations 001+002; the clock only moves when a test moves it. */
export async function makeEnv(opts: EnvOptions = {}): Promise<Env> {
  const scratch = makeScratchRoot();
  const db = openDatabase(path.join(scratch.root, "db", "t.sqlite"));
  await runMigrations(db, { migrationsDir: path.join(projectRoot, "migrations"), appVersion: "test" });
  const clock = { current: new Date("2026-10-28T01:00:00.000Z") };
  const deps: AttemptDeps = {
    assessor: opts.assessor ?? PendingAssessor,
    outbox: opts.outbox ?? NullOutbox,
    now: () => new Date(clock.current),
    newId: randomUUID,
  };
  const taxonomyId = (db.prepare("SELECT id FROM taxonomy_versions").get() as { id: string }).id;
  const settingsId = (db.prepare("SELECT id FROM settings_revisions WHERE revision=1").get() as { id: string }).id;
  const planId = randomUUID();
  db.prepare("INSERT INTO learning_plans(id, revision, priorities_json, rationale, reviewer, created_at, taxonomy_id) VALUES (?,?,?,?,?,?,?)").run(
    planId,
    1,
    "{}",
    "test plan",
    "test",
    clock.current.toISOString(),
    taxonomyId,
  );
  return {
    db,
    deps,
    clock,
    scratch,
    planId,
    taxonomyId,
    settingsId,
    cleanup: () => {
      db.close();
      scratch.cleanup();
    },
  };
}

export function advance(env: Env, ms: number): void {
  env.clock.current = new Date(env.clock.current.getTime() + ms);
}

export interface ExerciseOptions {
  type?: string;
  dimension?: "recognition" | "correction" | "production";
  bankRole?: "practice" | "diagnostic" | "heldout";
  target?: string;
  rubricVersion?: string;
  difficulty?: "A2" | "B1" | "B2" | "C1";
  contextId?: string;
  /** overrides content_json entirely */
  content?: Record<string, unknown>;
}

export function makeRevision(env: Env, o: ExerciseOptions = {}): string {
  const id = randomUUID();
  const exerciseId = randomUUID();
  const type = o.type ?? "choose_form";
  const content = o.content ?? {
    schema_version: "exercise-v1",
    id: exerciseId,
    type,
    target_skill: o.target ?? TARGET,
    prompt_en: `The council ___ the timetable (${id}).`,
    payload: { options: [{ id: "a", text: "published" }, { id: "b", text: "publish" }], accepted_option_ids: ["a"], multiple: false },
  };
  const json = JSON.stringify(content);
  env.db.prepare("INSERT INTO exercises(id, created_at) VALUES (?,?)").run(exerciseId, env.clock.current.toISOString());
  env.db
    .prepare(
      `INSERT INTO exercise_revisions(id, exercise_id, revision, schema_version, type, content_json, content_hash, rubric_version, taxonomy_id,
                                      dimension, difficulty, topic, context_id, template_cluster, bank_role, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      exerciseId,
      1,
      "exercise-v1",
      type,
      json,
      createHash("sha256").update(json).digest("hex"),
      o.rubricVersion ?? "rubric-v1",
      env.taxonomyId,
      o.dimension ?? "recognition",
      o.difficulty ?? "B2",
      "city",
      o.contextId ?? `ctx-${id}`,
      `tpl-${id}`,
      o.bankRole ?? "practice",
      env.clock.current.toISOString(),
    );
  return id;
}

export interface SessionOptions {
  purpose?: "practice" | "diagnostic" | "heldout";
  status?: "active" | "suspended" | "completed" | "ended_early";
  timezone?: string;
}

export function makeSession(env: Env, o: SessionOptions = {}): string {
  const id = randomUUID();
  env.db
    .prepare(
      `INSERT INTO sessions(id, blueprint_revision_id, purpose, settings_revision_id, plan_id, selection_version, random_seed, status, created_at, timezone)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(id, null, o.purpose ?? "practice", env.settingsId, env.planId, "test-sel-v0", "seed", o.status ?? "active", env.clock.current.toISOString(), o.timezone ?? "Australia/Brisbane");
  return id;
}

export function makeSlot(env: Env, sessionId: string, revisionId: string, ordinal: number, questionId: string | null = null): string {
  const id = randomUUID();
  env.db
    .prepare("INSERT INTO session_slots(id, session_id, ordinal, exercise_revision_id, question_id, reading_group_id, input_preference, cohort_json) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, sessionId, ordinal, revisionId, questionId, null, "text", "{}");
  return id;
}

/** Writes a raw session event exactly as the (future) reveal endpoint would. */
export function addEvent(env: Env, sessionId: string, slotId: string | null, type: string, clientEventId = randomUUID()): string {
  const id = randomUUID();
  env.db
    .prepare("INSERT INTO session_events(id, session_id, slot_id, client_event_id, event_type, payload_json, server_at, local_date, timezone) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, sessionId, slotId, clientEventId, type, "{}", env.clock.current.toISOString(), "2026-10-28", "Australia/Brisbane");
  return id;
}

/** A revealed slot ready for answers. */
export function revealedSlot(env: Env, o: ExerciseOptions & SessionOptions = {}): { sessionId: string; slotId: string; revisionId: string } {
  // one transaction = one fsync instead of five: keeps fixture-heavy tests fast without changing what is stored
  return env.db.transaction(() => {
    const revisionId = makeRevision(env, o);
    const sessionId = makeSession(env, o);
    const slotId = makeSlot(env, sessionId, revisionId, 0);
    addEvent(env, sessionId, slotId, "reveal");
    return { sessionId, slotId, revisionId };
  })();
}

/** Closed-form test grader: exact option-set equality against accepted_option_ids. Stands in for TASK_006/007. */
export function exactSetAssessor(extra?: (answerCorrect: boolean) => Partial<AssessmentDecision> & { findings?: FindingInput[] }): Assessor {
  return {
    assess(ctx) {
      if (ctx.idk) return { verdict: "idk", confirmation: "confirmed", source: "deterministic", rationale: "IDK" };
      const raw = ctx.rawAnswer as { kind: string; optionIds?: string[] };
      const accepted = ((ctx.content as { payload: { accepted_option_ids: string[] } }).payload.accepted_option_ids ?? []).slice().sort().join(",");
      const given = (raw.optionIds ?? []).slice().sort().join(",");
      const correct = raw.kind === "options" && given === accepted;
      return {
        verdict: correct ? "correct" : "incorrect",
        confirmation: "confirmed",
        source: "deterministic",
        rationale: correct ? "exact set match" : "set differs from accepted ids",
        ...(extra?.(correct) ?? {}),
      };
    },
  };
}

export const rows = <T = Record<string, unknown>>(db: Db, sql: string, ...params: unknown[]): T[] => db.prepare(sql).all(...params) as T[];
export const one = <T = Record<string, unknown>>(db: Db, sql: string, ...params: unknown[]): T => db.prepare(sql).get(...params) as T;

export const testConfigFor = (env: Env, port: number) => testConfig(env.scratch.root, port);
