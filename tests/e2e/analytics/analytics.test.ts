// TASK_014: a real browser opens Analytics after a few real answers; numbers must match the database, the export must download.
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freePort, makeScratchRoot, projectRoot } from "../../integration/helpers.js";

const T = { timeout: 20_000 };
const SHOTS = path.join(projectRoot, "documentation", "spec", "evidence", "task-014", "screenshots");
let scratch: ReturnType<typeof makeScratchRoot>;
let base: string;
let env: NodeJS.ProcessEnv;
let browser: Browser;
let page: Page;
const steps: unknown[] = [];
const script = (name: string) => spawnSync(process.execPath, [path.join(projectRoot, "scripts", `${name}.mjs`)], { env, encoding: "utf8", timeout: 120_000 });
const q = <X>(sql: string, ...p: unknown[]): X[] => {
  const d = new Database(path.join(scratch.root, "db", "english-lab.sqlite"), { readonly: true });
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
  page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
});
afterAll(async () => {
  await browser?.close();
  script("stop");
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(path.join(SHOTS, "e2e-report.json"), JSON.stringify({ browser: "msedge (installed)", base, steps }, null, 2));
  scratch?.cleanup();
});

async function currentSlot() {
  const cur = (await page.evaluate(async () => (await fetch("/api/v1/sessions/current")).json())) as { session: { slots: Array<{ slotId: string; state: string }> } };
  const s = cur.session.slots.find((x) => x.state !== "skipped" && x.state !== "continued" && x.state !== "answered")!;
  const row = q<{ c: string; type: string }>("SELECT er.content_json AS c, er.type AS type FROM session_slots ss JOIN exercise_revisions er ON er.id = ss.exercise_revision_id WHERE ss.id = ?", s.slotId)[0]!;
  return { type: row.type, p: (JSON.parse(row.c) as { payload: Record<string, any> }).payload };
}

describe("analytics in a browser", () => {
  it("shows exact counts from the saved answers, keeps pending apart, exports files that download", async () => {
    await page.goto(base);
    await page.getByTestId("start").click();
    await page.getByTestId("slot").waitFor(T);
    let right = 0;
    let wrong = 0;
    let answered = 0;
    for (let i = 0; i < 18 && answered < 4; i++) {
      await page.getByTestId("slot").waitFor(T);
      const slot = await currentSlot();
      const p = slot.p;
      const makeWrong = answered % 2 === 1;
      if (slot.type === "choose_form" || slot.type === "choose_missing_fragment") {
        const pick = p.options.find((o: any) => p.accepted_option_ids.includes(o.id) !== makeWrong);
        await page.getByRole("radio", { name: pick.text, exact: true }).check();
      } else if (slot.type === "detect_error") {
        if (p.no_mistake && !makeWrong) await page.getByTestId("no-mistake").click();
        else if (!p.no_mistake) await page.locator("button.segment").nth(p.segments.findIndex((s: any) => p.accepted_segment_ids.includes(s.id) !== makeWrong)).click();
        else {
          await page.locator("button.segment").nth(0).click();
        }
      } else {
        // free text: left to the AI (pending) - skip this one so the count below stays deterministic
        await page.getByTestId("skip").click();
        await page.waitForTimeout(300);
        continue;
      }
      await page.getByTestId("submit").click();
      await page.getByTestId("feedback").waitFor(T);
      const verdict = await page.getByTestId("feedback").getAttribute("data-verdict");
      if (verdict === "correct") right++;
      else wrong++;
      answered++;
      await page.getByTestId("continue").click();
      await page.waitForTimeout(300);
    }
    expect(answered).toBe(4);

    await page.getByRole("button", { name: "Analytics" }).click();
    await page.getByTestId("metrics").waitFor(T);
    const first = (await page.getByTestId("metrics").locator("tr").nth(1).innerText()).replace(/\s+/g, " ");
    expect(first).toContain(`${right} of ${right + wrong}`);
    expect(first).toContain("few answers"); // n < 10 is flagged, never interpreted
    const dbCount = q<{ n: number }>("SELECT COUNT(*) AS n FROM attempts WHERE first_attempt = 1 AND hints_before = 0")[0]!.n;
    expect(dbCount).toBe(4);
    expect(await page.getByTestId("comparison").innerText()).toContain("Insufficient comparison data");
    expect(await page.getByTestId("ai-findings").innerText()).toContain("not verified");
    expect(await page.getByTestId("discovery").innerText()).toContain("model not qualified");
    expect(await page.getByTestId("run-id").innerText()).toContain("4 answers");
    steps.push({ right, wrong });
    await shot("analytics-1-desktop");

    await page.getByTestId("export").click();
    await page.getByTestId("export-result").waitFor(T);
    const link = await page.getByTestId("export-result").getByRole("link", { name: "summary.csv" }).getAttribute("href");
    const csv = await page.evaluate(async (h) => (await fetch(h!)).text(), link);
    expect(csv).toContain("first_attempt_accuracy_unaided");
    expect(csv).toContain(`,${right},${right + wrong},`);
    await shot("analytics-2-exported");

    await page.setViewportSize({ width: 640, height: 900 });
    await shot("analytics-3-narrow");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  });
});
