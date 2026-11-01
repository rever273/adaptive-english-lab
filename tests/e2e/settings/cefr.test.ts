import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { expect, it } from "vitest";
import { freePort, makeScratchRoot, projectRoot } from "../../integration/helpers.js";

it("shows B1-C1 by default and saves C2 on a scratch profile", async () => {
  const scratch = makeScratchRoot();
  const port = await freePort();
  const env = { ...process.env, ENGLISHLAB_DATA_ROOT: scratch.root, ENGLISHLAB_PORT: String(port), ENGLISHLAB_NO_OPEN: "1" };
  const script = (name: string) => spawnSync(process.execPath, [path.join(projectRoot, "scripts", `${name}.mjs`)], { env, encoding: "utf8", timeout: 120_000 });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const seeded = script("seed-slice");
    expect(seeded.status, seeded.stderr).toBe(0);
    const started = script("start");
    expect(started.status, started.stderr).toBe(0);
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.getByRole("button", { name: /Settings & Status/ }).click();
    const min = page.getByTestId("set-level-min"), max = page.getByTestId("set-level-max");
    await expect.poll(() => min.inputValue(), { timeout: 15000 }).toBe("B1");
    expect(await max.inputValue()).toBe("C1");
    await max.selectOption("C2");
    await page.getByTestId("save-settings").click();
    await expect.poll(async () => (await page.evaluate(async () => (await fetch("/api/v1/settings")).json())).values.difficultyMax).toBe("C2");
    const folder = path.join(projectRoot, "documentation", "spec", "evidence", "cefr-c2");
    mkdirSync(folder, { recursive: true });
    await page.screenshot({ path: path.join(folder, "settings-c2.png"), fullPage: true });
  } finally {
    await browser?.close();
    script("stop");
    scratch.cleanup();
  }
}, 120_000);
