import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ErrorEnvelopeSchema, SessionBootstrapSchema } from "../../../packages/contracts/src/index.js";
import { buildApp } from "../../../apps/server/src/app.js";
import { SttWorker } from "../../../apps/server/src/adapters/stt/sttWorker.js";
import { recordAttempt } from "../../../apps/server/src/domain/attempts/attempts.js";
import { takeLease } from "../../../apps/server/src/domain/sessions/lease.js";
import { SttService } from "../../../apps/server/src/domain/stt/sttService.js";
import { GpuScheduler } from "../../../apps/server/src/queue/scheduler.js";
import { enqueue } from "../../../apps/server/src/queue/jobs.js";
import { FakeClock, FakeGpu, FakeRunner, flush } from "../../fixtures/queue/fakes.js";
import { addEvent, makeEnv, makeRevision, makeSession, makeSlot, one, rows, type Env } from "../attempts/fixtures.js";
import { freePort, projectRoot, testConfig } from "../helpers.js";

const FAKE = path.join(projectRoot, "tests", "fixtures", "stt", "fake-worker.mjs");
let env: Env | null = null;
let app: FastifyInstance | null = null;
const live: SttService[] = [];
afterEach(async () => {
  for (const s of live.splice(0)) await s.shutdown();
  await app?.close();
  app = null;
  env?.cleanup();
  env = null;
});

/** Distinctive PCM: if any of these bytes ever reached a file, the privacy test finds them. */
const MARK = Buffer.from([0x34, 0x12, 0x78, 0x56, 0xbc, 0x9a, 0xf0, 0xde]);
const pcm = (seconds = 1): Buffer => Buffer.concat(Array.from({ length: Math.ceil((seconds * 32000) / MARK.length) }, () => MARK)).subarray(0, seconds * 32000);

interface Rig {
  host: string;
  cookie: string;
  csrf: string;
  stt: SttService;
  scheduler: { calls: string[] };
  sessionId: string;
  slotId: string;
  tabId: string;
  spawned: SttWorker[];
  setMode: (m: string, extra?: Record<string, string>) => void;
  post: (url: string, body: unknown, h?: Record<string, string>) => ReturnType<FastifyInstance["inject"]>;
  postAudio: (id: string, body: Buffer, type?: string) => ReturnType<FastifyInstance["inject"]>;
}

