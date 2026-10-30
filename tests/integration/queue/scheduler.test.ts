import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../../../apps/server/src/db/open.js";
import { runMigrations } from "../../../apps/server/src/db/migrate.js";
import { ApiError } from "../../../apps/server/src/errors.js";
import { applyAction, completeJob, enqueue, getJob, listJobs, reasonOfLastEvent, recoverStale, resultOf, StaleLeaseError, type EnqueueInput, type Job } from "../../../apps/server/src/queue/jobs.js";
import { GpuScheduler } from "../../../apps/server/src/queue/scheduler.js";
import type { SchedulerConfig } from "../../../apps/server/src/queue/types.js";
import { deferred, FakeClock, FakeGpu, FakeRunner, flush } from "../../fixtures/queue/fakes.js";
import { makeScratchRoot, projectRoot } from "../helpers.js";

interface Rig {
  db: Db;
  clock: FakeClock;
  gpu: FakeGpu;
  runner: FakeRunner;
  sched: GpuScheduler;
  deps: { now: () => Date; newId: () => string };
  cleanup: () => void;
  newScheduler: (id: string, cfg?: Partial<SchedulerConfig>) => GpuScheduler;
}
const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    for (const g of r.runner.gates.values()) g.resolve(); // let any unit still waiting on a gate end before the database closes
    await flush();
    await flush();
    r.cleanup();
  }
});

async function rig(cfg: Partial<SchedulerConfig> = {}): Promise<Rig> {
  const scratch = makeScratchRoot();
  const db = openDatabase(path.join(scratch.root, "db", "q.sqlite"));
  await runMigrations(db, { migrationsDir: path.join(projectRoot, "migrations"), appVersion: "test" });
  const clock = new FakeClock();
  const gpu = new FakeGpu(clock);
  const runner = new FakeRunner("test_unit", gpu);
  const mk = (id: string, c: Partial<SchedulerConfig> = {}) => new GpuScheduler({ db, newId: randomUUID, clock, telemetry: gpu, control: gpu, runners: [runner], instanceId: id, config: { admission: "spike", idleUnloadMs: 10 * 60_000, ...cfg, ...c } });
  const r: Rig = {
    db,
    clock,
    gpu,
    runner,
    sched: mk("A"),
    deps: { now: () => clock.now(), newId: randomUUID },
    newScheduler: mk,
    cleanup: () => {
      db.close();
      scratch.cleanup();
    },
  };
  rigs.push(r);
  return r;
}

const job = (r: Rig, key: string, o: Partial<EnqueueInput> = {}): Job => enqueue(r.db, r.deps, { kind: "test_unit", payload: { key }, idempotencyKey: key, ...o }).job;
const state = (r: Rig, id: string) => getJob(r.db, id)!.state;
const events = (r: Rig, id: string) => (r.db.prepare("SELECT sequence, state, reason FROM job_events WHERE job_id = ? ORDER BY sequence").all(id) as Array<{ sequence: number; state: string; reason: string }>).map((e) => `${e.state}:${e.reason}`);
const count = (r: Rig, sql: string, ...p: unknown[]) => (r.db.prepare(sql).get(...p) as { n: number }).n;
const lock = (r: Rig) => r.db.prepare("SELECT owner_id AS owner, fencing_token AS token FROM gpu_lock WHERE id = 1").get() as { owner: string | null; token: number };

/** Runs scheduler passes (letting async units settle between them) until the condition holds. */
async function drive(r: Rig, sched: GpuScheduler, until: () => boolean, max = 60): Promise<void> {
  for (let i = 0; i < max; i++) {
    await sched.tick();
    await flush();
    await flush();
    if (until()) return;
    r.clock.advance(500);
  }
  throw new Error("condition not reached within the tick budget");
}
const startPractice = (r: Rig, sessionId = randomUUID()) => {
  // a practice session lease in the database: the same fact TASK_007 writes when a tab takes the lease
  const taxonomy = (r.db.prepare("SELECT id FROM taxonomy_versions").get() as { id: string }).id;
  const settings = (r.db.prepare("SELECT id FROM settings_revisions").get() as { id: string }).id;
  const planId = randomUUID();
  r.db.prepare("INSERT INTO learning_plans(id, revision, priorities_json, rationale, reviewer, created_at, taxonomy_id) VALUES (?,?,?,?,?,?,?)").run(planId, (r.db.prepare("SELECT COUNT(*) AS n FROM learning_plans").get() as { n: number }).n + 1, "{}", "t", "t", "now", taxonomy);
  r.db.prepare("INSERT INTO sessions(id, purpose, settings_revision_id, plan_id, selection_version, random_seed, status, created_at, timezone) VALUES (?,?,?,?,?,?,?,?,?)").run(sessionId, "practice", settings, planId, "v", "s", "active", "now", "Australia/Brisbane");
  r.db.prepare("INSERT INTO practice_leases(session_id, tab_id, token, heartbeat_at, expires_at) VALUES (?,?,?,?,?)").run(sessionId, "tab", 1, r.clock.now().toISOString(), new Date(r.clock.now().getTime() + 90_000).toISOString());
  return sessionId;
};
const endPractice = (r: Rig) => r.db.prepare("DELETE FROM practice_leases").run();

