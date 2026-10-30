// Real browser and server, isolated database, synthetic microphone and mocked STT/AI responses; no GPU inference.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, expect, it } from "vitest";
import { freePort, makeScratchRoot, projectRoot } from "../../integration/helpers.js";

let scratch: ReturnType<typeof makeScratchRoot>;
let env: NodeJS.ProcessEnv;
let browser: Browser;
let page: Page;
let base: string;
const script = (name: string) => spawnSync(process.execPath, [path.join(projectRoot, "scripts", `${name}.mjs`)], { env, encoding: "utf8", timeout: 120_000 });

beforeAll(async () => {
  scratch = makeScratchRoot();
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  env = { ...process.env, ENGLISHLAB_DATA_ROOT: scratch.root, ENGLISHLAB_PORT: String(port), ENGLISHLAB_NO_OPEN: "1", ENGLISHLAB_AI: "off" };
  expect(script("seed-slice").status).toBe(0);
  expect(script("start").status).toBe(0);
  browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  page = await (await browser.newContext({ permissions: ["microphone"], viewport: { width: 1280, height: 900 } })).newPage();
  await page.addInitScript(() => {
    const w = window as unknown as { testTracks: MediaStreamTrack[] };
    w.testTracks = [];
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (...args) => {
      const stream = await original(...args);
      w.testTracks.push(...stream.getTracks());
      return stream;
    };
  });
  await page.route("**/api/v1/capabilities", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.stt.status = "ready";
    await route.fulfill({ response, json: body });
  });
  await page.route("**/api/v1/stt/start", (route) => route.fulfill({ status: 201, json: { streamId: "test-stream", maxSeconds: 60 } }));
  await page.route("**/api/v1/stt/test-stream/stop", (route) => route.fulfill({ status: 200, json: { stopped: true } }));
});

afterAll(async () => {
  await browser?.close();
  if (env) script("stop");
  scratch?.cleanup();
});

it("stops the synthetic microphone when leaving practice and reopens a finished session with an explicitly tentative AI draft", async () => {
  await page.goto(base);
  await page.getByTestId("start").click();
  for (let i = 0; i < 18; i++) {
    await page.getByTestId("slot").waitFor({ timeout: 15000 });
    const format = await page.getByTestId("slot").getAttribute("data-format");
    if (format === "guided_short_answer" || format === "russian_to_english_short") break;
    const previous = await page.getByTestId("slot").getAttribute("data-format");
    await page.getByTestId("skip").click();
    await page.waitForTimeout(400);
    void previous;
  }
  await page.getByRole("button", { name: "Speak instead" }).click();
  await page.waitForFunction(() => (window as unknown as { testTracks: MediaStreamTrack[] }).testTracks.length > 0);
  await page.getByRole("button", { name: "Content Studio", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { testTracks: MediaStreamTrack[] }).testTracks[0]?.readyState)).toBe("ended");
  await page.getByRole("button", { name: "Practice", exact: true }).click();
  await page.getByTestId("answer-text").fill("A short answer for review.");
  await page.getByTestId("submit").click();
  await page.getByTestId("feedback").waitFor();
  await page.route("**/api/v1/sessions/*/slots/*/feedback", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (body.state === "pending") body.aiReview = { judgement: "incorrect_candidate", explanation_ru: "Test explanation.", findings: [{ original: "answer", suggestion: "response", explanation_ru: "Test finding." }] };
    await route.fulfill({ response, json: body });
  });
  await page.getByRole("button", { name: "End this session early" }).click();
  await page.getByTestId("ai-review").waitFor({ timeout: 15000 });
  expect(await page.getByTestId("ai-review").innerText()).toContain("not a confirmed assessment");
  mkdirSync(path.join(projectRoot, "var", "fix-review-20261029", "screenshots"), { recursive: true });
  await page.screenshot({ path: path.join(projectRoot, "var", "fix-review-20261029", "screenshots", "tentative-review.png"), fullPage: true });
  await page.getByTestId("done").click();
  await page.getByTestId("review-recent").click();
  await page.getByTestId("ai-review").waitFor({ timeout: 15000 });
}, 120_000);