async function rig(o: { idleMs?: number; model?: boolean; beginReady?: boolean } = {}): Promise<Rig> {
  env = await makeEnv();
  const calls: string[] = [];
  const spawned: SttWorker[] = [];
  let mode = "ok";
  let extra: Record<string, string> = {};
  const scheduler = {
    beginPractice: async () => {
      calls.push("begin");
      return o.beginReady === false ? { ready: false, reason: "teardown_unproven", elapsedMs: 1 } : { ready: true, reason: null, elapsedMs: 1 };
    },
    endPractice: () => void calls.push("end"),
  };
  const stt = new SttService({
    db: env.db,
    deps: { now: () => new Date(), newId: randomUUID },
    scheduler,
    available: () => o.model !== false,
    idleMs: o.idleMs,
    createWorker: () => {
      if (o.model === false) return null;
      const w = new SttWorker({ command: process.execPath, args: [FAKE], env: { FAKE_MODE: mode, ...extra } }, { startTimeoutMs: 3000, decodeTimeoutMs: 1500 });
      spawned.push(w);
      calls.push("spawn");
      return { worker: w, modelPath: path.join(env!.scratch.root, "snap-1") };
    },
  });
  live.push(stt);
  const port = await freePort();
  app = await buildApp({ config: testConfig(env.scratch.root, port), db: env.db, instanceId: "i", startedAt: "2026-01-01T00:00:00Z", shutdownToken: "t", onShutdown: () => {}, csrfSecret: Buffer.alloc(32, 5), stt });
  const host = `127.0.0.1:${port}`;
  const boot = await app.inject({ method: "GET", url: "/api/v1/session", headers: { host } });
  const csrf = SessionBootstrapSchema.parse(boot.json()).csrfToken;
  const cookie = String(boot.headers["set-cookie"]).split(";")[0]!;
  const rev = makeRevision(env, { type: "guided_short_answer", dimension: "production" });
  const sessionId = makeSession(env);
  const slotId = makeSlot(env, sessionId, rev, 0);
  addEvent(env, sessionId, slotId, "reveal");
  const tabId = "tab-1";
  takeLease(env.db, { now: () => new Date(), newId: randomUUID } as never, sessionId, tabId);
  return {
    host,
    cookie,
    csrf,
    stt,
    scheduler: { calls },
    sessionId,
    slotId,
    tabId,
    spawned,
    setMode: (m, e = {}) => ((mode = m), (extra = e)),
    post: (url, body, h = {}) => app!.inject({ method: "POST", url, payload: body as object, headers: { host, origin: `http://${host}`, cookie, "x-csrf-token": csrf, ...h } }),
    postAudio: (id, body, type = "application/octet-stream") => app!.inject({ method: "POST", url: `/api/v1/stt/${id}/audio`, payload: body, headers: { host, origin: `http://${host}`, cookie, "x-csrf-token": csrf, "content-type": type } }),
  };
}
const alive = (pid: number | null): boolean => {
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const code = (res: { json: () => unknown }) => ErrorEnvelopeSchema.parse(res.json()).error.code;
const start = async (r: Rig) => (await r.post("/api/v1/stt/start", { sessionId: r.sessionId, tabId: r.tabId })).json() as { streamId: string };

describe("voice session: start", () => {
  it("shuts down a worker even if startup has not completed", async () => {
    const r = await rig();
    r.setMode("no_ready");
    const pending = r.post("/api/v1/stt/start", { sessionId: r.sessionId, tabId: r.tabId });
    await expect.poll(() => r.spawned[0]?.alive ?? false, { timeout: 5000 }).toBe(true);
    await r.stt.shutdown();
    expect((await pending).statusCode).toBe(503);
    expect(r.stt.active).toBeNull();
    expect(r.spawned[0]!.alive).toBe(false);
    expect(r.scheduler.calls.at(-1)).toBe("end");
  }, 15_000);

  it("does not hang when the Python executable is missing", async () => {
    const worker = new SttWorker({ command: "__englishlab_missing_python__.exe", args: [] }, { startTimeoutMs: 1000 });
    await expect(worker.start()).rejects.toMatchObject({ code: "spawn_failed" });
    await expect(worker.stop(10)).resolves.toBeNull();
    expect(worker.alive).toBe(false);
  });
  it("takes the card BEFORE the worker is spawned and reports ready only after the worker's real warm-up", async () => {
    const r = await rig();
    const res = await r.post("/api/v1/stt/start", { sessionId: r.sessionId, tabId: r.tabId });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ maxSeconds: 60, maxBytes: 2 * 1024 * 1024, sampleRate: 16000, ready: { device: "fake" } });
    expect(r.scheduler.calls).toEqual(["begin", "spawn"]);
    expect(r.spawned[0]!.alive).toBe(true);
  });

  it("only the tab that holds the practice lease may use the microphone; an ended session cannot", async () => {
    const r = await rig();
    expect((await r.post("/api/v1/stt/start", { sessionId: r.sessionId, tabId: "other-tab" })).statusCode).toBe(409);
    expect(r.spawned).toHaveLength(0);
    expect((await r.post("/api/v1/stt/start", { sessionId: randomUUID(), tabId: "x" })).statusCode).toBeGreaterThanOrEqual(404);
    env!.db.prepare("UPDATE practice_leases SET expires_at = ? WHERE session_id = ?").run("2000-01-01T00:00:00.000Z", r.sessionId);
    expect((await r.post("/api/v1/stt/start", { sessionId: r.sessionId, tabId: r.tabId })).statusCode).toBe(409);
    expect((await r.post("/api/v1/stt/start", { sessionId: r.sessionId, tabId: r.tabId, extra: 1 })).statusCode).toBe(400);
  });

  it("falls back to typing with a clear reason when no model exists, the card is not free, or the worker cannot start", async () => {
    const none = await rig({ model: false });
    const a = await none.post("/api/v1/stt/start", { sessionId: none.sessionId, tabId: none.tabId });
    expect(a.statusCode).toBe(503);
    expect(code(a)).toBe("STT_UNAVAILABLE");
    expect(a.json()).toMatchObject({ error: { message: expect.stringContaining("Type your answer") } });
    await app!.close();
    env!.cleanup();

    const busy = await rig({ beginReady: false });
    const b = await busy.post("/api/v1/stt/start", { sessionId: busy.sessionId, tabId: busy.tabId });
    expect(code(b)).toBe("STT_PREPARING");
    expect(busy.spawned).toHaveLength(0); // nothing is loaded on an unproven card
    expect(busy.scheduler.calls).toEqual(["begin", "end"]);
    await app!.close();
    env!.cleanup();

    for (const m of ["load_error", "no_ready"]) {
      const bad = await rig();
      bad.setMode(m);
      const c = await bad.post("/api/v1/stt/start", { sessionId: bad.sessionId, tabId: bad.tabId });
      expect(c.statusCode, m).toBe(503);
      expect(code(c)).toBe("STT_START_FAILED");
      expect(bad.scheduler.calls.at(-1)).toBe("end"); // the card is handed back
      await expect.poll(() => alive(bad.spawned[0]!.pid), { timeout: 5000 }).toBe(false); // no orphan child
      await app!.close();
      env!.cleanup();
    }
  }, 60_000);
});