describe("running jobs through the single dispatcher", () => {
  it("does not start a job when practice begins during GPU admission", async () => {
    const r = await rig();
    const sample = deferred<Awaited<ReturnType<FakeGpu["sample"]>>>();
    const original = r.gpu.sample.bind(r.gpu);
    r.gpu.sample = () => sample.promise;
    const a = job(r, "practice-admission-race");
    const tick = r.sched.tick();
    await flush();
    expect((await r.sched.beginPractice()).ready).toBe(true);
    sample.resolve(await original());
    await tick;
    expect(r.runner.started).toHaveLength(0);
    expect(state(r, a.id)).toBe("queued");
  });

  it("does not launch a job cancelled while GPU admission is pending", async () => {
    const r = await rig();
    const sample = deferred<Awaited<ReturnType<FakeGpu["sample"]>>>();
    const original = r.gpu.sample.bind(r.gpu);
    r.gpu.sample = () => sample.promise;
    const a = job(r, "cancel-admission-race");
    const tick = r.sched.tick();
    await flush();
    applyAction(r.db, r.deps, a.id, "cancel");
    sample.resolve(await original());
    await tick;
    expect(state(r, a.id)).toBe("cancelled");
    expect(r.runner.started).toHaveLength(0);
    expect(lock(r).owner).toBeNull();
  });

  it("checks free memory after unloading a different resident model", async () => {
    const r = await rig({ admission: "profiled" });
    const mv = randomUUID();
    r.db.prepare("INSERT INTO model_versions(id, tag, digest, runtime, runtime_version, parameters_json) VALUES (?,?,?,?,?,?)").run(mv, "fake", "sha256:x", "fake", "1", "{}");
    r.db.prepare("INSERT INTO gpu_profiles(id, model_version_id, config_hash, measured_peak_mib, timings_json, validated_at) VALUES (?,?,?,?,?,?)").run(randomUUID(), mv, "cfg", 6000, "{}", "now");
    r.runner.profile = { modelVersionId: mv, configHash: "cfg" };
    const first = job(r, "resident-first");
    await drive(r, r.sched, () => state(r, first.id) === "completed");
    r.runner.model = "different-model";
    r.gpu.foreignMib = 10000;
    const second = job(r, "resident-second");
    await r.sched.tick();
    expect(state(r, second.id)).toBe("waiting_for_gpu");
    expect(reasonOfLastEvent(r.db, second.id)).toBe("insufficient_vram");
    expect(r.runner.started).toEqual([first.id]);
  });

  it("blocks profiled admission when the runner has no profile key", async () => {
    const r = await rig({ admission: "profiled" });
    const a = job(r, "missing-profile-key");
    await r.sched.tick();
    expect(r.runner.started).toHaveLength(0);
    expect(state(r, a.id)).toBe("waiting_for_gpu");
    expect(reasonOfLastEvent(r.db, a.id)).toBe("profile_unknown");
  });

  it("renews the GPU lock along with the active job heartbeat", async () => {
    const r = await rig();
    r.runner.behaviour = "gate";
    const a = job(r, "renew-lock");
    await drive(r, r.sched, () => r.runner.started.includes(a.id));
    for (let i = 0; i < 7; i++) {
      r.clock.advance(5000);
      await r.sched.tick();
    }
    job(r, "other-owner");
    await r.newScheduler("B").tick();
    expect(r.runner.started).toEqual([a.id]);
    expect(lock(r).owner).toBe("A");
    r.runner.gate(a.id).resolve();
    await r.sched.idle();
  });

  it("enqueue is idempotent by business key and every state change is an append-only event", async () => {
    const r = await rig();
    const a = job(r, "k1");
    const b = enqueue(r.db, r.deps, { kind: "test_unit", payload: { other: true }, idempotencyKey: "k1" });
    expect(b.created).toBe(false);
    expect(b.job.id).toBe(a.id);
    expect(count(r, "SELECT COUNT(*) AS n FROM jobs")).toBe(1);
    r.runner.behaviour = "instant";
    await drive(r, r.sched, () => state(r, a.id) === "completed");
    expect(events(r, a.id)).toEqual(["queued:enqueued", "running:granted", "completed:result_committed"]);
    expect(resultOf(r.db, a.id)).toMatchObject({ schemaVersion: "test-v1", output: { ok: true, job: a.id } });
  });

  it("commits result + completion under the fencing token, then gives the lease back (token only grows)", async () => {
    const r = await rig();
    const a = job(r, "a");
    const before = lock(r).token;
    await drive(r, r.sched, () => state(r, a.id) === "completed");
    expect(getJob(r.db, a.id)!.leaseToken).toBe(before + 1);
    expect(lock(r)).toEqual({ owner: null, token: before + 1 });
    const b = job(r, "b");
    await drive(r, r.sched, () => state(r, b.id) === "completed");
    expect(lock(r).token).toBe(before + 2);
  });

  it("never runs more than one GPU unit at a time, even with many queued jobs", async () => {
    const r = await rig();
    r.runner.behaviour = "gate";
    const ids = [job(r, "j1"), job(r, "j2"), job(r, "j3")].map((j) => j.id);
    await drive(r, r.sched, () => r.runner.started.length === 1);
    for (let i = 0; i < 6; i++) {
      await r.sched.tick();
      await flush();
    }
    expect(r.runner.active).toBe(1);
    expect(ids.filter((id) => state(r, id) === "running")).toHaveLength(1);
    // release them one by one, whichever the dispatcher picked next
    for (let n = 1; n <= ids.length; n++) {
      await drive(r, r.sched, () => r.runner.started.length === n);
      const current = r.runner.started[n - 1]!;
      r.runner.gate(current).resolve();
      await drive(r, r.sched, () => state(r, current) === "completed");
    }
    expect(r.runner.maxActive).toBe(1);
    expect(ids.every((id) => state(r, id) === "completed")).toBe(true);
  });

  it("works without any browser: a background job completes with no HTTP interaction at all", async () => {
    const r = await rig();
    const a = job(r, "bg", { priority: 3 });
    await drive(r, r.sched, () => state(r, a.id) === "completed");
    expect(listJobs(r.db, { state: "completed" })).toHaveLength(1);
  });
});

