// TASK_007 early UX checkpoint: a real browser plays the NON-RELEASE slice against the real server and a real SQLite file.
// STT, Ollama, the GPU queue and Content Studio are NOT implemented here and are labelled as such in the UI.
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freePort, makeScratchRoot, projectRoot } from "../../integration/helpers.js";


// vitest's expect has no Playwright matchers: small polling helpers instead (15 s each).
const T = { timeout: 15_000 };
const has = (l: Locator, sub: string) => expect.poll(() => l.innerText(), T).toContain(sub);
const exactText = (l: Locator, t: string) => expect.poll(async () => (await l.innerText()).trim(), T).toBe(t);
const attrIs = (l: Locator, name: string, v: string) => expect.poll(() => l.getAttribute(name), T).toBe(v);
const visible = (l: Locator, timeout = 15_000) => l.waitFor({ state: "visible", timeout });
const isEnabled = (l: Locator) => expect.poll(() => l.isEnabled(), T).toBe(true);
const isDisabled = (l: Locator) => expect.poll(() => l.isDisabled(), T).toBe(true);
const countIs = (l: Locator, n: number) => expect.poll(() => l.count(), T).toBe(n);

const SHOTS = path.join(projectRoot, "documentation", "spec", "evidence", "task-007", "screenshots");
let scratch: ReturnType<typeof makeScratchRoot>;
let port: number;
let base: string;
let env: NodeJS.ProcessEnv;
let browser: Browser;
let context: BrowserContext;
let page: Page;
const report: Record<string, unknown> = { steps: [] as unknown[] };
const step = (name: string, data: Record<string, unknown> = {}) => (report.steps as unknown[]).push({ name, ...data });

const script = (name: string, ...args: string[]) => spawnSync(process.execPath, [path.join(projectRoot, "scripts", `${name}.mjs`), ...args], { env, encoding: "utf8", timeout: 120_000 });
const db = () => new Database(path.join(scratch.root, "db", "english-lab.sqlite"), { readonly: true });
const q = <T>(sql: string, ...p: unknown[]): T[] => {
  const d = db();
  try {
    return d.prepare(sql).all(...p) as T[];
  } finally {
    d.close();
  }
};
const q1 = <T>(sql: string, ...p: unknown[]): T => q<T>(sql, ...p)[0] as T;
const shot = async (p: Page, name: string, fullPage = true) => {
  mkdirSync(SHOTS, { recursive: true });
  await p.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage });
  step(`screenshot:${name}`);
};

beforeAll(async () => {
  scratch = makeScratchRoot();
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  env = { ...process.env, ENGLISHLAB_DATA_ROOT: scratch.root, ENGLISHLAB_PORT: String(port), ENGLISHLAB_NO_OPEN: "1", ENGLISHLAB_BANNER: "Non-release practice slice: 45 hand-written exercises reviewed by an AI agent. Voice and AI review are not implemented yet." };
  const seed = script("seed-slice");
  expect(seed.status, seed.stdout + seed.stderr).toBe(0);
  const start = script("start");
  expect(start.status, start.stdout + start.stderr).toBe(0);
  browser = await chromium.launch({ channel: "msedge", headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "light" });
  page = await context.newPage();
});

afterAll(async () => {
  await browser?.close();
  script("stop");
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(path.join(SHOTS, "e2e-report.json"), JSON.stringify({ browser: browser ? "msedge (installed)" : null, base, ...report }, null, 2));
  scratch?.cleanup();
});

/** What a learner would do, taken from the stored exercise behind the open slot (the harness knows the answers; the UI does not). */
async function openSlot(): Promise<{ slotId: string; type: string; content: any; questionId: string | null; ordinal: number } | null> {
  const cur = (await page.evaluate(async () => (await fetch("/api/v1/sessions/current")).json())) as { session: { slots: Array<{ slotId: string; state: string; ordinal: number }> } };
  const s = cur.session.slots.find((x) => x.state !== "skipped" && x.state !== "continued");
  if (!s) return null;
  const row = q1<{ type: string; c: string; q: string | null }>("SELECT er.type AS type, er.content_json AS c, ss.question_id AS q FROM session_slots ss JOIN exercise_revisions er ON er.id = ss.exercise_revision_id WHERE ss.id = ?", s.slotId);
  return { slotId: s.slotId, type: row.type, content: JSON.parse(row.c), questionId: row.q, ordinal: s.ordinal };
}