describe("voice session: audio, draft, confirm", () => {
  it("audio in -> editable draft text out -> confirmed text stored as a transcript (text only) -> a voice attempt", async () => {
    const r = await rig();
    const { streamId } = await start(r);
    const a = await r.postAudio(streamId, pcm(2));
    expect(a.statusCode).toBe(200);
    const draft = a.json() as { draftId: string; text: string; audioSeconds: number };
    expect(draft).toMatchObject({ text: "the employee stopped checking emails", audioSeconds: 2 });

    const edited = "The employee stopped checking emails.";
    const c = await r.post(`/api/v1/stt/${streamId}/confirm`, { draftId: draft.draftId, slotId: r.slotId, text: edited });
    expect(c.statusCode).toBe(201);
    const { transcriptId, edited: wasEdited } = c.json() as { transcriptId: string; edited: boolean };
    expect(wasEdited).toBe(true);
    const t = one<{ asr_text: string; submitted_text: string; edited: number }>(env!.db, "SELECT asr_text, submitted_text, edited FROM transcripts WHERE id = ?", transcriptId);
    expect(t).toEqual({ asr_text: "the employee stopped checking emails", submitted_text: edited, edited: 1 });
    expect((await r.post(`/api/v1/stt/${streamId}/confirm`, { draftId: draft.draftId, slotId: r.slotId, text: edited })).statusCode).toBe(404); // a draft is used once

    const att = recordAttempt(env!.db, { assessor: (await import("../../../apps/server/src/domain/attempts/ports.js")).PendingAssessor, outbox: (await import("../../../apps/server/src/domain/attempts/ports.js")).NullOutbox, now: () => new Date(), newId: randomUUID }, { slotId: r.slotId, submissionId: "voice-1", answer: edited, inputMode: "voice", transcriptId });
    expect(att.status).toBe(201);
    expect(one<{ input_mode: string; transcript_id: string }>(env!.db, "SELECT input_mode, transcript_id FROM attempts WHERE submission_id = 'voice-1'")).toEqual({ input_mode: "voice", transcript_id: transcriptId });
  });

  it("an unedited confirmation records edited=false; an empty text is refused", async () => {
    const r = await rig();
    const { streamId } = await start(r);
    const d = (await r.postAudio(streamId, pcm())).json() as { draftId: string; text: string };
    expect((await r.post(`/api/v1/stt/${streamId}/confirm`, { draftId: d.draftId, slotId: r.slotId, text: "   " })).statusCode).toBe(422);
    const ok = await r.post(`/api/v1/stt/${streamId}/confirm`, { draftId: d.draftId, slotId: r.slotId, text: d.text });
    expect(ok.json()).toMatchObject({ edited: false });
  });

  it("PRIVACY: no audio byte reaches the database, its WAL or any file under the data root; the schema has no audio column", async () => {
    const r = await rig();
    const { streamId } = await start(r);
    for (let i = 0; i < 3; i++) await r.postAudio(streamId, pcm(3));
    const d = (await r.postAudio(streamId, pcm(1))).json() as { draftId: string };
    await r.post(`/api/v1/stt/${streamId}/confirm`, { draftId: d.draftId, slotId: r.slotId, text: "the employee stopped checking emails" });
    await r.post(`/api/v1/stt/${streamId}/stop`, {});
    env!.db.pragma("wal_checkpoint(TRUNCATE)");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (readFileSync(p).includes(MARK)) hits.push(p);
      }
    };
    walk(env!.scratch.root);
    expect(hits).toEqual([]);
    for (const t of rows<{ name: string }>(env!.db, "SELECT name FROM sqlite_master WHERE type = 'table'")) {
      const cols = rows<{ name: string; type: string }>(env!.db, `PRAGMA table_info(${t.name})`);
      expect(cols.filter((c) => /audio|wav|pcm|blob/i.test(c.name) || c.type.toUpperCase() === "BLOB"), t.name).toEqual([]);
    }
  });

  it("refuses bad audio: too short, odd length, too long, wrong content type, unknown stream; the stream survives", async () => {
    const r = await rig();
    const { streamId } = await start(r);
    expect(code(await r.postAudio(streamId, Buffer.alloc(100)))).toBe("AUDIO_TOO_SHORT");
    expect(code(await r.postAudio(streamId, Buffer.alloc(3201)))).toBe("AUDIO_ODD_LENGTH");
    expect(code(await r.postAudio(streamId, Buffer.alloc(2 * 1024 * 1024 + 2)))).toBe("AUDIO_TOO_LONG");
    expect((await r.postAudio(streamId, Buffer.from('{"a":1}'), "application/json")).statusCode).toBe(415);
    expect((await r.postAudio(randomUUID(), pcm())).statusCode).toBe(404);
    expect((await r.postAudio(streamId, Buffer.alloc(3 * 1024 * 1024))).statusCode).toBe(413); // over the transport limit: never buffered by the worker
    expect((await r.postAudio(streamId, pcm())).statusCode).toBe(200);
  });
});

