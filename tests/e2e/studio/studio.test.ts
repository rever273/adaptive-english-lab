// TASK_010/012: a real browser uses Content Studio and AI Tasks against the REAL built server (ENGLISHLAB_AI=off: no model runs).
// Drafts are written into the same SQLite file by the in-process generator with a SCRIPTED model (fake), so the screens show real rows.
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REVIEW_CHECKLIST_KEYS } from "@english-lab/contracts";
import { AdvisoryJobRunner } from "../../../apps/server/src/domain/content/batches/advisoryRunner.js";
import { GenerationJobRunner } from "../../../apps/server/src/domain/content/batches/generationRunner.js";
import { AI_CONFIG_V2 } from "../../../apps/server/src/domain/ai/config.js";
import { GpuScheduler } from "../../../apps/server/src/queue/scheduler.js";
import { FakeClock, FakeGpu, flush } from "../../fixtures/queue/fakes.js";
import { FakeModel, FakeNimble } from "../../integration/batches/fixtures.js";
import { freePort, makeScratchRoot, projectRoot } from "../../integration/helpers.js";

const T = { timeout: 15_000 };
const SHOTS = path.join(projectRoot, "documentation", "spec", "evidence", "task-019", "screenshots");
let scratch: ReturnType<typeof makeScratchRoot>;
let base: string;
let env: NodeJS.ProcessEnv;
let browser: Browser;
let context: BrowserContext;
let page: Page;
const report: { steps: unknown[] } = { steps: [] };
const script = (name: string, ...args: string[]) => spawnSync(process.execPath, [path.join(projectRoot, "scripts", `${name}.mjs`), ...args], { env, encoding: "utf8", timeout: 120_000 });
const shot = async (name: string) => {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
  report.steps.push({ screenshot: name });
};
const api = (p: string, body?: unknown) =>
  page.evaluate(
    async ({ p, body }) => {
      const csrf = ((await (await fetch("/api/v1/session")).json()) as { csrfToken: string }).csrfToken;
      const r = await fetch(p, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify(body) });
      return { status: r.status, json: await r.json() };
    },
    { p, body },
  );

beforeAll(async () => {
  scratch = makeScratchRoot();
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  env = { ...process.env, ENGLISHLAB_DATA_ROOT: scratch.root, ENGLISHLAB_PORT: String(port), ENGLISHLAB_NO_OPEN: "1", ENGLISHLAB_AI: "off" };
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
  writeFileSync(path.join(SHOTS, "e2e-report.json"), JSON.stringify({ browser: "msedge (installed)", base, ...report }, null, 2));
  scratch?.cleanup();
});