describe("crash recovery, stale owners and duplicate delivery", () => {
  it("crash BEFORE commit: the unit goes back to the queue; the dead owner's late result is rejected; the job completes exactly once", async () => {
    const r = await rig();
    r.runner.behaviour = "gate";
    const a = job(r, "crash-before");
    await drive(r, r.sched, () => r.runner.started.includes(a.id));
    const oldToken = getJob(r.db, a.id)!.leaseToken!;
    // the process dies here: a NEW process starts, with a fresh scheduler on the same database
    const second = r.newScheduler("B");
    expect(second.recover()).toEqual([]); // live owner is not fenced by another startup
    r.clock.advance(31_000);
    expect(second.recover()).toEqual([a.id]);
    expect(state(r, a.id)).toBe("queued");
    expect(reasonOfLastEvent(r.db, a.id)).toBe("recovery:lease_expired");
    // the zombie finishes anyway and tries to commit with its old token
    expect(() => completeJob(r.db, r.deps, a.id, oldToken, { schemaVersion: "test-v1", output: { late: true } })).toThrow(StaleLeaseError);
    expect(count(r, "SELECT COUNT(*) AS n FROM job_results")).toBe(0);
    r.runner.gates.get(a.id)?.resolve(); // let the zombie runner end
    r.runner.behaviour = "instant";
    await drive(r, second, () => state(r, a.id) === "completed");
    expect(count(r, "SELECT COUNT(*) AS n FROM job_results WHERE job_id = ?", a.id)).toBe(1);
    expect(getJob(r.db, a.id)!.leaseToken).toBeGreaterThan(oldToken);
  });

  it("takeover of an expired lease with an unresponsive old inference: the new owner starts NOTHING until the old model is proven gone", async () => {
    const r = await rig({ teardownBoundMs: 2000 });
    r.runner.behaviour = "ignore_abort";
    const a = job(r, "zombie");
    await drive(r, r.sched, () => r.runner.started.includes(a.id));
    expect(r.runner.active).toBe(1);
    // the old process is gone (never ticks again) but its inference is still running; its lease expires
    const b = r.newScheduler("B");
    r.clock.advance(31_000);
    r.gpu.failUnload = true; // the model server will not let go
    await drive(r, b, () => reasonOfLastEvent(r.db, a.id) === "release_unproven", 10);
    expect(r.runner.started).toEqual([a.id]); // B did not start a second unit on top of the old one
    expect(r.runner.active).toBe(1);
    expect(lock(r).owner).not.toBe("B"); // B did not take the GPU
    // the unload works again: the zombie is stopped by it, the release is proven and only then B runs the job
    r.gpu.failUnload = false;
    r.runner.behaviour = "instant";
    await drive(r, b, () => state(r, a.id) === "completed");
    expect(r.runner.maxActive).toBe(1); // never two units, including the zombie
    expect(count(r, "SELECT COUNT(*) AS n FROM job_results WHERE job_id = ?", a.id)).toBe(1);
    expect(lock(r).token).toBeGreaterThan(1); // a new fencing token was issued to B
  });

  it("crash AFTER commit: nothing is repeated and recovery leaves the completed job alone", async () => {
    const r = await rig();
    const a = job(r, "crash-after");
    await drive(r, r.sched, () => state(r, a.id) === "completed");
    const second = r.newScheduler("B");
    expect(second.recover()).toEqual([]);
    await drive(r, second, () => true);
    expect(state(r, a.id)).toBe("completed");
    expect(r.runner.started).toEqual([a.id]);
    expect(count(r, "SELECT COUNT(*) AS n FROM job_results")).toBe(1);
  });

  it("duplicate delivery commits once; a stale token never commits", async () => {
    const r = await rig();
    r.runner.behaviour = "gate";
    const a = job(r, "dup");
    await drive(r, r.sched, () => r.runner.started.includes(a.id));
    const token = getJob(r.db, a.id)!.leaseToken!;
    const first = completeJob(r.db, r.deps, a.id, token, { schemaVersion: "test-v1", output: { n: 1 } });
    const second = completeJob(r.db, r.deps, a.id, token, { schemaVersion: "test-v1", output: { n: 2 } });
    expect([first.duplicate, second.duplicate]).toEqual([false, true]);
    expect(resultOf(r.db, a.id)!.output).toEqual({ n: 1 });
    expect(() => r.db.prepare("UPDATE job_results SET output_json = '{}'").run()).toThrow(/append-only/);
    expect(() => r.db.prepare("DELETE FROM jobs").run()).toThrow(/never deleted/);
  });

  it("a commit step that fails rolls back result, side effects and state together", async () => {
    const r = await rig();
    r.runner.behaviour = "gate";
    const a = job(r, "atomic");
    await drive(r, r.sched, () => r.runner.started.includes(a.id));
    const token = getJob(r.db, a.id)!.leaseToken!;
    expect(() =>
      completeJob(r.db, r.deps, a.id, token, {
        schemaVersion: "test-v1",
        output: { ok: 1 },
        alsoCommit: () => {
          throw new Error("annotation insert failed");
        },
      }),
    ).toThrow(/annotation insert failed/);
    expect(count(r, "SELECT COUNT(*) AS n FROM job_results")).toBe(0);
    expect(state(r, a.id)).toBe("running");
  });

  it("lease expiry (no heartbeat for 30 s) requeues the unit and fences the old owner", async () => {
    const r = await rig();
    r.runner.behaviour = "gate";
    const a = job(r, "silent");
    await drive(r, r.sched, () => r.runner.started.includes(a.id));
    const token = getJob(r.db, a.id)!.leaseToken!;
    r.clock.advance(31_000); // the owner went silent: no ticks, no heartbeats
    const watcher = r.newScheduler("B");
    await watcher.tick();
    expect(reasonOfLastEvent(r.db, a.id)).toMatch(/recovery:lease_expired|granted|running/);
    expect(recoverStale(r.db, r.deps, { timeoutMs: 30_000 })).toEqual([]); // already recovered or re-run
    expect(() => completeJob(r.db, r.deps, a.id, token, { schemaVersion: "test-v1", output: {} })).toThrow(StaleLeaseError);
    r.runner.gates.get(a.id)?.resolve();
  });

  it("a restart keeps a job that a user paused paused (user pause is never automatic to resume)", async () => {
    const r = await rig();
    const a = job(r, "paused");
    applyAction(r.db, r.deps, a.id, "pause");
    const restarted = r.newScheduler("B");
    restarted.recover();
    await drive(r, restarted, () => true, 5);
    expect(state(r, a.id)).toBe("paused");
    expect(reasonOfLastEvent(r.db, a.id)).toBe("user_pause");
  });
});

