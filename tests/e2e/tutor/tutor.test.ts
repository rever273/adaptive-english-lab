// TASK_016: after a real answer, the Tutor tab shows the approved rule at once, queues AI work without running it, copies a short agent task, and the
// read-only export CLI produces bounded files for exactly that session and exercise.
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freePort, makeScratchRoot, projectRoot } from "../../integration/helpers.js";

const T = { timeout: 20_000 };
const SHOTS = path.join(projectRoot, "documentation", "spec", "evidence", "task-016", "screenshots");
let scratch: ReturnType<typeof makeScratchRoot>;
let base: string;
let env: NodeJS.ProcessEnv;
let browser: Browser;
let context: BrowserContext;
let page: Page;
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
const shot = async (name: string) => {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
  steps.push({ screenshot: name });
};

beforeAll(async () => {
  scratch = makeScratchRoot();
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  env = { ...process.env, ENGLISHLAB_DATA_ROOT: scratch.root, ENGLISHLAB_PORT: String(port), ENGLISHLAB_NO_OPEN: "1", ENGLISHLAB_AI: "off" };
  expect(script("seed-slice").status).toBe(0);
  expect(script("start").status).toBe(0);
  browser = await chromium.launch({ channel: "msedge", headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
  page = await context.newPage();
});
afterAll(async () => {
  await browser?.close();
  script("stop");
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(path.join(SHOTS, "e2e-report.json"), JSON.stringify({ browser: "msedge (installed)", base, steps }, null, 2));
  scratch?.cleanup();
});

async function answerOneChoice() {
  await page.goto(base);
  await page.getByTestId("start").click();
  for (let i = 0; i < 18; i++) {
    await page.getByTestId("slot").waitFor(T);
    const cur = (await page.evaluate(async () => (await fetch("/api/v1/sessions/current")).json())) as { session: { slots: Array<{ slotId: string; state: string }> } };
    const s = cur.session.slots.find((x) => x.state !== "skipped" && x.state !== "continued" && x.state !== "answered")!;
    const row = q<{ c: string; type: string }>("SELECT er.content_json AS c, er.type AS type FROM session_slots ss JOIN exercise_revisions er ON er.id = ss.exercise_revision_id WHERE ss.id = ?", s.slotId)[0]!;
    const p = (JSON.parse(row.c) as { payload: Record<string, any> }).payload;
    if (row.type === "choose_form" || row.type === "choose_missing_fragment") {
      const pick = p.options.find((o: any) => p.accepted_option_ids.includes(o.id));
      await page.getByRole("radio", { name: pick.text, exact: true }).check();
      await page.getByTestId("submit").click();
      await page.getByTestId("feedback").waitFor(T);
      return s.slotId;
    }
    await page.getByTestId("skip").click();
    await page.waitForTimeout(300);
  }
  throw new Error("no choice task found in the session");
}

describe("tutor in a browser", () => {
  it("shows the approved rule at once, queues AI work without running it, copies a short agent task, and the CLI exports exactly that data", async () => {
    const slotId = await answerOneChoice();
    const meta = q<{ sessionId: string; revisionId: string; explanation: string }>("SELECT ss.session_id AS sessionId, ss.exercise_revision_id AS revisionId, json_extract(er.content_json, '$.explanation_ru') AS explanation FROM session_slots ss JOIN exercise_revisions er ON er.id = ss.exercise_revision_id WHERE ss.id = ?", slotId)[0]!;

    await page.getByRole("button", { name: "Tutor", exact: true }).click();
    await page.getByTestId("tutor-slot").waitFor(T);
    await page.getByTestId("tutor-slot").selectOption(slotId);
    await page.getByTestId("tutor-why").click();
    await page.getByTestId("tutor-reply").first().waitFor(T);
    expect(await page.getByTestId("tutor-reply").first().getAttribute("data-source")).toBe("approved_exercise");
    await page.getByText(meta.explanation, { exact: false }).first().waitFor(T);
    await shot("01-approved-rule");

    await page.getByTestId("tutor-more").click();
    await page.getByTestId("tutor-pending").waitFor(T);
    const jobs = q<{ state: string; priority: number }>("SELECT state, priority FROM jobs WHERE kind = 'tutor'");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.priority).toBe(2);
    expect(["queued", "waiting_for_gpu"]).toContain(jobs[0]!.state); // AI is off in this run: it waits, nothing pretends to have answered
    expect(q<{ n: number }>("SELECT COUNT(*) AS n FROM tutor_messages WHERE source = 'model'")[0]!.n).toBe(0);
    await shot("02-queued");

    await page.getByTestId("copy-session").click();
    await page.getByTestId("agent-task").waitFor(T);
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain(`npm run lab:export -- session ${meta.sessionId}`);
    expect(copied.length).toBeLessThan(400);
    await page.getByText("Copied to the clipboard.").waitFor(T);
    await shot("03-agent-task-copied");

    // clipboard refused: the page must not claim success and must offer selectable text
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("denied")) }, configurable: true });
    });
    await page.getByTestId("copy-exercise").click();
    await page.getByText("Could not use the clipboard.").waitFor(T);
    expect(await page.getByLabel("Agent task text").inputValue()).toContain(`lab:export -- exercise ${meta.revisionId}`);
    await shot("04-clipboard-fallback");

    // the read-only CLI, against the same database, for exactly these IDs
    const out = path.join(scratch.root, "agent-out");
    const s = script("lab-export", ["session", meta.sessionId, "--db", dbFile(), "--out", out]);
    expect(s.status).toBe(0);
    const sj = JSON.parse(readFileSync(path.join(out, `session-${meta.sessionId}.json`), "utf8")) as { schema_version: string; session: { id: string }; slots: Array<{ revisionId: string }> };
    expect(sj).toMatchObject({ schema_version: "session-export-v1", session: { id: meta.sessionId } });
    expect(readFileSync(path.join(out, `session-${meta.sessionId}.md`), "utf8")).toContain("Read-only export");
    const x = script("lab-export", ["exercise", meta.revisionId, "--db", dbFile(), "--out", out]);
    expect(x.status).toBe(0);
    expect(existsSync(path.join(out, `exercise-${meta.revisionId}.json`))).toBe(true);
    for (const bad of ["session ../../etc/passwd", "exercise 1;DROP", "session"]) {
      const r = script("lab-export", [...bad.split(" "), "--db", dbFile(), "--out", out]);
      expect(r.status).toBe(2);
    }
    steps.push({ cli: "session + exercise export ok; malformed ids rejected with exit 2" });
  });
});