type Slot = NonNullable<Awaited<ReturnType<typeof openSlot>>>;
async function answerCorrectly(slot: Slot) {
  const p = slot.content.payload;
  if (slot.type === "choose_form" || slot.type === "choose_missing_fragment") {
    const text = p.options.find((o: any) => p.accepted_option_ids.includes(o.id)).text;
    await page.getByRole("radio", { name: text, exact: true }).check();
  } else if (slot.type === "detect_error") {
    if (p.no_mistake) await page.getByTestId("no-mistake").click();
    else await page.locator(`button.segment[data-segment-id="${p.accepted_segment_ids[0]}"]`).click();
  } else {
    await page.getByTestId("answer-text").fill(p.accepted_answers[0]);
  }
  await page.getByTestId("submit").click();
}
async function answerWrongly(slot: Slot) {
  const p = slot.content.payload;
  if (slot.type === "choose_form" || slot.type === "choose_missing_fragment") {
    const text = p.options.find((o: any) => !p.accepted_option_ids.includes(o.id)).text;
    await page.getByRole("radio", { name: text, exact: true }).check();
  } else if (slot.type === "detect_error") {
    // a segment that is not the faulty one (or, for a correct sentence, any segment)
    const wrong = p.segments.findIndex((sg: any) => !p.accepted_segment_ids.includes(sg.id));
    await page.locator("button.segment").nth(wrong < 0 ? 0 : wrong).click();
  } else {
    await page.getByTestId("answer-text").fill("Some words that are not an approved sentence.");
  }
  await page.getByTestId("submit").click();
}
const progressText = async () => (await page.getByTestId("progress").innerText()).trim();