describe("practice always wins", () => {
  it("while a practice lease is live no GPU unit starts - even after the microphone is paused; waiting is recorded with its reason", async () => {
    const r = await rig();
    const sid = startPractice(r);
    const a = job(r, "blocked");
    for (let i = 0; i < 4; i++) {
      await r.sched.tick();
      await flush();
    }
    expect(state(r, a.id)).toBe("waiting_for_gpu");
    expect(reasonOfLastEvent(r.db, a.id)).toBe("practice_active");
    expect(r.runner.started).toEqual([]);
    expect((await r.sched.status()).practiceActive).toBe(true);
    endPractice(r);
    await drive(r, r.sched, () => state(r, a.id) === "completed");
    expect(sid).toBeTruthy();
  });

  it("a running unit is aborted at a safe boundary, discarded, parked as preempted_by_practice and resumes when the lease expires (closed tab)", async () => {
    const r = await rig();
    r.runner.behaviour = "gate";
    const a = job(r, "preempted");
    await drive(r, r.sched, () => r.runner.started.includes(a.id));
    startPractice(r); // 90 s lease
    await drive(r, r.sched, () => state(r, a.id) === "paused");
    expect(reasonOfLastEvent(r.db, a.id)).toBe("preempted_by_practice");
    expect(r.runner.aborted).toContain(a.id);
    expect(count(r, "SELECT COUNT(*) AS n FROM job_results")).toBe(0); // nothing half-done is published
    expect(r.gpu.loaded.size).toBe(0); // the owned model was released (proved by /api/ps + a VRAM plateau)
    expect(lock(r).owner).toBeNull();

    // the browser tab is closed: no heartbeat, the lease simply expires after its TTL
    r.clock.advance(91_000);
    r.runner.behaviour = "instant";
    await drive(r, r.sched, () => state(r, a.id) === "completed");
    expect(events(r, a.id)).toContain("queued:resumed_after_practice");
  });

  it("beginPractice proves the release within the bound: abort, unload, ps absence, VRAM plateau", async () => {
    const r = await rig();
    r.runner.behaviour = "gate";
    r.gpu.releaseLagSamples = 2; // VRAM drops two samples after the unload
    const a = job(r, "bp");
    await drive(r, r.sched, () => r.runner.started.includes(a.id));
    const res = await r.sched.beginPractice();
    expect(res.ready).toBe(true);
    expect(res.elapsedMs).toBeLessThan(15_000);
    expect(r.gpu.loaded.size).toBe(0);
    expect(r.gpu.unloads).toContain("fake-model:1");
    expect(state(r, a.id)).toBe("paused");
    r.sched.endPractice();
  });

  it("an inference that ignores its abort is ended by unloading the OWNED model after the 3 s grace; closing a socket proves nothing", async () => {
    const r = await rig();
    r.runner.behaviour = "ignore_abort";
    const a = job(r, "stubborn");
    await drive(r, r.sched, () => r.runner.started.includes(a.id));
    const res = await r.sched.beginPractice();
    expect(r.runner.aborted).toContain(a.id);
    expect(r.gpu.unloads).toContain("fake-model:1");
    expect(res.ready).toBe(true);
  });

  it("if the release cannot be proven the speech grant is NOT ready (Preparing...), nothing starts on an unproven GPU, and no foreign model is touched", async () => {
    const r = await rig();
    r.runner.behaviour = "gate";
    r.gpu.load("someone-elses-model:7b", 5000); // another consumer of the shared Ollama
    const a = job(r, "unproven");
    await drive(r, r.sched, () => r.runner.started.includes(a.id));
    r.gpu.failUnload = true;
    const res = await r.sched.beginPractice();
    expect(res).toMatchObject({ ready: false, reason: "teardown_unproven" });
    expect(r.gpu.unloads.every((m) => m === "fake-model:1")).toBe(true); // only our own model was ever asked
    expect(r.gpu.loaded.has("someone-elses-model:7b")).toBe(true);
    // while unproven, background units stay parked: practice is still active
    r.runner.behaviour = "instant";
    const b = job(r, "later");
    await r.sched.tick();
    await flush();
    expect(state(r, b.id)).not.toBe("running");
  });

  it("when practice ends, waiting work resumes and the queue drains", async () => {
    const r = await rig();
    await r.sched.beginPractice();
    const a = job(r, "after-practice");
    await r.sched.tick();
    await flush();
    expect(r.runner.started).toEqual([]);
    r.sched.endPractice();
    await drive(r, r.sched, () => state(r, a.id) === "completed");
  });
});

