// TASK_018 / A10, A11: closing the browser does not stop anything, a killed server (no graceful shutdown) loses no saved answer and resumes the
// session after the next start, and no audio file or answer text ends up outside the database (logs, exports, temp files).
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freePort, makeScratchRoot, projectRoot } from "../../integration/helpers.js";

const T = { timeout: 20_000 };
const SHOTS = path.join(projectRoot, "documentation", "spec", "evidence", "task-018", "screenshots");
const MARKER = "zebra-marker-7731";
let scratch: ReturnType<typeof makeScratchRoot>;
let base: string;
let env: NodeJS.ProcessEnv;
let browser: Browser;
const steps: unknown[] = [];
const dbFile = () => path.join(scratch.root, "db", "english-lab.sqlite");
const script = (name: string, args: string[] = []) => spawnSync(process.execPath, [path.join(projectRoot, "scripts", `${name}.mjs`), ...args], { env, encoding: "utf8", timeout: 120_000 });
const q = <X>(sql: string, ...p: unknown[]): X[] => {
  const d = new Database(dbFile(), { readonly: true });
  try {
    return d.prepare(sql).all(...p) as X[];
  } finally {
    d.close();
  }
};
const health = async () => fetch(`${base}/api/v1/health`, { signal: AbortSignal.timeout(3000) }).then((r) => (r.ok ? r.json() : null), () => null);
function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

beforeAll(async () => {
  scratch = makeScratchRoot();
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  env = { ...process.env, ENGLISHLAB_DATA_ROOT: scratch.root, ENGLISHLAB_PORT: String(port), ENGLISHLAB_NO_OPEN: "1", ENGLISHLAB_AI: "off" };
  expect(script("seed-slice").status).toBe(0);
  expect(script("start").status).toBe(0);
  browser = await chromium.launch({ channel: "msedge", headless: true });
});
afterAll(async () => {
  await browser?.close();
  script("stop");
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(path.join(SHOTS, "recovery-report.json"), JSON.stringify({ browser: "msedge (installed)", base, steps }, null, 2));
  scratch?.cleanup();
});

async function typedAnswerSession(page: Page) {
  await page.goto(base);
  await page.getByTestId("start").click();
  for (let i = 0; i < 18; i++) {
    await page.getByTestId("slot").waitFor(T);
    if ((await page.locator("textarea").count()) > 0) {
      await page.locator("textarea").fill(MARKER);
      await page.getByTestId("submit").click();
      await page.getByTestId("feedback").waitFor(T);
      return;
    }
    await page.getByTestId("skip").click();
    await page.waitForTimeout(250);
  }
  throw new Error("no typed-answer task found");
}

describe("persistence and crash recovery", () => {
  let sessionId = "";
  let attempts = 0;

  it("closing the browser leaves the server and the session untouched; a new browser resumes the same session", async () => {
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
    await typedAnswerSession(await ctx.newPage());
    sessionId = q<{ id: string }>("SELECT id FROM sessions WHERE status = 'active'")[0]!.id;
    attempts = q<{ n: number }>("SELECT COUNT(*) AS n FROM attempts")[0]!.n;
    expect(attempts).toBe(1);
    await ctx.close(); // the learner closes the browser
    expect((await health())?.db?.ready).toBe(true);

    const ctx2 = await browser.newContext({ viewport: { width: 1100, height: 800 } });
    const page = await ctx2.newPage();
    await page.goto(base);
    const cur = (await page.evaluate(async () => (await fetch("/api/v1/sessions/current")).json())) as { session: { sessionId: string; status: string } | null };
    expect(cur.session?.sessionId).toBe(sessionId);
    expect(cur.session?.status).toBe("active");
    await page.screenshot({ path: path.join(SHOTS, "01-resume-after-browser-close.png"), fullPage: true });
    steps.push({ browserClose: "session resumed in a new browser", sessionId });
    await ctx2.close();
  });

  it("a hard-killed server (no graceful shutdown) loses no saved answer, and the next start resumes the session", async () => {
    const lockFile = walk(scratch.root).find((f) => f.endsWith(".lock") || path.basename(f).includes("lock"));
    expect(lockFile, "the singleton lock file").toBeTruthy();
    const pid = (JSON.parse(readFileSync(lockFile!, "utf8")) as { pid: number }).pid;
    process.kill(pid, "SIGKILL"); // power-loss style: no shutdown handler runs
    for (let i = 0; i < 40 && (await health()) !== null; i++) await new Promise((r) => setTimeout(r, 250));
    expect(await health()).toBeNull();

    const started = script("start");
    expect(started.status, started.stderr).toBe(0);
    expect((await health())?.db?.ready).toBe(true);
    expect(q<{ n: number }>("SELECT COUNT(*) AS n FROM attempts")[0]!.n).toBe(attempts); // the answer was already durable
    expect(q<{ raw: string }>("SELECT raw_answer_json AS raw FROM attempts")[0]!.raw).toContain(MARKER);
    const page = await (await browser.newContext()).newPage();
    await page.goto(base);
    const cur = (await page.evaluate(async () => (await fetch("/api/v1/sessions/current")).json())) as { session: { sessionId: string } | null };
    expect(cur.session?.sessionId).toBe(sessionId);
    expect(q<{ n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE status = 'active'")[0]!.n).toBe(1); // resumed, not duplicated
    steps.push({ crash: "SIGKILL, restart ok, attempt and session intact" });
  });
});

describe("privacy of what is left on disk", () => {
  it("no audio file exists, and the typed answer appears only in the database (not in logs, exports or temp files)", () => {
    const files = walk(scratch.root);
    expect(files.filter((f) => /\.(wav|mp3|ogg|webm|flac|m4a|aac|pcm|raw|opus)$/i.test(f))).toEqual([]);
    const outsideDb = files.filter((f) => !/\.sqlite(-wal|-shm)?(\.json)?$/i.test(f) && !f.includes(`${path.sep}backups${path.sep}`));
    expect(outsideDb.length).toBeGreaterThan(0); // there are logs to check
    for (const f of outsideDb) {
      if (statSync(f).size > 5_000_000) continue;
      expect(readFileSync(f).toString("latin1").includes(MARKER), f).toBe(false);
    }
    steps.push({ privacy: `${files.length} files scanned, ${outsideDb.length} outside the database: no audio, no answer text` });
  });
});
