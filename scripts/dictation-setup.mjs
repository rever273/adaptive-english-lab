// npm run dictation:setup — installs the local Piper text-to-speech engine for Audio Dictation (TASK_028, D84).
// Piper goes into its OWN venv (var/venvs/piper): the shared Python 3.11 holds onnxruntime-gpu for speech recognition and
// `piper-tts` pulls the plain `onnxruntime`, which would shadow it. The voice model (CC BY 4.0) goes to var/models/piper.
// Idempotent: whatever is already in place is not downloaded or installed again. Nothing here is imported by the app.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream, renameSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { projectRoot } from "./_common.mjs";

export const PIPER_VERSION = "1.8.0";
export const MODEL_NAME = "en_AU-librivox-medium";
const BASE = "https://huggingface.co/DataCraftsmanAustralia/piper-en_AU-librivox-medium/resolve/main/";
const FILES = [`${MODEL_NAME}.onnx`, `${MODEL_NAME}.onnx.json`, "ATTRIBUTION.md"];

function readLocal() {
  try {
    return JSON.parse(readFileSync(path.join(projectRoot, "englishlab.local.json"), "utf8"));
  } catch {
    return {};
  }
}
const local = readLocal();
// espeak-ng (inside Piper) cannot open data files below a path with non-ASCII characters (Windows ANSI paths). When the project folder has
// such characters, the venv and the model go to %LOCALAPPDATA%\EnglishLab\piper instead of var/ (the same rule is in apps/server/src/config.ts).
const asciiRoot = /^[ -~]*$/.test(projectRoot) ? path.join(projectRoot, "var") : path.join(process.env.LOCALAPPDATA ?? "", "EnglishLab", "piper");
export const piperPython = path.resolve(projectRoot, local.piperPython ?? path.join(asciiRoot, "venvs", "piper", "Scripts", "python.exe"));
export const modelDir = path.resolve(projectRoot, local.piperModelDir ?? path.join(asciiRoot, "models", "piper"));

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status}): ${r.stderr || r.stdout}`);
  return r.stdout;
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

async function download(name) {
  const target = path.join(modelDir, name);
  if (existsSync(target)) return false;
  const response = await fetch(BASE + name);
  if (!response.ok || !response.body) throw new Error(`download of ${name} failed: HTTP ${response.status}`);
  const tmp = `${target}.part`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(tmp));
  renameSync(tmp, target);
  return true;
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** starts the Piper HTTP server, waits for /info, returns { port, info, stop } */
export async function startPiper() {
  const port = await freePort();
  const child = spawn(piperPython, ["-m", "piper.http_server", "-m", MODEL_NAME, "--data-dir", modelDir, "--host", "127.0.0.1", "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const started = Date.now();
  for (;;) {
    if (child.exitCode !== null) throw new Error(`piper http server exited early: ${log.slice(-800)}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/info`);
      if (r.ok) {
        const info = await r.json().catch(() => ({}));
        return {
          port,
          info,
          loadSeconds: (Date.now() - started) / 1000,
          pid: child.pid,
          stop: async () => {
            child.kill();
            await Promise.race([exited, new Promise((r2) => setTimeout(r2, 3000))]);
            if (child.exitCode === null && child.pid) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
          },
        };
      }
    } catch {
      /* not up yet */
    }
    if (Date.now() - started > 90_000) {
      child.kill();
      throw new Error(`piper http server did not answer /info in 90 s: ${log.slice(-800)}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

export async function synthesize(port, text, speakerId = 1, lengthScale = 1.1) {
  const r = await fetch(`http://127.0.0.1:${port}/synthesize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, speaker_id: speakerId, length_scale: lengthScale }),
  });
  if (!r.ok) throw new Error(`/synthesize answered HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return Buffer.from(await r.arrayBuffer());
}

async function main() {
  const report = {};
  const sharedBefore = run("py", ["-3.11", "-m", "pip", "list", "--format=freeze"]);
  const gpuLine = sharedBefore.split(/\r?\n/).find((l) => l.toLowerCase().startsWith("onnxruntime-gpu==")) ?? null;

  if (!existsSync(piperPython)) {
    console.log("creating the Piper venv…");
    mkdirSync(path.dirname(path.dirname(piperPython)), { recursive: true });
    run("py", ["-3.11", "-m", "venv", path.resolve(path.dirname(piperPython), "..")]);
  }
  const have = spawnSync(piperPython, ["-m", "pip", "show", "piper-tts"], { encoding: "utf8", windowsHide: true });
  if (have.status !== 0 || !new RegExp(`^Version: ${PIPER_VERSION}$`, "m").test(have.stdout)) {
    console.log(`installing piper-tts[http]==${PIPER_VERSION} into the venv…`);
    run(piperPython, ["-m", "pip", "install", `piper-tts[http]==${PIPER_VERSION}`], { maxBuffer: 64 * 1024 * 1024 });
  }
  report.piperVersion = PIPER_VERSION;

  mkdirSync(modelDir, { recursive: true });
  for (const f of FILES) if (await download(f)) console.log(`downloaded ${f}`);
  const manifest = { model: MODEL_NAME, source: BASE, files: Object.fromEntries(FILES.map((f) => [f, sha256(path.join(modelDir, f))])) };
  writeFileSync(path.join(modelDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  report.modelSha256 = manifest.files[`${MODEL_NAME}.onnx`];

  console.log("starting the Piper HTTP server for the check…");
  const server = await startPiper();
  try {
    const wav = await synthesize(server.port, "The quick brown fox jumped over the lazy dog.");
    if (wav.length < 2000 || wav.toString("ascii", 0, 4) !== "RIFF") throw new Error("the check phrase did not come back as a WAV");
    report.checkWavBytes = wav.length;
    report.serverLoadSeconds = server.loadSeconds;
    report.info = server.info;
  } finally {
    await server.stop();
  }

  const sharedAfter = run("py", ["-3.11", "-m", "pip", "list", "--format=freeze"]);
  const gpuAfter = sharedAfter.split(/\r?\n/).find((l) => l.toLowerCase().startsWith("onnxruntime-gpu==")) ?? null;
  const plain = sharedAfter.split(/\r?\n/).some((l) => /^onnxruntime==/i.test(l));
  report.sharedPython = { onnxruntimeGpuBefore: gpuLine, onnxruntimeGpuAfter: gpuAfter, plainOnnxruntimeInShared: plain, piperInShared: /^piper-tts==/im.test(sharedAfter) };
  console.log(JSON.stringify(report, null, 2));
  if (gpuLine !== gpuAfter || report.sharedPython.piperInShared) {
    console.error("The shared Python 3.11 changed. Check onnxruntime-gpu before using speech recognition.");
    process.exit(1);
  }
}

import { fileURLToPath } from "node:url";
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