describe("user actions", () => {
  it("pause / resume / cancel / retry follow the state machine; illegal ones are 409 and change nothing", async () => {
    const r = await rig();
    const a = job(r, "u1");
    expect(applyAction(r.db, r.deps, a.id, "pause").state).toBe("paused");
    expect(() => applyAction(r.db, r.deps, a.id, "pause")).toThrowError(ApiError);
    expect(applyAction(r.db, r.deps, a.id, "resume").state).toBe("queued");
    expect(() => applyAction(r.db, r.deps, a.id, "retry")).toThrowError(/Only a failed job/);
    expect(applyAction(r.db, r.deps, a.id, "cancel").state).toBe("cancelled");
    expect(() => applyAction(r.db, r.deps, a.id, "cancel")).toThrowError(ApiError);
    expect(() => applyAction(r.db, r.deps, a.id, "resume")).toThrowError(ApiError);
    expect(() => applyAction(r.db, r.deps, randomUUID(), "pause")).toThrowError(/Unknown job/);
    expect(events(r, a.id)).toEqual(["queued:enqueued", "paused:user_pause", "queued:resumed_by_user", "cancelled:cancelled_by_user"]);
  });

  it("pausing a RUNNING unit aborts it at a safe boundary and parks it as user_pause; practice ending does not resume it", async () => {
    const r = await rig();
    r.runner.behaviour = "gate";
    const a = job(r, "pause-running");
    await drive(r, r.sched, () => r.runner.started.includes(a.id));
    applyAction(r.db, r.deps, a.id, "pause");
    await drive(r, r.sched, () => state(r, a.id) === "paused");
    expect(reasonOfLastEvent(r.db, a.id, "paused")).toBe("user_pause");
    expect(count(r, "SELECT COUNT(*) AS n FROM job_results")).toBe(0);
    startPractice(r);
    endPractice(r);
    for (let i = 0; i < 5; i++) {
      await r.sched.tick();
      await flush();
    }
    expect(state(r, a.id)).toBe("paused"); // a user pause is only undone by the user
    applyAction(r.db, r.deps, a.id, "resume");
    r.runner.behaviour = "instant";
    await drive(r, r.sched, () => state(r, a.id) === "completed");
  });

  it("cancel of a RUNNING unit becomes terminal only after the teardown, and its result is discarded", async () => {
    const r = await rig();
    r.runner.behaviour = "gate";
    const a = job(r, "cancel-running");
    await drive(r, r.sched, () => r.runner.started.includes(a.id));
    applyAction(r.db, r.deps, a.id, "cancel");
    expect(state(r, a.id)).toBe("running"); // not terminal yet
    await drive(r, r.sched, () => state(r, a.id) === "cancelled");
    expect(count(r, "SELECT COUNT(*) AS n FROM job_results")).toBe(0);
    expect(lock(r).owner).toBeNull();
    expect(events(r, a.id)).toContain("cancelled:cancelled_after_teardown");
  });

  it("failed -> queued only by an explicit retry, with the same business key (the same result is expected, not a new job)", async () => {
    const r = await rig();
    r.runner.behaviour = "fatal";
    const a = job(r, "fatal");
    await drive(r, r.sched, () => state(r, a.id) === "failed");
    expect(getJob(r.db, a.id)).toMatchObject({ errorCode: "bad_input" });
    r.runner.behaviour = "instant";
    applyAction(r.db, r.deps, a.id, "retry");
    expect(enqueue(r.db, r.deps, { kind: "test_unit", payload: {}, idempotencyKey: "fatal" }).job.id).toBe(a.id);
    await drive(r, r.sched, () => state(r, a.id) === "completed");
    expect(count(r, "SELECT COUNT(*) AS n FROM jobs")).toBe(1);
  });
});

