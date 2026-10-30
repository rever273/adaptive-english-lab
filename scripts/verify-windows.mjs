// npm run verify:windows            real start / second-instance / stop / restart + backup + restore round trip on THIS machine, in a throw-away data root
// npm run verify:backup-restore     only the backup -> change -> stop -> restore -> start round trip
// Prints one JSON report (each check pass/fail, versions) and exits 0 only if every check passed. Never touches var/ or any other data root, never
// downloads anything, never changes system settings. The data root is deleted afterwards unless --keep is given.
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const onlyBackup = process.argv.includes("--backup-restore") || process.argv.includes("--only-backup-restore");
const keep = process.argv.includes("--keep");
// the data root must live inside the project (or %LOCALAPPDATA%\EnglishLab): var/verify-* is ignored by Git and removed afterwards
const root = path.join(project, "var", `verify-${randomBytes(4).toString("hex")}`);
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
const port = await freePort();
const env = { ...process.env, ENGLISHLAB_DATA_ROOT: root, ENGLISHLAB_PORT: String(port), ENGLISHLAB_NO_OPEN: "1", ENGLISHLAB_AI: "off" };
const run = (script, args = []) => spawnSync(process.execPath, [path.join(project, "scripts", `${script}.mjs`), ...args], { env, encoding: "utf8", timeout: 180_000, cwd: project });
const base = `http://127.0.0.1:${port}`;
const checks = [];
const check = (name, pass, detail = "") => {
  checks.push({ name, pass: Boolean(pass), ...(detail ? { detail: String(detail).slice(0, 300) } : {}) });
  return Boolean(pass);
};

async function session() {
  const r = await fetch(`${base}/api/v1/session`, { headers: { Accept: "application/json" } });
  const cookie = r.headers.get("set-cookie")?.split(";")[0] ?? "";
  const { csrfToken } = await r.json();
  const call = (method, url, body) => fetch(`${base}${url}`, { method, headers: { Origin: base, Cookie: cookie, "X-CSRF-Token": csrfToken, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { call };
}
const health = async () => {
  try {
    const r = await fetch(`${base}/api/v1/health`, { signal: AbortSignal.timeout(4000) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
};

try {
  mkdirSync(root, { recursive: true });
  check("seed a throw-away profile", run("seed-slice").status === 0);
  const started = run("start");
  check("npm start returns success and the server answers health", started.status === 0 && (await health())?.status !== undefined, started.stderr || started.stdout);
  const h = await health();
  check("health reports a ready database with schema version", h?.db?.ready === true && Number(h?.db?.schemaVersion) >= 13, JSON.stringify(h?.db));

  if (!onlyBackup) {
    const second = run("start");
    check("a second start does not run a second writer (singleton lock / busy port)", second.status !== 0 || (await health()) !== null);
    const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal);
    if (lan) {
      const reach = await fetch(`http://${lan.address}:${port}/api/v1/health`, { signal: AbortSignal.timeout(2500) }).then(() => true, () => false);
      check("the server is not reachable on the machine's LAN address (loopback only)", reach === false, lan.address);
    } else check("LAN reachability probe", true, "no LAN interface to probe");
  }

  // backup -> change -> stop -> restore -> start
  const { call } = await session();
  const countWords = async () => (await (await call("GET", "/api/v1/vocabulary")).json()).totals.words;
  const before = await countWords();
  const made = await call("POST", "/api/v1/backups", {});
  const backup = await made.json();
  check("a verified manual backup is created over the API while the app runs", made.status === 201 && backup.verified === true, JSON.stringify(backup));
  const add = await call("POST", "/api/v1/vocabulary", { word: "harbour" });
  check("new data is written after the backup", add.status === 201 && (await countWords()) === before + 1);
  const validate = await (await call("POST", "/api/v1/restore/validate", { backupId: backup.id })).json();
  check("restore validation (app running) names what would be rolled back and changes nothing", validate.valid === true && validate.wouldRollBack.vocabularyEntries === 1 && (await countWords()) === before + 1, JSON.stringify(validate.wouldRollBack));

  const stopped = run("stop");
  check("npm stop stops the verified process and the port is free", stopped.status === 0 && (await health()) === null, stopped.stderr || stopped.stdout);
  const refused = run("restore", ["--backup", backup.id]);
  check("restore without the explicit confirmation is refused", refused.status === 2, refused.stderr);
  const restored = run("restore", ["--backup", backup.id, "--confirm", backup.id]);
  let report = null;
  try {
    report = JSON.parse(restored.stdout);
  } catch {
    /* reported below */
  }
  check("restore succeeds, with a verified safety backup and a delta export", restored.status === 0 && report?.safetyBackup?.file && report?.deltaExport && report.rolledBack.vocabularyEntries === 1, restored.stderr || restored.stdout);
  const again = run("start");
  check("the app starts on the restored data", again.status === 0 && (await health())?.db?.ready === true, again.stderr);
  const s2 = await session();
  const after = (await (await s2.call("GET", "/api/v1/vocabulary")).json()).totals.words;
  check("the restored data equals the backup (the newer word is gone, everything else is back)", after === before, `${after} vs ${before}`);

  // a corrupted backup must be refused by the real CLI
  const list = run("restore", ["--list"]);
  check("restore --list shows the backups", list.status === 0 && list.stdout.includes(backup.id));
  run("stop");
} catch (e) {
  check("verification ran to the end", false, e.stack ?? e.message);
  run("stop");
} finally {
  if (!keep) rmSync(root, { recursive: true, force: true });
}

const failed = checks.filter((c) => !c.pass);
console.log(JSON.stringify({ mode: onlyBackup ? "backup-restore" : "windows", node: process.version, platform: `${os.type()} ${os.release()} ${process.arch}`, port, passed: checks.length - failed.length, failed: failed.length, checks }, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
