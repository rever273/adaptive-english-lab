// npm run verify:stt   (REAL local STT on the GPU: faster-whisper small, installed weights, no download)
// Synthetic speech (Windows System.Speech, voice Zira en-US) is generated into var/stt-verify, converted to 16 kHz mono PCM in memory and
// DELETED at the end: it is test input made by this script, never a user's audio. Measures cold start (spawn -> ready), decode of real speech
// (word overlap with what was said), 20 warm decodes (p50/p95), silence (must give no invented text), peak VRAM, and proves that stopping
// our own child frees the card again. Refuses to start while an Ollama model is resident. Evidence: documentation/spec/evidence/task-011/.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadServerModule, projectRoot, requireBuild } from "./_common.mjs";

requireBuild({ web: false });
const { SttWorker } = await loadServerModule("adapters/stt/sttWorker.js");
const { resolveSttLaunch } = await loadServerModule("adapters/stt/launch.js");
const { NvidiaSmiTelemetry } = await loadServerModule("adapters/gpu/nvidiaSmi.js");
const { OllamaClient, OllamaModelControl } = await loadServerModule("adapters/gpu/ollamaClient.js");

const control = new OllamaModelControl(new OllamaClient());
const resident = await control.listLoaded();
if (resident === null || resident.length > 0) {
  console.error(`Refusing to run: Ollama unreachable or a model is resident (${JSON.stringify(resident)}).`);
  process.exit(2);
}
const telemetry = new NvidiaSmiTelemetry();
const base = await telemetry.sample();
if (!base) throw new Error("nvidia-smi telemetry unavailable");

const work = path.join(projectRoot, "var", "stt-verify");
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const PHRASES = ["The employee stopped checking emails after the shift.", "Could you tell me when the library closes?", "If I had more time, I would learn another language.", "We are waiting for the bus near the station.", "She suggested going to the beach after work."];

function synth(text, file) {
  const ps = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SelectVoice('Microsoft Zira Desktop'); $f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono); $s.SetOutputToWaveFile('${file.replace(/\\/g, "\\\\")}', $f); $s.Speak('${text}'); $s.Dispose()`;
  const r = spawnSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`speech synthesis failed: ${r.stderr}`);
  const wav = readFileSync(file);
  const at = wav.indexOf(Buffer.from("data")) + 8; // PCM starts after the 'data' chunk header
  return wav.subarray(at);
}
const clips = PHRASES.map((t, i) => ({ text: t, pcm: synth(t, path.join(work, `p${i}.wav`)) }));
for (const f of readdirSync(work)) rmSync(path.join(work, f)); // the synthetic wav files are gone before any decoding starts

const words = (s) => s.toLowerCase().replace(/[^a-z' ]+/g, " ").split(/\s+/).filter(Boolean);
const overlap = (said, heard) => {
  const w = words(said);
  const h = new Set(words(heard));
  return w.filter((x) => h.has(x)).length / w.length;
};
const pct = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.max(0, Math.ceil((p / 100) * a.length) - 1))];

const tmpBefore = readdirSync(os.tmpdir()).length;
const launch = resolveSttLaunch();
if (!launch.ok) throw new Error(`no STT launch: ${launch.reason}`);
const out = { startedAt: new Date().toISOString(), environment: { node: process.version, baselineUsedMib: base.usedMib, totalMib: base.totalMib }, launch: { command: launch.launch.command, model: launch.modelPath }, };
let peak = base.usedMib;
let sampling = true;
const sampler = (async () => {
  while (sampling) {
    const s = await telemetry.sample();
    if (s) peak = Math.max(peak, s.usedMib);
    await new Promise((r) => setTimeout(r, 200));
  }
})();

const t0 = Date.now();
const worker = new SttWorker(launch.launch);
const ready = await worker.start();
out.cold = { spawnToReadyMs: Date.now() - t0, ...ready };
console.log("ready", JSON.stringify(out.cold));

out.speech = [];
for (const c of clips) {
  const r = await worker.transcribe(c.pcm);
  out.speech.push({ said: c.text, heard: r.text, overlap: Math.round(overlap(c.text, r.text) * 100) / 100, audioSeconds: r.audioSeconds, decodeSeconds: r.decodeSeconds });
}
console.table(out.speech.map((s) => ({ said: s.said.slice(0, 40), heard: s.heard.slice(0, 40), overlap: s.overlap, decode: s.decodeSeconds })));

const warm = [];
for (let i = 0; i < 20; i++) {
  const c = clips[i % clips.length];
  const t = Date.now();
  await worker.transcribe(c.pcm);
  warm.push((Date.now() - t) / 1000);
}
out.warm = { n: warm.length, p50: pct(warm, 50), p95: pct(warm, 95), max: Math.max(...warm) };

const silence = [];
for (let i = 0; i < 5; i++) silence.push((await worker.transcribe(Buffer.alloc(16000 * 2 * 3))).text);
out.silence = { n: silence.length, texts: silence, allEmpty: silence.every((t) => t === "") };

const errors = {};
for (const [name, buf] of [["too_short", Buffer.alloc(100)], ["odd", Buffer.alloc(3201)]]) {
  try {
    await worker.transcribe(buf);
    errors[name] = "accepted (BAD)";
  } catch (e) {
    errors[name] = e.code;
  }
}
out.refusals = errors;
out.peakUsedMib = peak;
out.peakAdditionalMib = peak - base.usedMib;

const pid = worker.pid;
const tStop = Date.now();
const exitCode = await worker.stop();
sampling = false;
await sampler;
let after = null;
for (let i = 0; i < 20; i++) {
  after = await telemetry.sample();
  if (after && after.usedMib - base.usedMib <= 128) break;
  await new Promise((r) => setTimeout(r, 500));
}
let alive = true;
try {
  process.kill(pid, 0);
} catch {
  alive = false;
}
out.teardown = { exitCode, stopMs: Date.now() - tStop, childAlive: alive, usedAfterMib: after?.usedMib, returnedToBaseline: after ? after.usedMib - base.usedMib <= 128 : false };
out.noNewTempFiles = readdirSync(os.tmpdir()).length - tmpBefore <= 2; // the OS may create unrelated entries; we only look for a flood
out.leftoverVerifyFiles = readdirSync(work).length;
rmSync(work, { recursive: true, force: true });
out.finalPs = await control.listLoaded();
out.finishedAt = new Date().toISOString();
const dir = path.join(projectRoot, "documentation", "spec", "evidence", "task-011");
mkdirSync(dir, { recursive: true });
const file = path.join(dir, `stt-verify-${out.startedAt.replace(/[-:]/g, "").slice(0, 15)}Z.json`);
writeFileSync(file, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ cold: out.cold.spawnToReadyMs, warm: out.warm, silence: out.silence.allEmpty, refusals: out.refusals, peakAdditionalMib: out.peakAdditionalMib, teardown: out.teardown }, null, 1));
console.log("evidence:", file);
