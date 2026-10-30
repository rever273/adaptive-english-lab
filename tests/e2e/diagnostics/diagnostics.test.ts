// TASK_013: a real browser takes the optional starting diagnostic (block 1 of 3) against the real server and a real SQLite profile (seeded slice bank).
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freePort, makeScratchRoot, projectRoot } from "../../integration/helpers.js";

const T = { timeout: 15_000 };
const SHOTS = path.join(projectRoot, "documentation", "spec", "evidence", "task-013", "screenshots");
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
  env = { ...process.env, ENGLISHLAB_DATA_ROOT: scratch.root, ENGLISHLAB_PORT: String(port), ENGLISHLAB_NO_OPEN: "1", ENGLISHLAB_AI: "off", ENGLISHLAB_BANNER: "Non-release practice slice." };
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

describe("starting diagnostic in a browser", () => {
  it("is offered as optional, has no hints, shows no per-task feedback, and reviews the answers after the block", async () => {
    await page.goto(base);
    await page.getByTestId("checks").waitFor(T);
    expect(await page.getByTestId("diagnostic-card").innerText()).toContain("0 of 3 blocks done");
    expect(await page.getByTestId("heldout-reason").innerText()).toContain("7 days"); // nothing practised yet: the delayed check is closed, and says why
    await shot("diagnostic-1-dashboard");

    await page.getByTestId("start-diagnostic").click();
    await page.getByTestId("slot").waitFor(T);
    expect(await page.getByTestId("check-note").innerText()).toContain("No hints");
    expect(await page.getByRole("heading", { name: "Starting diagnostic" }).count()).toBe(1);
    expect(await page.getByTestId("hint-btn").count()).toBe(0);
    expect(await page.getByTestId("show-answer").count()).toBe(0);
    await shot("diagnostic-2-first-task");

    const formats: string[] = [];
    let wrongOnPurpose = 0;
    for (let i = 0; i < 8; i++) {
      await page.getByTestId("slot").waitFor(T);
      const slot = await currentSlot();
      formats.push(slot.type);
      const p = slot.p;
      if (slot.type === "choose_form" || slot.type === "choose_missing_fragment") {
        // answer the first one wrongly on purpose: the page must still say nothing about it until the block ends
        const pick = i === 0 ? p.options.find((o: any) => !p.accepted_option_ids.includes(o.id)) : p.options.find((o: any) => p.accepted_option_ids.includes(o.id));
        if (i === 0) wrongOnPurpose++;
        await page.getByRole("radio", { name: pick.text, exact: true }).check();
      } else if (slot.type === "detect_error") {
        if (p.no_mistake) await page.getByTestId("no-mistake").click();
        else await page.locator(`button.segment[data-segment-id="${p.accepted_segment_ids[0]}"]`).click();
      } else await page.getByTestId("answer-text").fill(p.accepted_answers[0]);
      await page.getByTestId("submit").click();
      await page.getByTestId("feedback").waitFor(T);
      expect(await page.getByTestId("feedback").getAttribute("data-state")).toBe("closed"); // no verdict, no answer
      expect(await page.getByTestId("feedback").innerText()).not.toMatch(/Correct|Not this time/);
      expect(await page.getByTestId("correct-answer").count()).toBe(0);
      if (i === 0) await shot("diagnostic-3-saved-no-feedback");
      await page.getByTestId("continue").click();
      if (i < 7) await expect.poll(async () => (await page.getByTestId("progress").innerText()).trim(), T).toContain(`${i + 2} / 8`);
    }
    expect(wrongOnPurpose).toBe(1);
    // the mix: 3 recognition + 3 correction + 2 production
    expect(formats.filter((f) => f === "choose_form" || f === "choose_missing_fragment")).toHaveLength(3);
    expect(formats.filter((f) => f === "detect_error")).toHaveLength(3);
    expect(formats.filter((f) => f === "guided_short_answer" || f === "russian_to_english_short")).toHaveLength(2);

    await page.getByTestId("all-closed").waitFor(T);
    await page.getByRole("button", { name: /finish|complete/i }).first().click();
    await page.getByTestId("summary").waitFor(T);
    await page.getByTestId("block-review").waitFor(T);
    const review = await page.getByTestId("block-review").innerText();
    expect(review).toContain("Your answers");
    expect(await page.getByTestId("block-review").locator("li").count()).toBe(8);
    expect(review).toMatch(/Not this time/); // the deliberately wrong first answer is explained only now
    expect(review).toContain("Correct:");
    await shot("diagnostic-4-review-after-block");

    // evidence: eight first attempts under purpose diagnostic, none of them practice evidence
    expect(q<{ n: number }>("SELECT COUNT(*) AS n FROM attempts a JOIN session_slots ss ON ss.id = a.slot_id JOIN sessions s ON s.id = ss.session_id WHERE s.purpose = 'diagnostic'")[0]!.n).toBe(8);
    expect(q<{ n: number }>("SELECT COUNT(*) AS n FROM attempts a JOIN session_slots ss ON ss.id = a.slot_id JOIN sessions s ON s.id = ss.session_id WHERE s.purpose = 'practice'")[0]!.n).toBe(0);
    steps.push({ formats });

    // the next block is offered; the dashboard counts the first as done
    await page.getByTestId("done").click();
    await page.getByTestId("diagnostic-card").waitFor(T);
    expect(await page.getByTestId("diagnostic-card").innerText()).toContain("1 of 3 blocks done");
    expect(await page.getByTestId("start-diagnostic").innerText()).toContain("Start block 2");
    await shot("diagnostic-5-dashboard-after");
    // and ordinary practice is still available without finishing the diagnostic
    expect(await page.getByTestId("start").isEnabled()).toBe(true);
  });
});