describe("early UX checkpoint (non-release vertical slice) - real browser, real SQLite", () => {
  it("shows the dashboard honestly: banner, readiness, nothing implemented that is not", async () => {
    await page.goto(base + "/");
    await has(page.getByTestId("banner"), "Non-release practice slice");
    await has(page.getByTestId("ready"), "2");
    await isEnabled(page.getByTestId("start"));
    await isEnabled(page.getByRole("button", { name: "Vocabulary" })); // implemented since TASK_015
    await shot(page, "01-dashboard-light");
    step("dashboard", { readySessions: 2 });
  });

  it("starts an 18-slot session and persists it before anything is shown", async () => {
    await page.getByTestId("start").click();
    await exactText(page.getByTestId("progress"), "1 / 18");
    const s = q1<{ n: number; status: string }>("SELECT (SELECT COUNT(*) FROM session_slots) AS n, (SELECT status FROM sessions LIMIT 1) AS status");
    expect(s).toEqual({ n: 18, status: "active" });
    expect(q1<{ n: number }>("SELECT COUNT(*) AS n FROM prompt_reservations").n).toBeGreaterThan(30); // reserved up front
    const decision = q1<{ choices_json: string }>("SELECT choices_json FROM scheduling_decisions").choices_json;
    expect(JSON.parse(decision).slots).toHaveLength(18);
    step("started", { slots: 18, reservations: q1<{ n: number }>("SELECT COUNT(*) AS n FROM prompt_reservations").n });
  });

  let firstSlot: Slot;

  it("answer -> instant deterministic feedback for a closed question; the first attempt is stored", async () => {
    firstSlot = (await openSlot())!;
    expect(firstSlot.type).toBe("choose_form");
    await attrIs(page.getByTestId("slot"), "data-format", "choose_form");
    await shot(page, "02-choose-form-prompt");
    await answerCorrectly(firstSlot);
    const fb = page.getByTestId("feedback");
    await attrIs(fb, "data-verdict", "correct");
    await has(fb, "Correct");
    await visible(page.getByTestId("correct-answer"));
    await shot(page, "03-feedback-correct");
    const a = q1<{ attempt_no: number; first_attempt: number; hints_before: number; raw_answer_json: string }>("SELECT attempt_no, first_attempt, hints_before, raw_answer_json FROM attempts");
    expect(a).toMatchObject({ attempt_no: 1, first_attempt: 1, hints_before: 0 });
    expect(JSON.parse(a.raw_answer_json).kind).toBe("options");
    expect(q1<{ verdict: string; confirmation: string; source: string }>("SELECT verdict, confirmation, source FROM assessment_revisions")).toEqual({ verdict: "correct", confirmation: "confirmed", source: "deterministic" });
    // answer sentences were committed to the ledger only when the feedback was sent
    expect(q1<{ n: number }>("SELECT COUNT(*) AS n FROM exposures").n).toBeGreaterThan(0);
    await page.getByTestId("continue").click();
    await exactText(page.getByTestId("progress"), "2 / 18");
  });

  it("voluntary retry: a wrong answer, Try again, then correct - history keeps attempt 1 as the first attempt", async () => {
    const s = (await openSlot())!;
    await answerWrongly(s);
    const verdict = s.type === "detect_error" && s.content.payload.no_mistake ? "incorrect" : "incorrect";
    await attrIs(page.getByTestId("feedback"), "data-verdict", verdict);
    await shot(page, "04-feedback-try-again-offered");
    await page.getByRole("button", { name: "Try again" }).click();
    await answerCorrectly(s);
    await attrIs(page.getByTestId("feedback"), "data-verdict", "correct");
    const rows = q<{ attempt_no: number; first_attempt: number }>("SELECT attempt_no, first_attempt FROM attempts WHERE slot_id = ? ORDER BY attempt_no", s.slotId);
    expect(rows).toEqual([{ attempt_no: 1, first_attempt: 1 }, { attempt_no: 2, first_attempt: 0 }]);
    await page.getByTestId("continue").click();
    step("retry", { format: s.type, attempts: rows });
  });

  it("a reload restores the stored snapshot: same slot, nothing new exposed, no duplicate events", async () => {
    await page.getByTestId("slot").waitFor();
    await expect.poll(async () => (await progressText()) === (await (async () => { await page.waitForTimeout(400); return progressText(); })()), T).toBe(true); // settled after the last Continue
    const progress = await progressText();
    // the open slot must already be revealed (and stored) before we compare: then the reload below is a pure resume
    await expect.poll(() => q1<{ n: number }>("SELECT COUNT(*) AS n FROM session_events WHERE event_type = 'reveal'").n, T).toBe(Number(progress.split(" / ")[0]));
    const before = q1<{ e: number; r: number; a: number }>("SELECT (SELECT COUNT(*) FROM exposures) AS e, (SELECT COUNT(*) FROM session_events WHERE event_type = 'reveal') AS r, (SELECT COUNT(*) FROM attempts) AS a");
    await page.reload();
    await visible(page.getByTestId("slot"));
    expect(await progressText()).toBe(progress);
    const after = q1<{ e: number; r: number; a: number }>("SELECT (SELECT COUNT(*) FROM exposures) AS e, (SELECT COUNT(*) FROM session_events WHERE event_type = 'reveal') AS r, (SELECT COUNT(*) FROM attempts) AS a");
    // the open slot was revealed before the reload, so reveal is a resume: only the lease moved
    expect(after).toEqual(before);
    step("reload", { progress, before, after });
  });

  it("covers the other formats: IDK, No mistake, hint, show answer, skip, pending free text, approved free text", async () => {
    const seen = new Set<string>();
    let idkDone = false, hintDone = false, showDone = false, skipDone = false, pendingDone = false, noMistakeDone = false;
    for (let guard = 0; guard < 18; guard++) {
      if (await page.getByTestId("summary").isVisible().catch(() => false)) break;
      const s = await openSlot();
      if (!s) break;
      const first = !seen.has(s.type);
      seen.add(s.type);
      await page.getByTestId("slot").waitFor();

      if (s.type === "detect_error" && !idkDone) {
        idkDone = true;
        await shot(page, "05-detect-error-prompt");
        await page.getByTestId("idk").click();
        await attrIs(page.getByTestId("feedback"), "data-verdict", "idk");
        await has(page.getByTestId("feedback"), "not as a skip");
      } else if (s.type === "detect_error" && s.content.payload.no_mistake && !noMistakeDone) {
        noMistakeDone = true;
        await answerCorrectly(s); // clicks "No mistake"
        await attrIs(page.getByTestId("feedback"), "data-verdict", "correct");
      } else if ((s.type === "choose_missing_fragment" || s.type === "choose_form") && !hintDone) {
        hintDone = true;
        await page.getByTestId("hint-btn").click();
        await has(page.getByTestId("hint"), "Hint:");
        await shot(page, "06-hint-shown");
        await answerCorrectly(s);
        await attrIs(page.getByTestId("feedback"), "data-verdict", "correct");
        const att = q1<{ hints_before: number }>("SELECT hints_before FROM attempts WHERE slot_id = ?", s.slotId);
        expect(att.hints_before).toBe(1); // assisted: stored as first attempt, but never unaided evidence
      } else if ((s.type === "choose_missing_fragment" || s.type === "choose_form") && !showDone) {
        showDone = true;
        await page.getByTestId("show-answer").click();
        await visible(page.getByTestId("correct-answer"));
        await page.getByTestId("continue").click();
        continue;
      } else if ((s.type === "choose_missing_fragment" || s.type === "choose_form") && !skipDone) {
        skipDone = true;
        await page.getByTestId("skip").click();
        continue;
      } else if (s.type === "guided_short_answer" && !pendingDone) {
        pendingDone = true;
        await expect.poll(async () => /speak this one|Voice is not available/.test(await page.getByTestId("voice-note").innerText()), T).toBe(true); // honest about whether voice works on this computer
        await shot(page, "07-short-answer-prompt");
        await page.getByTestId("answer-text").fill("He quit it a while ago.");
        await page.getByTestId("submit").click();
        const fb = page.getByTestId("feedback");
        await attrIs(fb, "data-state", "pending");
        await has(fb, "not marked wrong");
        await shot(page, "08-feedback-pending");
        expect(q1<{ verdict: string; confirmation: string }>("SELECT verdict, confirmation FROM assessment_revisions WHERE attempt_id = (SELECT id FROM attempts WHERE slot_id = ?)", s.slotId)).toEqual({ verdict: "pending", confirmation: "tentative" });
        expect(q1<{ n: number }>("SELECT COUNT(*) AS n FROM skill_opportunities WHERE assessment_id = (SELECT id FROM assessment_revisions WHERE attempt_id = (SELECT id FROM attempts WHERE slot_id = ?))", s.slotId).n).toBe(0); // no evidence is invented
      } else {
        await answerCorrectly(s);
        await visible(page.getByTestId("feedback"));
        if (first && s.type === "russian_to_english_short") await attrIs(page.getByTestId("feedback"), "data-verdict", "correct");
      }
      await page.getByTestId("continue").click();
    }
    expect({ idkDone, hintDone, showDone, skipDone, pendingDone, noMistakeDone }).toEqual({ idkDone: true, hintDone: true, showDone: true, skipDone: true, pendingDone: true, noMistakeDone: expect.any(Boolean) });
    step("formats", { seen: [...seen] });
  });

  it("finishes: the summary separates confirmed, IDK, assisted, pending and skipped, and matches the database", async () => {
    // answer anything still open, correctly
    for (let guard = 0; guard < 18; guard++) {
      if (await page.getByTestId("summary").isVisible().catch(() => false)) break;
      const s = await openSlot();
      if (!s) break;
      await answerCorrectly(s);
      await visible(page.getByTestId("feedback"));
      await page.getByTestId("continue").click();
    }
    await visible(page.getByTestId("summary")); // the results open by themselves after the last task
    await shot(page, "09-all-done");
    await shot(page, "10-summary");
    const ui = {
      correct: Number(await page.getByTestId("count-correct").innerText()),
      incorrect: Number(await page.getByTestId("count-incorrect").innerText()),
      idk: Number(await page.getByTestId("count-idk").innerText()),
      assisted: Number(await page.getByTestId("count-assisted").innerText()),
      pending: Number(await page.getByTestId("count-pending").innerText()),
      skipped: Number(await page.getByTestId("count-skipped").innerText()),
    };
    expect(ui.idk).toBeGreaterThanOrEqual(1);
    expect(ui.pending).toBeGreaterThanOrEqual(1);
    expect(ui.skipped).toBe(2); // one Skip and one "Show answer & continue" (an answer seen without answering is a skip, never a mistake)
    expect(ui.assisted).toBeGreaterThanOrEqual(1); // the hint slot
    expect(ui.correct + ui.incorrect + ui.idk + ui.assisted + ui.pending + ui.skipped).toBe(18);
    // the database agrees
    const st = q1<{ status: string }>("SELECT status FROM sessions").status;
    expect(st).toBe("completed");
    expect(q1<{ n: number }>("SELECT COUNT(*) AS n FROM session_events WHERE event_type = 'skip'").n).toBe(2);
    expect(q1<{ n: number }>("SELECT COUNT(*) AS n FROM attempts WHERE first_attempt = 1 AND idk = 1").n).toBe(ui.idk);
    expect(q1<{ n: number }>("SELECT COUNT(*) AS n FROM assessment_revisions WHERE verdict = 'pending'").n).toBeGreaterThanOrEqual(ui.pending);
    await visible(page.getByText(/written answer\(s\) remain unconfirmed/));
    step("summary", ui);
  });

  it("storage facts: no audio anywhere, every shown sentence is in the ledger, only practice content was used", async () => {
    const cols = q<{ name: string }>("SELECT m.name || '.' || p.name AS name FROM sqlite_master m, pragma_table_info(m.name) p WHERE m.type = 'table'");
    expect(cols.filter((c) => /audio|wav|pcm|blob/i.test(c.name))).toEqual([]);
    expect(q1<{ n: number }>("SELECT COUNT(*) AS n FROM transcripts").n).toBe(0); // voice never ran
    expect(q1<{ n: number }>("SELECT COUNT(*) AS n FROM session_slots ss JOIN exercise_revisions er ON er.id = ss.exercise_revision_id WHERE er.bank_role <> 'practice'").n).toBe(0);
    // every revealed slot's shown units are exposed
    const missing = q1<{ n: number }>(
      `SELECT COUNT(*) AS n FROM session_events e JOIN session_slots ss ON ss.id = e.slot_id
         JOIN revision_prompt_units rpu ON rpu.revision_id = ss.exercise_revision_id AND rpu.role IN ('prompt','option','passage')
        WHERE e.event_type = 'reveal' AND rpu.unit_id NOT IN (SELECT unit_id FROM exposures)`,
    ).n;
    expect(missing).toBe(0);
    step("storage", { exposures: q1<{ n: number }>("SELECT COUNT(*) AS n FROM exposures").n, attempts: q1<{ n: number }>("SELECT COUNT(*) AS n FROM attempts").n });
  });

  it("a second tab is read-only while the first holds the lease", async () => {
    await page.getByTestId("done").click();
    await page.getByTestId("start").click();
    await exactText(page.getByTestId("progress"), "1 / 18");
    const other = await context.newPage(); // new tab = new sessionStorage = a different tab id
    await other.goto(base + "/");
    await visible(other.getByText("open in another tab"));
    await countIs(other.getByTestId("submit"), 0);
    await shot(other, "11-second-tab-read-only");
    await other.close();
  });

  it("survives a server restart: the same session resumes from SQLite", async () => {
    const before = q1<{ id: string; n: number }>("SELECT (SELECT id FROM sessions WHERE status = 'active') AS id, (SELECT COUNT(*) FROM session_events) AS n");
    const stop = script("stop");
    expect(stop.status, stop.stdout + stop.stderr).toBe(0);
    const start = script("start");
    expect(start.status, start.stdout + start.stderr).toBe(0);
    await page.goto(base + "/");
    await exactText(page.getByTestId("progress"), "1 / 18", { timeout: 20_000 });
    expect(q1<{ id: string }>("SELECT id FROM sessions WHERE status = 'active'").id).toBe(before.id);
    step("restart", { sessionId: before.id });
  });

  it("shows the exact shortage when the bank is used up (dashboard payload), with Start disabled", async () => {
    // spend the second session quickly: skip everything, finish
    for (let guard = 0; guard < 18; guard++) {
      if (await page.getByTestId("summary").isVisible().catch(() => false)) break;
      await page.getByTestId("skip").click();
    }
    await visible(page.getByTestId("summary"));
    await page.getByTestId("done").click();
    await visible(page.getByTestId("shortage"));
    await isDisabled(page.getByTestId("start"));
    await has(page.getByTestId("shortage"), "Not enough approved exercises for 18 tasks");
    await shot(page, "12-shortage");
    step("shortage", { text: await page.getByTestId("shortage").innerText() });
  });

  it("renders well in dark mode and on a 390 px phone (screenshots)", async () => {
    const dark = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "dark" });
    const dp = await dark.newPage();
    await dp.goto(base + "/");
    await dp.getByTestId("shortage").waitFor();
    await shot(dp, "13-dashboard-dark");
    await dark.close();
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "light" });
    const pp = await phone.newPage();
    await pp.goto(base + "/");
    await pp.getByTestId("shortage").waitFor();
    const overflow = await pp.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow).toBe(false);
    await shot(pp, "14-dashboard-390px");
    await phone.close();
  });
});
