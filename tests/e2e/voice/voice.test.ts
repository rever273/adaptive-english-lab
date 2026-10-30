// TASK_011: a REAL browser (Edge, fake microphone playing synthetic speech) talks to the REAL server, the REAL local STT worker and the real GPU.
// The "microphone" is a WAV that this test synthesises with Windows System.Speech (a test input, not a user's audio) and deletes afterwards.
// Needs: npm run build, no Ollama model resident, the installed faster-whisper-small weights. ENGLISHLAB_AI=off keeps the language models out of it.
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freePort, makeScratchRoot, projectRoot } from "../../integration/helpers.js";

const T = { timeout: 30_000 };
const SHOTS = path.join(projectRoot, "documentation", "spec", "evidence", "task-011", "screenshots");
let scratch: ReturnType<typeof makeScratchRoot>;
let base: string;
let env: NodeJS.ProcessEnv;
let browser: Browser;
let page: Page;
let wav: string;
const steps: unknown[] = [];
const script = (name: string, ...args: string[]) => spawnSync(process.execPath, [path.join(projectRoot, "scripts", `${name}.mjs`), ...args], { env, encoding: "utf8", timeout: 120_000 });
const q = <T>(sql: string, ...p: unknown[]): T[] => {
  const d = new Database(path.join(scratch.root, "db", "english-lab.sqlite"), { readonly: true });
  try {
    return d.prepare(sql).all(...p) as T[];
  } finally {
    d.close();
  }
};
const shot = async (name: string) => {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
  steps.push({ screenshot: name });
};
const gpuUsedMib = (): number => Number(spawnSync("nvidia-smi", ["--query-gpu=memory.used", "--format=csv,noheader,nounits"], { encoding: "utf8" }).stdout.trim());
const workerProcesses = (): number => {
  const r = spawnSync("powershell", ["-NoProfile", "-Command", "(Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'py*' -and $_.CommandLine -like '*workers*stt*worker.py*' }).Count"], { encoding: "utf8" });
  return Number(r.stdout.trim() || "0");
};

beforeAll(async () => {
  scratch = makeScratchRoot();
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  wav = path.join(scratch.root, "mic.wav");
  const ps = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SelectVoice('Microsoft Zira Desktop'); $s.SetOutputToWaveFile('${wav.replace(/\\/g, "\\\\")}'); $s.Speak('The employee stopped checking emails after the shift.'); $s.Dispose()`;
  expect(spawnSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" }).status).toBe(0);
  env = { ...process.env, ENGLISHLAB_DATA_ROOT: scratch.root, ENGLISHLAB_PORT: String(port), ENGLISHLAB_NO_OPEN: "1", ENGLISHLAB_AI: "off" };
  expect(script("seed-slice").status).toBe(0);
  expect(script("start").status).toBe(0);
  browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}`] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["microphone"] });
  page = await ctx.newPage();
});
afterAll(async () => {
  await browser?.close();
  script("stop");
  rmSync(wav, { force: true });
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(path.join(SHOTS, "e2e-report.json"), JSON.stringify({ browser: "msedge (installed), fake microphone", base, steps }, null, 2));
  scratch?.cleanup();
});

describe("speaking an answer", () => {
  it("record -> editable text -> submit as a voice attempt; the card is freed afterwards", async () => {
    const before = gpuUsedMib();
    await page.goto(base);
    await page.getByTestId("start").click();
    await page.getByTestId("slot").waitFor(T);
    // move on to a short written format (the speak button exists only there)
    for (let i = 0; i < 18; i++) {
      const fmt = await page.getByTestId("slot").getAttribute("data-format");
      if (fmt === "guided_short_answer" || fmt === "russian_to_english_short") break;
      await page.getByTestId("skip").click();
      await page.waitForTimeout(400);
    }
    const format = await page.getByTestId("slot").getAttribute("data-format");
    expect(["guided_short_answer", "russian_to_english_short"]).toContain(format);
    expect(await page.getByTestId("answer-text").isVisible()).toBe(true);
    await shot("voice-1-before");

    await page.getByTestId("record").click();
    await page.getByTestId("stop-record").waitFor(T).catch(async (e) => {
      await shot("voice-FAILED");
      throw new Error(`recording did not start; voice panel says: ${await page.getByTestId("voice").innerText()} | ${(e as Error).message.slice(0, 80)}`);
    }); // appears only after the card was cleared and the model really warmed up
    expect(workerProcesses()).toBeGreaterThan(0);
    await shot("voice-2-recording");
    await page.waitForTimeout(5500); // the fake microphone plays the sentence
    await page.getByTestId("stop-record").click();
    await page.getByTestId("voice-draft-note").waitFor(T);
    const heard = await page.getByTestId("answer-text").inputValue();
    expect(heard.toLowerCase()).toContain("employee stopped checking");
    await shot("voice-3-draft");

    // the learner fixes the text before submitting
    const edited = "The employee stopped checking emails after work.";
    await page.getByTestId("answer-text").fill(edited);
    await page.getByTestId("submit").click();
    await page.getByTestId("feedback").waitFor(T);

    const t = q<{ asr_text: string; submitted_text: string; edited: number }>("SELECT asr_text, submitted_text, edited FROM transcripts");
    expect(t).toHaveLength(1);
    expect(t[0]!.submitted_text).toBe(edited);
    expect(t[0]!.edited).toBe(1);
    expect(t[0]!.asr_text.toLowerCase()).toContain("employee stopped checking");
    const a = q<{ input_mode: string; transcript_id: string | null }>("SELECT input_mode, transcript_id FROM attempts ORDER BY rowid DESC LIMIT 1")[0]!;
    expect(a.input_mode).toBe("voice");
    expect(a.transcript_id).not.toBeNull();
    steps.push({ voiceAttempt: { heard, edited, asr: t[0]!.asr_text } });
    await shot("voice-4-submitted");

    // ending the session stops the worker and the card returns
    await page.getByRole("button", { name: "End this session early" }).click();
    await expect.poll(() => workerProcesses(), { timeout: 20_000 }).toBe(0);
    await expect.poll(() => gpuUsedMib() - before <= 200, { timeout: 20_000 }).toBe(true);
    steps.push({ gpuBeforeMib: before, gpuAfterMib: gpuUsedMib() });
  });

  it("no recording survives anywhere under the data root", () => {
    // the synthetic mic file is the test's own and lives under the same scratch root only until afterAll; the server never wrote another audio file
    const files = spawnSync("powershell", ["-NoProfile", "-Command", `Get-ChildItem -Recurse -File '${scratch.root}' | Where-Object { $_.Extension -in '.wav','.pcm','.mp3','.webm','.ogg','.flac' } | ForEach-Object { $_.FullName }`], { encoding: "utf8" }).stdout.split(/\r?\n/).filter(Boolean);
    expect(files.map((f) => path.basename(f))).toEqual(["mic.wav"]);
  });
});