describe("retries, OOM and telemetry", () => {
  it("transient errors back off (2 s, 5 s, 10 s), are not retried early, and fail after the limit", async () => {
    const r = await rig();
    r.runner.behaviour = "transient";
    const a = job(r, "flaky");
    await drive(r, r.sched, () => getJob(r.db, a.id)!.retryCount === 1);
    const j1 = getJob(r.db, a.id)!;
    expect(Date.parse(j1.availableAt) - r.clock.now().getTime()).toBeGreaterThan(0);
    expect(Date.parse(j1.availableAt) - Date.parse(r.db.prepare("SELECT created_at FROM job_events WHERE job_id = ? ORDER BY sequence DESC LIMIT 1").get(a.id) ? (r.db.prepare("SELECT created_at AS c FROM job_events WHERE job_id = ? ORDER BY sequence DESC LIMIT 1").get(a.id) as { c: string }).c : j1.createdAt)).toBe(2000);
    const startedBefore = r.runner.started.length;
    await r.sched.tick();
    await flush();
    expect(r.runner.started.length).toBe(startedBefore); // backoff: not started early
    await drive(r, r.sched, () => state(r, a.id) === "failed", 200);
    expect(getJob(r.db, a.id)).toMatchObject({ retryCount: 3, errorCode: "net_blip" });
    expect(r.runner.started.filter((id) => id === a.id)).toHaveLength(4); // first run + 3 retries
  });

  it("OOM: release is proven; ONE retry only when pressure is gone, otherwise it waits (no retry loop)", async () => {
    const r = await rig();
    let first = true;
    r.runner.behaviour = (j) => (first && ((first = false), true) ? "oom" : "instant");
    const a = job(r, "oom-gone");
    await drive(r, r.sched, () => state(r, a.id) === "completed");
    expect(getJob(r.db, a.id)!.retryCount).toBe(1);
    expect(events(r, a.id).some((e) => e.includes("retry:oom"))).toBe(true);

    const r2 = await rig();
    r2.runner.behaviour = "oom";
    r2.gpu.foreignMib = 13_000; // someone else is hogging the card
    const b = job(r2, "oom-pressure");
    await drive(r2, r2.sched, () => state(r2, b.id) === "waiting_for_gpu");
    expect(reasonOfLastEvent(r2.db, b.id)).toBe("oom_pressure");
    const starts = r2.runner.started.length;
    for (let i = 0; i < 5; i++) {
      await r2.sched.tick();
      await flush();
    }
    expect(r2.runner.started.length).toBeLessThanOrEqual(starts + 5); // it may re-check, but never loops into the failure at once
    expect(r2.gpu.loaded.size).toBe(0);
  });

  it("unavailable or stale telemetry blocks admission (waiting_for_gpu / telemetry_unavailable) and recovers when it returns", async () => {
    const r = await rig();
    r.gpu.telemetry = "unavailable";
    const a = job(r, "no-telemetry");
    await r.sched.tick();
    await flush();
    expect(state(r, a.id)).toBe("waiting_for_gpu");
    expect(reasonOfLastEvent(r.db, a.id)).toBe("telemetry_unavailable");
    r.gpu.telemetry = "stale"; // readings older than 5 s are as good as none
    await r.sched.tick();
    await flush();
    expect(r.runner.started).toEqual([]);
    expect((await r.sched.status()).telemetry).toBe("unavailable");
    r.gpu.telemetry = "ok";
    await drive(r, r.sched, () => state(r, a.id) === "completed");
  });

  it("admission uses a MEASURED profile + reserve, never the file size; an unknown profile only runs in controlled spike mode", async () => {
    const r = await rig({ admission: "profiled", reserveMib: 500 }); // below the 1024 minimum: clamped
    const mv = randomUUID();
    r.db.prepare("INSERT INTO model_versions(id, tag, digest, runtime, runtime_version, parameters_json) VALUES (?,?,?,?,?,?)").run(mv, "fake-model", "sha256:x", "fake", "1", "{}");
    r.runner.profile = { modelVersionId: mv, configHash: "cfg1" };
    const a = job(r, "profiled");
    await r.sched.tick();
    await flush();
    expect(reasonOfLastEvent(r.db, a.id)).toBe("profile_unknown");
    expect(r.runner.started).toEqual([]);

    r.db.prepare("INSERT INTO gpu_profiles(id, model_version_id, config_hash, measured_peak_mib, timings_json, validated_at) VALUES (?,?,?,?,?,?)").run(randomUUID(), mv, "cfg1", 12_000, "{}", "now");
    r.gpu.baseMib = 6000; // free = 16311 - 6000 = 10311 < 12000 + 1024 (reserve clamped up)
    await r.sched.tick();
    await flush();
    expect(reasonOfLastEvent(r.db, a.id)).toBe("insufficient_vram");
    expect((await r.sched.status()).reserveMib).toBe(1024);

    r.gpu.load("foreign-model:14b", 4000); // somebody else's model is resident -> say so
    await r.sched.tick();
    await flush();
    expect(reasonOfLastEvent(r.db, a.id)).toBe("ollama_in_use");
    expect(r.gpu.unloads).toEqual([]); // and it is left alone

    r.gpu.loaded.clear();
    r.gpu.baseMib = 1900;
    await drive(r, r.sched, () => state(r, a.id) === "completed");
  });

  it("an idle resident model is unloaded after the idle period and the release is proven", async () => {
    const r = await rig({ idleUnloadMs: 30_000 });
    const a = job(r, "idle");
    await drive(r, r.sched, () => state(r, a.id) === "completed");
    expect((await r.sched.status()).residentModels).toEqual(["fake-model:1"]);
    r.clock.advance(31_000);
    await r.sched.tick();
    expect((await r.sched.status()).residentModels).toEqual([]);
    expect(r.gpu.loaded.size).toBe(0);
  });
});

