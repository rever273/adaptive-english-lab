// npm start: launches the backend detached (it outlives this script and the browser tab), waits until
// *this* instance answers on /api/v1/health, then opens the browser. Never reuses a busy port blindly.
// npm run lab (--attached): the same, but the server stays in this console window and Ctrl+C stops it gracefully.
import { execFile, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { loadServerModule, requireBuild, serverEntry, projectRoot } from "./_common.mjs";

requireBuild();
const { loadConfig } = await loadServerModule("config.js");
const { readLock, classifyLock } = await loadServerModule("lock.js");

const noOpen = process.argv.includes("--no-open") || process.env.ENGLISHLAB_NO_OPEN === "1";
const attached = process.argv.includes("--attached");
const config = loadConfig();
const url = `http://127.0.0.1:${config.port}/`;

function openBrowser() {
  if (noOpen) return;
  execFile("rundll32.exe", ["url.dll,FileProtocolHandler", url], { windowsHide: true }, () => {});
}

async function getHealth(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

const existing = readLock(config.lockPath);
if (existing && classifyLock(existing) !== "stale") {
  const health = await getHealth(existing.port);
  if (health && health.instanceId === existing.instanceId) {
    console.log(`English Lab is already running (pid ${existing.pid}) at http://127.0.0.1:${existing.port}/`);
    openBrowser();
    process.exit(0);
  }
  console.error(`A lock exists for pid ${existing.pid} but it is not answering as English Lab. Not touching it; see ${config.lockPath}`);
  process.exit(1);
}

mkdirSync(config.logsDir, { recursive: true });
const outPath = path.join(config.logsDir, "server.stdout.log");
const out = attached ? null : openSync(outPath, "a");
const child = spawn(process.execPath, [serverEntry], {
  cwd: projectRoot,
  detached: !attached,
  windowsHide: !attached,
  stdio: attached ? ["ignore", "inherit", "inherit"] : ["ignore", out, out],
  env: process.env,
});
if (out !== null) closeSync(out);
// attached: Ctrl+C reaches the server too (same console); this script just waits for it to finish its graceful shutdown
if (attached) process.on("SIGINT", () => console.log("Stopping English Lab…"));
let exitCode = null;
child.once("exit", (code) => {
  exitCode = code ?? -1;
});
if (!attached) child.unref();

const REASONS = { 2: "invalid configuration", 3: "another instance holds the lock", 4: `port ${config.port} is already in use (not reused)`, 5: "database not usable" };
const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  if (exitCode !== null) {
    const tail = existsSync(outPath) ? readFileSync(outPath, "utf8").trim().split(/\r?\n/).slice(-5).join("\n") : "";
    console.error(`Server exited with code ${exitCode}: ${REASONS[exitCode] ?? "see log"}\n${tail}`);
    process.exit(exitCode || 1);
  }
  const health = await getHealth(config.port);
  const lock = readLock(config.lockPath);
  if (health && lock && lock.pid === child.pid && health.instanceId === lock.instanceId) {
    console.log(`English Lab started (pid ${child.pid}) at ${url}  [status: ${health.status}, schema v${health.db.schemaVersion}]`);
    openBrowser();
    if (!attached) process.exit(0);
    console.log("Press Ctrl+C to stop.");
    child.once("exit", (code) => process.exit(code ?? 0));
    await new Promise(() => {});
  }
  await new Promise((r) => setTimeout(r, 300));
}
console.error("Timed out waiting for the server to become healthy; see var/logs/server.log");
process.exit(1);