describe("voice session: failure, teardown, one at a time", () => {
  it("a worker that crashes mid-decode ends the stream, frees the card and leaves typing available", async () => {
    const r = await rig();
    r.setMode("crash_on_decode");
    const { streamId } = await start(r);
    const bad = await r.postAudio(streamId, pcm());
    expect(bad.statusCode).toBe(503);
    expect(code(bad)).toBe("STT_WORKER_FAILED");
    expect(r.scheduler.calls.at(-1)).toBe("end");
    expect((await r.postAudio(streamId, pcm())).statusCode).toBe(404);
    expect(r.stt.active).toBeNull();
    await expect.poll(() => alive(r.spawned[0]!.pid), { timeout: 5000 }).toBe(false);
  }, 30_000);

  it("a worker that stops answering is ended after the timeout (its own process only)", async () => {
    const r = await rig();
    r.setMode("hang_on_decode");
    const { streamId } = await start(r);
    const res = await r.postAudio(streamId, pcm());
    expect(code(res)).toBe("STT_WORKER_FAILED");
    await expect.poll(() => alive(r.spawned[0]!.pid), { timeout: 5000 }).toBe(false);
    expect(process.kill(process.pid, 0)).toBe(true); // we are still here
  }, 30_000);

  it("finishing the practice session, stopping, or shutting down stops the child and gives the card back", async () => {
    const r = await rig();
    const { streamId } = await start(r);
    const pid = r.spawned[0]!.pid;
    expect(alive(pid)).toBe(true);
    const fin = await r.post(`/api/v1/sessions/${r.sessionId}/finish`, { mode: "ended_early" });
    expect(fin.statusCode).toBeLessThan(300);
    await expect.poll(() => alive(pid), { timeout: 5000 }).toBe(false);
    expect(r.scheduler.calls.at(-1)).toBe("end");
    expect((await r.postAudio(streamId, pcm())).statusCode).toBe(404);
  }, 30_000);

  it("an idle voice session closes itself; losing the lease closes it on the next audio", async () => {
    const idle = await rig({ idleMs: 100 });
    await start(idle);
    const pid = idle.spawned[0]!.pid;
    await expect.poll(() => idle.stt.active, { timeout: 8000 }).toBeNull();
    await expect.poll(() => alive(pid), { timeout: 5000 }).toBe(false);
    await app!.close();
    env!.cleanup();

    const r = await rig();
    const { streamId } = await start(r);
    env!.db.prepare("UPDATE practice_leases SET expires_at = ? WHERE session_id = ?").run("2000-01-01T00:00:00.000Z", r.sessionId);
    expect((await r.postAudio(streamId, pcm())).statusCode).toBe(409);
    expect(r.stt.active).toBeNull();
  }, 30_000);

  it("only one voice stream exists: starting for another session replaces (and stops) the first", async () => {
    const r = await rig();
    await start(r);
    const first = r.spawned[0]!;
    const rev = makeRevision(env!, { type: "guided_short_answer", dimension: "production" });
    const s2 = makeSession(env!);
    makeSlot(env!, s2, rev, 0);
    takeLease(env!.db, { now: () => new Date(), newId: randomUUID } as never, s2, "tab-2");
    const res = await r.post("/api/v1/stt/start", { sessionId: s2, tabId: "tab-2" });
    expect(res.statusCode).toBe(201);
    await expect.poll(() => alive(first.pid), { timeout: 5000 }).toBe(false);
    expect(r.stt.active?.sessionId).toBe(s2);
  }, 30_000);

  it("the same tab starting again reuses its running worker instead of spawning another", async () => {
    const r = await rig();
    const a = await start(r);
    const b = await start(r);
    expect(b.streamId).toBe(a.streamId);
    expect(r.spawned).toHaveLength(1);
  });

  it("/capabilities tells the truth about voice", async () => {
    const r = await rig();
    const ok = (await app!.inject({ method: "GET", url: "/api/v1/capabilities", headers: { host: r.host } })).json() as { stt: { status: string } };
    expect(ok.stt.status).toBe("ready");
    await app!.close();
    env!.cleanup();
    const none = await rig({ model: false });
    const un = (await app!.inject({ method: "GET", url: "/api/v1/capabilities", headers: { host: none.host } })).json() as { stt: { status: string } };
    expect(un.stt.status).toBe("unavailable");
  });
});

