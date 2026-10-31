// Real processes: the built server (apps/server/dist), scripts/start|stop|backup, real loopback ports, real SQLite.
// Requires `npm run build` first (the documented sequence is npm ci -> build -> tests).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS_V1, HealthSchema } from "../../../packages/contracts/src/index.js";
import { openDatabase } from "../../../apps/server/src/db/open.js";
import { isPidAlive } from "../../../apps/server/src/processIdentity.js";
import { freePort, makeScratchRoot, projectRoot } from "../helpers.js";

const serverEntry = path.join(projectRoot, "apps", "server", "dist", "index.js");
let scratch: ReturnType<typeof makeScratchRoot>;
let port: number;
let env: NodeJS.ProcessEnv;
const lockPath = () => path.join(scratch.root, "run", "server.lock.json");
const dbPath = () => path.join(scratch.root, "db", "english-lab.sqlite");

beforeEach(async () => {
  expect(existsSync(serverEntry), "run `npm run build` before the lifecycle tests").toBe(true);
  scratch = makeScratchRoot();
  port = await freePort();
  env = { ...process.env, ENGLISHLAB_DATA_ROOT: scratch.root, ENGLISHLAB_PORT: String(port), ENGLISHLAB_NO_OPEN: "1" };
});
afterEach(() => {
  // safety net: stop whatever this test left running, using only the pid recorded in its own lock
  try {
    const lock = JSON.parse(readFileSync(lockPath(), "utf8")) as { pid: number };
    if (isPidAlive(lock.pid)) process.kill(lock.pid);
  } catch {
    /* no lock */
  }
  scratch.cleanup();
});

const script = (name: string, ...args: string[]) =>
  spawnSync(process.execPath, [path.join(projectRoot, "scripts", `${name}.mjs`), ...args], { env, encoding: "utf8", timeout: 90_000 });