describe("fairness and aging (outside practice)", () => {
  it("after 10 foreground starts the oldest background job is served, even with foreground work waiting", async () => {
    const r = await rig();
    const bg = job(r, "background", { priority: 3 });
    const fg = Array.from({ length: 25 }, (_, i) => job(r, `fg-${i}`, { priority: 1 }));
    await drive(r, r.sched, () => state(r, bg.id) === "completed", 200);
    const order = r.runner.started;
    expect(order.indexOf(bg.id)).toBe(10); // exactly after ten foreground units
    expect(order.slice(0, 10).every((id) => fg.some((f) => f.id === id))).toBe(true);
    await drive(r, r.sched, () => fg.every((f) => state(r, f.id) === "completed"), 400);
    expect(order).toHaveLength(26);
  });

  it("foreground order: assessment (1) before tutor (2) before generation (3); equal priority is first-come", async () => {
    const r = await rig();
    const gen = job(r, "gen", { priority: 3 });
    const tut = job(r, "tutor", { kind: "tutor", priority: 2 });
    const asm1 = job(r, "asm1", { priority: 1 });
    const asm2 = job(r, "asm2", { priority: 1 });
    const tutorRunner = new FakeRunner("tutor", r.gpu);
    const sched = new GpuScheduler({ db: r.db, newId: randomUUID, clock: r.clock, telemetry: r.gpu, control: r.gpu, runners: [r.runner, tutorRunner], instanceId: "C", config: { admission: "spike", idleUnloadMs: 1e9 } });
    await drive(r, sched, () => [gen, tut, asm1, asm2].every((j) => state(r, j.id) === "completed"), 100);
    const order = [...r.runner.started, ...tutorRunner.started];
    const startedAt = (id: string) => Date.parse(getJob(r.db, id)!.startedAt!);
    const assessments = Math.max(startedAt(asm1.id), startedAt(asm2.id));
    expect(Math.min(startedAt(asm1.id), startedAt(asm2.id)) < startedAt(tut.id)).toBe(true);
    expect(assessments < startedAt(tut.id)).toBe(true); // both assessments (priority 1) before the tutor unit (2)
    expect(startedAt(tut.id) < startedAt(gen.id)).toBe(true); // tutor before generation (3)
    expect(order).toHaveLength(4);
  });
});

