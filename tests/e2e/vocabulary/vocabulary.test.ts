// TASK_015: select a word while practising, save it, see it on the Vocabulary page, edit it, mark it learned.
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freePort, makeScratchRoot, projectRoot } from "../../integration/helpers.js";

const T = { timeout: 20_000 };
const SHOTS = path.join(projectRoot, "documentation", "spec", "evidence", "task-015", "screenshots");
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

describe("vocabulary in a browser", () => {
  it("saves a selected word instantly, keeps the user's own edit, toggles learned without touching scores", async () => {
    await page.goto(base);
    await page.getByTestId("start").click();
    await page.getByTestId("slot").waitFor(T);

    // select the first long-enough word inside the exercise, as a learner would with the mouse
    const word = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="slot"] [data-word-area]')!;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const m = /[A-Za-z]{6,}/.exec(n.textContent ?? "");
        if (m && !n.parentElement?.closest("button, label, textarea, input")) {
          const r = document.createRange();
          r.setStart(n, m.index);
          r.setEnd(n, m.index + m[0].length);
          const s = window.getSelection()!;
          s.removeAllRanges();
          s.addRange(r);
          return m[0];
        }
      }
      return null;
    });
    expect(word).not.toBeNull();
    await page.getByTestId("add-word").waitFor(T);
    await shot("01-selected-word");
    await page.getByTestId("add-word").click();
    await page.getByTestId("word-saved").waitFor(T);
    await shot("02-saved");
    const lemma = word!.toLowerCase();
    expect(q<{ n: number }>("SELECT COUNT(*) AS n FROM vocabulary_entries WHERE lemma = ?", lemma)[0]!.n).toBe(1);
    const attemptsBefore = q<{ n: number }>("SELECT COUNT(*) AS n FROM attempts")[0]!.n;

    await page.getByRole("button", { name: "Vocabulary", exact: true }).click();
    await page.getByTestId("vocab-table").waitFor(T);
    expect(await page.getByTestId("vocab-row").count()).toBe(1);
    await shot("03-vocabulary-page");

    await page.getByRole("button", { name: "Edit" }).click();
    await page.getByLabel("Translation (Russian)").fill("слово");
    await page.getByRole("button", { name: "Save", exact: true }).last().click();
    await page.getByText("слово").waitFor(T);
    expect(q<{ n: number }>("SELECT COUNT(*) AS n FROM vocabulary_revisions WHERE source = 'user'")[0]!.n).toBe(1);

    await page.getByLabel(`${lemma} learned`).click();
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>('input[type="checkbox"][aria-label$=" learned"]')?.checked === true, undefined, T);
    expect(q<{ learned: number }>("SELECT learned FROM vocabulary_entries WHERE lemma = ?", lemma)[0]!.learned).toBe(1);
    expect(q<{ n: number }>("SELECT COUNT(*) AS n FROM attempts")[0]!.n).toBe(attemptsBefore); // vocabulary never writes attempts or scores
    await shot("04-edited-learned");
  });
});
