import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { chromium } from "playwright-core";
import { expect, it } from "vitest";
import { freePort, makeScratchRoot, projectRoot } from "../../integration/helpers.js";

it("renders a scrollable path and keeps later lessons locked", async () => {
  const scratch = makeScratchRoot();
  const port = await freePort();
  const env = { ...process.env, ENGLISHLAB_DATA_ROOT: scratch.root, ENGLISHLAB_PORT: String(port), ENGLISHLAB_NO_OPEN: "1" };
  const script = (name: string) => spawnSync(process.execPath, [path.join(projectRoot, "scripts", `${name}.mjs`)], { env, encoding: "utf8", timeout: 120_000 });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const seeded = script("seed-slice");
    expect(seeded.status, seeded.stderr).toBe(0);
    const db = new Database(path.join(scratch.root, "db", "english-lab.sqlite"));
    db.prepare("UPDATE blueprints SET stable_key = 'first10-l01'").run();
    const policy = (db.prepare("SELECT policy_json AS p FROM blueprint_revisions LIMIT 1").get() as { p: string }).p;
    for (let n = 2; n <= 10; n++) {
      const id = randomUUID();
      db.prepare("INSERT INTO blueprints(id, stable_key) VALUES (?,?)").run(id, `test-l${String(n).padStart(2, "0")}`);
      db.prepare("INSERT INTO blueprint_revisions(id, blueprint_id, revision, policy_json, status, created_at) VALUES (?,?,1,?,'published',?)").run(randomUUID(), id, policy, new Date().toISOString());
    }
    db.close();
    const started = script("start");
    expect(started.status, started.stderr).toBe(0);
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`http://127.0.0.1:${port}/`);
    const nodes = page.locator(".lesson-path-node");
    await expect.poll(() => nodes.count(), { timeout: 15000 }).toBe(10);
    expect(await nodes.nth(0).isEnabled()).toBe(true);
    expect(await nodes.nth(0).innerText()).toContain("L01");
    expect(await nodes.nth(1).isDisabled()).toBe(true);
    const folder = path.join(projectRoot, "documentation", "spec", "evidence", "task-025");
    mkdirSync(folder, { recursive: true });
    await page.screenshot({ path: path.join(folder, "lesson-path.png"), fullPage: true });
  } finally {
    await browser?.close();
    script("stop");
    scratch.cleanup();
  }
}, 120_000);