describe("Content Studio and AI Tasks in a real browser", () => {
  it("starts a regular batch, copies an agent task and shows final results without manual JSON", async () => {
    await page.goto(base);
    const notice = page.getByLabel("Exercise stock running low");
    await notice.waitFor(T);
    await notice.getByRole("button", {name:"Open Content Studio"}).click();
    expect(await page.getByLabel("Batch size").inputValue()).toBe("50");
    expect(await page.getByRole("button", {name:"Start batch",exact:true}).isEnabled()).toBe(true);
    await shot("studio-empty");
    await page.getByLabel("Batch size").fill("6");
    await page.getByRole("button", {name:"Start batch",exact:true}).click();
    await page.getByText("Started 6 drafts.", {exact:false}).waitFor(T);
    await page.getByRole("button", { name: "AI Tasks",exact:true }).click();
    await page.getByTestId("jobs").waitFor(T);
    expect(await page.getByTestId("jobs").locator("tbody tr").count()).toBe(6);
    await shot("ai-tasks-waiting");

    // the generator (scripted model) writes the drafts into the same database file
    const batchId = ((await api("/api/v1/content/batches")).json as { batches: Array<{ id: string }> }).batches[0]!.id;
    const dbFile = path.join(scratch.root, "db", "english-lab.sqlite");
    const db = new Database(dbFile);
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");
    const clock = new FakeClock(new Date());
    const gpu = new FakeGpu(clock);
    const deps = { now: () => clock.now(), newId: randomUUID };
    const model = new FakeModel();
    const nimble = new FakeNimble();
    const gen = new GenerationJobRunner({ db, chat: model, installedDigest: async () => AI_CONFIG_V2.analysis.digest, runtimeVersion: async () => "e2e", deps, sleep: async () => {} });
    const adv = new AdvisoryJobRunner({ db, decision: nimble, installedDigest: async () => AI_CONFIG_V2.triage.digest, runtimeVersion: async () => "e2e", deps });
    await gen.prepare();
    await adv.prepare();
    const sched = new GpuScheduler({ db, newId: randomUUID, clock, telemetry: gpu, control: gpu, runners: [gen, adv], instanceId: "e2e-generator", config: { admission: "spike", idleUnloadMs: 600_000 } });
    for (let i = 0; i < 400; i++) {
      await sched.tick();
      await flush();
      await flush();
      const open = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state NOT IN ('completed','failed','cancelled')").get() as { n: number };
      if (open.n === 0) break;
      clock.advance(1500);
    }
    const revs = db.prepare("SELECT bi.revision_id AS rid, er.content_hash AS hash FROM batch_items bi JOIN exercise_revisions er ON er.id = bi.revision_id WHERE bi.batch_id = ? ORDER BY bi.ordinal").all(batchId) as Array<{ rid: string; hash: string }>;
    expect(revs).toHaveLength(6);
    db.close();

    await page.getByRole("button", { name: "Content Studio",exact:true }).click();
    await page.getByTestId("batches").getByRole("button").first().click();
    await page.getByTestId("batch-detail").waitFor(T);
    await page.getByLabel("Task for the reviewing agent").waitFor(T);
    expect(await page.getByLabel("Task for the reviewing agent").inputValue()).toContain("content:agent -- prepare");
    await page.getByRole("button", {name:"Copy",exact:true}).click();
    await page.getByRole("button", {name:"Copied",exact:true}).waitFor(T);
    expect(await page.getByLabel("Review manifest (JSON)").count()).toBe(0);
    await shot("studio-agent-task");

    // The actual CLI prepares and finalizes through the running service; no user JSON entry.
    const work=path.join(scratch.root,"agent-work");
    const agent=(cmd:string)=>script("content-agent",cmd,batchId,"--work",work);
    const prepared=agent("prepare"); expect(prepared.status,prepared.stderr).toBe(0);
    const plan=JSON.parse(readFileSync(path.join(work,"plan.json"),"utf8"));
    plan.author="agent:e2e-planner@1";
    plan.items.forEach((i:any,n:number)=>{i.reason="Synthetic UI fixture"; if(n>=3)i.action="reject";});
    writeFileSync(path.join(work,"plan.json"),JSON.stringify(plan));
    const checked=agent("check");expect(checked.status,checked.stderr).toBe(0);
    const packet=JSON.parse(readFileSync(path.join(work,"final-review-packet.json"),"utf8"));
    const review={schema_version:"content-review-v1",reviewer:"agent:e2e-reviewer@1",review_version:"e2e-final-v1",items:packet.items.map((i:any)=>({ordinal:i.ordinal,content_hash:i.content_hash,verdict:"approved",checklist:Object.fromEntries(REVIEW_CHECKLIST_KEYS.map(k=>[k,true])),reason:"Synthetic infrastructure fixture"}))};
    writeFileSync(path.join(work,"review.json"),JSON.stringify(review));
    const finalized=agent("finalize");expect(finalized.status,finalized.stderr).toBe(0);
    await page.getByText("Completed: 3 accepted",{exact:false}).waitFor(T);
    const b=(await api(`/api/v1/content/batches/${batchId}`)).json as {counts:Record<string,number>};
    expect(b.counts).toMatchObject({released:3,rejected:3});
    await shot("studio-completed");
    await page.getByText("Vocabulary exercises", {exact:true}).first().click();
    await page.getByTestId("vocab-studio").waitFor(T);
    expect(await page.getByLabel("Batch size").inputValue()).toBe("50");
    await shot("studio-vocabulary");
    // the same pages at phone width
    await page.setViewportSize({ width: 640, height: 900 });
    await shot("studio-640");
    await page.getByRole("button", { name: "AI Tasks",exact:true }).click();
    await page.getByTestId("jobs").waitFor(T);
    await shot("ai-tasks-640");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true); // no horizontal page scroll
  });

  it("a job can be cancelled from AI Tasks and the change is stored", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const r = await api("/api/v1/content/batches", { count: 24, mode: "balanced", trial: true });
    expect([202, 409]).toContain(r.status); // a second test batch is allowed
    await page.getByRole("button", { name: "AI Tasks",exact:true }).click();
    await page.getByTestId("jobs").waitFor(T);
    const row = page.getByTestId("jobs").locator("tbody tr[data-state='queued'], tbody tr[data-state='waiting_for_gpu']").first();
    await row.getByRole("button", { name: "Cancel" }).click();
    await expect.poll(async () => await page.getByTestId("jobs").locator("tbody tr[data-state='cancelled']").count(), T).toBeGreaterThan(0);
  });
});