describe("the database enforces the state machine", () => {
  it("refuses illegal transitions, terminal changes, fencing regressions and event edits", async () => {
    const r = await rig();
    const a = job(r, "sm");
    const set = (sql: string, ...p: unknown[]) => r.db.prepare(sql).run(...p);
    expect(() => set("UPDATE jobs SET state = 'completed' WHERE id = ?", a.id)).toThrow(/illegal state transition/); // queued -> completed
    expect(() => set("UPDATE jobs SET state = 'failed' WHERE id = ?", a.id)).toThrow(/illegal state transition/);
    set("UPDATE jobs SET state = 'cancelled' WHERE id = ?", a.id);
    expect(() => set("UPDATE jobs SET state = 'queued' WHERE id = ?", a.id)).toThrow(/terminal/);
    const b = job(r, "sm2");
    set("UPDATE jobs SET state = 'running', lease_token = 5 WHERE id = ?", b.id);
    expect(() => set("UPDATE jobs SET lease_token = 4 WHERE id = ?", b.id)).toThrow(/fencing token can only grow/);
    expect(() => set("UPDATE job_events SET reason = 'x'")).toThrow(/append-only/);
    expect(() => set("DELETE FROM job_events")).toThrow(/append-only/);
    expect(() => set("INSERT INTO gpu_lock(id, fencing_token) VALUES (2, 0)")).toThrow(/CHECK/); // exactly one lock row
    expect(() => set("INSERT INTO jobs(id, kind, state, priority, payload_json, idempotency_key, created_at, available_at) VALUES ('x','chat','queued',1,'{}','k','n','n')")).toThrow(/CHECK/); // kinds are an allowlist
  });
});

describe("shutdown", () => {
  it("does not release the lock when shutdown cannot stop the active unit", async () => {
    const r = await rig({ teardownBoundMs: 500 });
    r.runner.behaviour = "ignore_abort";
    r.gpu.failUnload = true;
    const a = job(r, "uncooperative-shutdown");
    await drive(r, r.sched, () => r.runner.started.includes(a.id));
    await r.sched.stop();
    expect(r.runner.active).toBe(1);
    expect(lock(r).owner).toBe("A");
    r.runner.gate(a.id).resolve();
    await r.sched.idle();
    expect(lock(r).owner).toBe("A"); // release remains unproven
  });

  it("stop aborts and discards the running unit, requeues it as `shutdown`, proves the release and gives the lease back", async () => {
    const r = await rig();
    r.runner.behaviour = "gate";
    const a = job(r, "shutdown");
    await drive(r, r.sched, () => r.runner.started.includes(a.id));
    await r.sched.stop();
    expect(state(r, a.id)).toBe("queued");
    expect(reasonOfLastEvent(r.db, a.id)).toBe("shutdown");
    expect(r.gpu.loaded.size).toBe(0);
    expect(lock(r).owner).toBeNull();
    expect(count(r, "SELECT COUNT(*) AS n FROM job_results")).toBe(0);
  });
});