function rawGet(headers: Record<string, string>, urlPath = "/api/v1/health"): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: urlPath, method: "GET", headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("start / stop scripts with a real server process", () => {
  it("starts on loopback, serves the built shell, keeps data across restart, and stops only its own PID", async () => {
    const start = script("start");
    expect(start.status, start.stdout + start.stderr).toBe(0);
    const lock1 = JSON.parse(readFileSync(lockPath(), "utf8")) as { pid: number; instanceId: string; port: number };
    expect(lock1.port).toBe(port);
    expect(isPidAlive(lock1.pid)).toBe(true);

    // same-origin shell + API
    const shell = await rawGet({ accept: "text/html" }, "/");
    expect(shell.status).toBe(200);
    expect(shell.body).toContain("<title>English Lab</title>");
    const spa = await rawGet({ accept: "text/html" }, "/some/client/route");
    expect(spa.status).toBe(200);
    const health = HealthSchema.parse(JSON.parse((await rawGet({})).body));
    expect(health).toMatchObject({ status: "ok", instanceId: lock1.instanceId });
    expect(health.db.schemaVersion).toBe(19);

    // foreign Origin / Host rejected by the real process
    expect((await rawGet({ origin: "https://evil.example" })).status).toBe(403);
    expect((await rawGet({ host: "evil.example" })).status).toBe(403);

    // a second start does not spawn a second writer: it reports the running instance
    const again = script("start");
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("already running");
    expect(JSON.parse(readFileSync(lockPath(), "utf8")).pid).toBe(lock1.pid);

    // a second server process is refused by the singleton lock (exit code 3), without touching the first
    const second = spawnSync(process.execPath, [serverEntry], { env, encoding: "utf8", timeout: 60_000 });
    expect(second.status).toBe(3);
    expect(isPidAlive(lock1.pid)).toBe(true);

    // persist a new settings revision through a separate connection while the server runs (WAL)
    const d = openDatabase(dbPath());
    d.prepare("INSERT INTO settings_revisions(id,revision,values_json,created_at) VALUES ('r2',2,?,?)").run(JSON.stringify({ ...DEFAULT_SETTINGS_V1, taskCount: 20 }), new Date().toISOString());
    const appliedAt = (d.prepare("SELECT applied_at FROM schema_migrations WHERE version=1").get() as { applied_at: string }).applied_at;
    d.close();

    const stop = script("stop");
    expect(stop.status, stop.stdout + stop.stderr).toBe(0);
    expect(isPidAlive(lock1.pid)).toBe(false);
    expect(existsSync(lockPath())).toBe(false);
    await expect(rawGet({})).rejects.toThrow(); // nothing listens any more

    // restart: same DB, settings kept, migration not re-applied, a daily backup now exists
    const restart = script("start");
    expect(restart.status, restart.stdout + restart.stderr).toBe(0);
    const lock2 = JSON.parse(readFileSync(lockPath(), "utf8")) as { pid: number; instanceId: string };
    expect(lock2.pid).not.toBe(lock1.pid);
    expect(lock2.instanceId).not.toBe(lock1.instanceId);
    const d2 = openDatabase(dbPath());
    expect((d2.prepare("SELECT values_json FROM settings_revisions WHERE revision=2").get() as { values_json: string }).values_json).toContain('"taskCount":20');
    expect((d2.prepare("SELECT applied_at FROM schema_migrations WHERE version=1").get() as { applied_at: string }).applied_at).toBe(appliedAt);
    expect((d2.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }).n).toBe(19);
    d2.close();
    const backups = path.join(scratch.root, "backups");
    expect(existsSync(backups)).toBe(true);
    expect(script("stop").status).toBe(0);
  });

  it("does not reuse a busy port: exits with code 4, leaves no lock and the DB intact", async () => {
    // The foreign listener runs in its own process: spawnSync below blocks this one's event loop.
    const blocker = spawn(
      process.execPath,
      ["-e", `const s=require("net").createServer(c=>c.on("error",()=>{}));s.listen(${port},"127.0.0.1",()=>console.log("listening"));setTimeout(()=>{},120000)`],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    try {
      await new Promise<void>((r) => blocker.stdout!.once("data", () => r()));
      const start = script("start");
      expect(start.status, start.stdout + start.stderr).toBe(4);
      expect(start.stderr).toContain("already in use");
      expect(existsSync(lockPath())).toBe(false);
      // the foreign listener is untouched and still ours
      expect(isPidAlive(blocker.pid!)).toBe(true);
      const probe = await new Promise<boolean>((r) => net.connect(port, "127.0.0.1").once("connect", () => r(true)).once("error", () => r(false)));
      expect(probe).toBe(true);
    } finally {
      blocker.kill();
    }
  });

  it("binds only to loopback (not reachable via the machine's LAN address)", async () => {
    expect(script("start").status).toBe(0);
    const lan = Object.values(os.networkInterfaces())
      .flat()
      .find((i) => i && i.family === "IPv4" && !i.internal);
    if (lan) {
      const reachable = await new Promise<boolean>((r) => {
        const s = net.connect({ host: lan.address, port, timeout: 3000 });
        s.once("connect", () => (s.destroy(), r(true)));
        s.once("error", () => r(false));
        s.once("timeout", () => (s.destroy(), r(false)));
      });
      expect(reachable, `reachable on ${lan.address}`).toBe(false);
    }
    expect(script("stop").status).toBe(0);
  });

  it("stop never touches an unrelated process when the lock is stale or the PID was recycled", async () => {
    const bystander = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], { stdio: "ignore" });
    try {
      mkdirSync(path.dirname(lockPath()), { recursive: true });
      // a lock that names the bystander's live PID but a different start identity => recycled PID => stale
      writeFileSync(
        lockPath(),
        JSON.stringify({ pid: bystander.pid, processStartTime: "2000-01-01T00:00:00.0000000Z", instanceId: "old", startedAt: "2000-01-01T00:00:00Z", port, shutdownToken: "x" }),
      );
      const stop = script("stop");
      expect(stop.status, stop.stdout + stop.stderr).toBe(0);
      expect(stop.stdout).toContain("stale");
      expect(isPidAlive(bystander.pid!)).toBe(true);
      expect(existsSync(lockPath())).toBe(false);
    } finally {
      bystander.kill();
    }
  });

  it("an unreadable lock is not deleted blindly", () => {
    mkdirSync(path.dirname(lockPath()), { recursive: true });
    writeFileSync(lockPath(), "{garbage");
    const r = spawnSync(process.execPath, [serverEntry], { env, encoding: "utf8", timeout: 60_000 });
    expect(r.status).toBe(3);
    expect(readFileSync(lockPath(), "utf8")).toBe("{garbage");
  });

  it("backup script produces a verified backup of the live database", () => {
    expect(script("start").status).toBe(0);
    const b = script("backup");
    expect(b.status, b.stdout + b.stderr).toBe(0);
    const out = JSON.parse(b.stdout) as { kind: string; verify: { checksumOk: boolean; integrity: string; foreignKeyViolations: number } };
    expect(out.kind).toBe("manual");
    expect(out.verify).toEqual({ checksumOk: true, integrity: "ok", foreignKeyViolations: 0 });
    expect(script("stop").status).toBe(0);
  });
});
