import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { chromium } from "playwright-core";
import { expect, it } from "vitest";
import { freePort, makeScratchRoot, projectRoot } from "../../integration/helpers.js";

it("edits a selected form before saving while keeping the original form and task context", async () => {
  const scratch = makeScratchRoot();
  const port = await freePort();
  const env = { ...process.env, ENGLISHLAB_DATA_ROOT: scratch.root, ENGLISHLAB_PORT: String(port), ENGLISHLAB_NO_OPEN: "1", ENGLISHLAB_AI: "off" };
  const script = (name: string) => spawnSync(process.execPath, [path.join(projectRoot, "scripts", `${name}.mjs`)], { env, encoding: "utf8", timeout: 120_000 });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    expect(script("seed-slice").status).toBe(0);
    expect(script("start").status).toBe(0);
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.getByTestId("start").click();
    await page.getByTestId("slot").waitFor({ timeout: 20_000 });
    const selected = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="slot"] [data-word-area]')!;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const match = /\b[A-Za-z]{4,}\b/.exec(node.textContent ?? "");
        if (!match || node.parentElement?.closest("button, label, textarea, input")) continue;
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        return match[0];
      }
      return null;
    });
    expect(selected).not.toBeNull();
    const lemma = selected!.toLowerCase().endsWith("ed") ? selected!.toLowerCase().slice(0, -1) : `${selected!.toLowerCase()}x`;
    const input = page.getByTestId("word-to-save");
    await expect.poll(() => input.inputValue(), { timeout: 20_000 }).toBe(selected);
    await input.click();
    await input.fill(lemma);
    // Focusing and selecting text inside the editor must not dismiss the popup.
    await input.press("Control+A");
    expect(await input.inputValue()).toBe(lemma);
    const folder = path.join(projectRoot, "documentation", "spec", "evidence", "word-editor");
    mkdirSync(folder, { recursive: true });
    await page.screenshot({ path: path.join(folder, "edit-word.png"), fullPage: true });
    const request = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/api/v1/vocabulary"));
    await page.getByTestId("add-word").click();
    const body = (await request).postDataJSON() as { word: string; selected: string; slotId: string };
    expect(body).toMatchObject({ word: lemma, selected });
    expect(body.slotId).toMatch(/^[0-9a-f-]{36}$/i);
    await page.getByTestId("word-saved").waitFor({ timeout: 20_000 });
    const db = new Database(path.join(scratch.root, "db", "english-lab.sqlite"), { readonly: true });
    try {
      const row = db.prepare("SELECT lemma, surface_forms_json AS forms FROM vocabulary_entries WHERE lemma = ?").get(lemma) as { lemma: string; forms: string };
      expect(JSON.parse(row.forms)).toContain(selected!.toLowerCase());
      expect(db.prepare("SELECT 1 FROM vocabulary_encounters WHERE slot_id = ? AND kind = 'displayed'").get(body.slotId)).toBeDefined();
    } finally { db.close(); }
  } finally {
    await browser?.close();
    script("stop");
    scratch.cleanup();
  }
}, 120_000);
