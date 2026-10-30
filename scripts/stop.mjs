// npm run stop: addresses only the PID + start identity recorded in the lock file.
// Graceful path: authenticated POST /internal/shutdown (stop admission, WAL checkpoint, close, exit).
// Never touches Ollama or any other process.
import { rmSync } from "node:fs";
import { loadServerModule, requireBuild } from "./_common.mjs";

requireBuild({ web: false });
const { loadConfig } = await loadServerModule("config.js");
const { readLock, classifyLock } = await loadServerModule("lock.js");
const { isPidAlive } = await loadServerModule("processIdentity.js");

const force = process.argv.includes("--force");
const config = loadConfig();
const lock = readLock(config.lockPath);

if (!lock) {
  console.log("English Lab is not running (no lock file).");
  process.exit(0);
}
const state = classifyLock(lock);
if (state === "stale") {
  rmSync(config.lockPath, { force: true });
  console.log(`Removed stale lock (pid ${lock.pid} is not this application any more). Nothing was running.`);
  process.exit(0);
}
if (state === "unverifiable") {
  console.error(`Pid ${lock.pid} is alive but its identity cannot be verified; refusing to stop it.`);
  process.exit(1);
}

try {
  const res = await fetch(`http://127.0.0.1:${lock.port}/internal/shutdown`, {
    method: "POST",
    headers: { "x-shutdown-token": lock.shutdownToken },
    signal: AbortSignal.timeout(5000),
  });
  if (res.status !== 202) console.error(`Shutdown endpoint answered ${res.status}`);
} catch (err) {
  console.error(`Graceful shutdown request failed: ${err.message}`);
}

const deadline = Date.now() + 20_000;
while (Date.now() < deadline && isPidAlive(lock.pid)) await new Promise((r) => setTimeout(r, 200));

if (isPidAlive(lock.pid)) {
  if (!force) {
    console.error(`Pid ${lock.pid} is still running. Re-run with --force to terminate that verified process.`);
    process.exit(1);
  }
  if (classifyLock(lock) === "alive") process.kill(lock.pid);
  console.log(`Forced termination of pid ${lock.pid}.`);
  rmSync(config.lockPath, { force: true });
} else {
  console.log(`English Lab stopped (pid ${lock.pid}).`);
}