describe("voice has the highest priority on the single dispatcher", () => {
  it("a running background job is stopped and its model unloaded (proven) BEFORE the worker is spawned", async () => {
    env = await makeEnv();
    const clock = new FakeClock();
    const gpu = new FakeGpu(clock);
    const runner = new FakeRunner("test_unit", gpu);
    runner.behaviour = "gate";
    const sched = new GpuScheduler({ db: env.db, newId: randomUUID, clock, telemetry: gpu, control: gpu, runners: [runner], instanceId: "A", config: { admission: "spike", idleUnloadMs: 600_000 } });
    const job = enqueue(env.db, { now: () => clock.now(), newId: randomUUID }, { kind: "test_unit", payload: {}, idempotencyKey: "bg", priority: 3 }).job;
    for (let i = 0; i < 10 && !runner.started.includes(job.id); i++) {
      await sched.tick();
      await flush();
      clock.advance(500);
    }
    expect(runner.started).toContain(job.id);
    expect(gpu.loaded.size).toBe(1);

    const order: string[] = [];
    const stt = new SttService({
      db: env.db,
      deps: { now: () => new Date(), newId: randomUUID },
      scheduler: sched,
      available: () => true,
      createWorker: () => {
        order.push(`spawn(modelsLoaded=${gpu.loaded.size})`);
        return { worker: new SttWorker({ command: process.execPath, args: [FAKE] }, { startTimeoutMs: 3000 }), modelPath: "x" };
      },
    });
    live.push(stt);
    const sessionId = makeSession(env);
    takeLease(env.db, { now: () => new Date(), newId: randomUUID } as never, sessionId, "tab");
    // the real dispatcher's practice gate polls a virtual clock: let it advance while we wait
    const ticking = (async () => {
      for (let i = 0; i < 200; i++) {
        await flush();
        clock.advance(250);
        await new Promise((r) => setTimeout(r, 5));
      }
    })();
    const s = await stt.start(sessionId, "tab");
    await ticking;
    expect(s.streamId).toBeTruthy();
    expect(gpu.unloads).toContain("fake-model:1");
    expect(order).toEqual(["spawn(modelsLoaded=0)"]); // the card was free when the child was created
    await stt.shutdown();
    runner.gate(job.id).resolve();
  }, 60_000);
});
