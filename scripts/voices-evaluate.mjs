// npm run voices:evaluate — measures the Piper voices (TASK_029, D125). Replaces dictation:voices.
// Objective part only: for every voice, sentences x pace grid are synthesised, transcribed by local faster-whisper large-v3 (exactly as the live
// check of Audio Dictation does it, numbers spelled out), and measured: word errors, Whisper's confidence per word, speaking rate, real clipping,
// long pauses, and a predicted quality score (DNSMOS P.835, CPU). Accent and whether a voice is pleasant are NOT measured: listen to the report page.
// Run with the app stopped or its GPU work idle.
//   --quick   20 sentences, voice pace only (a few minutes)       --dry    write nothing to the database (report only)
//   --apply   create settings revisions (source 'evaluation') with the proposed pace / speed-up / noise_w_scale; never the weight, on/off or topics
//   --voices clancy,banjo   only these voices
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { alignWords, sameWord, spellNumbers, tokenize } from "@english-lab/contracts";
import { loadServerModule, projectRoot, requireBuild } from "./_common.mjs";
import { modelDir, startPiper } from "./dictation-setup.mjs";
import { SCRIPT_VERSION, measure, recommend, summarize } from "./lib/voiceMetrics.mjs";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const quick = flag("--quick");
const dry = flag("--dry");
const apply = flag("--apply");
const only = argv.includes("--voices") ? argv[argv.indexOf("--voices") + 1].split(",") : null;

requireBuild({ web: false });
const { loadConfig } = await loadServerModule("config.js");
const { openDatabase } = await loadServerModule("db/open.js");
const { createBackup, verifyBackup } = await loadServerModule("db/backup.js");
const { currentSchemaVersion } = await loadServerModule("db/migrate.js");
const { loadVoices, saveVoiceSettings } = await loadServerModule("domain/voices/catalog.js");

const sentenceFile = path.join(projectRoot, "content", "voices", "eval-sentences.json");
const sentenceSet = JSON.parse(readFileSync(sentenceFile, "utf8"));
const SENTENCES = quick ? sentenceSet.sentences.slice(0, 20) : sentenceSet.sentences;
const runId = randomUUID();
const outDir = path.join(projectRoot, "var", "voice-eval", runId);
const modelFile = path.join(projectRoot, "var", "models", "dnsmos", "sig_bak_ovr.onnx");
const DNSMOS_URL = "https://github.com/microsoft/DNS-Challenge/raw/master/DNSMOS/DNSMOS/sig_bak_ovr.onnx";
const inSubset = (i) => i % 3 === 0;

// grid: factors of the voice's own pace on every sentence; slower and a narrower rhythm noise on a common subset (like for like)
const plan = (i) => {
  if (quick) return [{ factor: 1, noiseW: null }];
  const base = [{ factor: 1, noiseW: null }, { factor: 0.9, noiseW: null }, { factor: 0.8, noiseW: null }];
  return inSubset(i) ? [...base, { factor: 1.1, noiseW: null }, { factor: 1, noiseW: 0.5 }] : base;
};

async function synth(port, text, speakerId, lengthScale, noiseW, noiseScale = null) {
  const r = await fetch(`http://127.0.0.1:${port}/synthesize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, speaker_id: speakerId, length_scale: lengthScale, ...(noiseW !== null ? { noise_w_scale: noiseW } : {}), ...(noiseScale !== null ? { noise_scale: noiseScale } : {}) }),
  });
  if (!r.ok) throw new Error(`/synthesize answered HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

class Asr {
  constructor() {
    this.child = spawn("py", ["-3.11", path.join(projectRoot, "workers", "dictation_asr", "check.py")], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
    this.waiting = new Map();
    this.seq = 0;
    this.ready = new Promise((resolve, reject) => {
      createInterface({ input: this.child.stdout }).on("line", (line) => {
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          return;
        }
        if (m.event === "ready") resolve(m);
        else if (m.event === "error") reject(new Error(m.error));
        else this.waiting.get(m.id)?.(m);
      });
      this.child.once("exit", () => reject(new Error("ASR worker exited")));
    });
  }
  transcribe(wav) {
    const id = ++this.seq;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.child.stdin.write(`${JSON.stringify({ id, wav: wav.toString("base64"), words: true })}\n`);
    });
  }
  stop() {
    try {
      this.child.stdin.write(`${JSON.stringify({ op: "shutdown" })}\n`);
      this.child.stdin.end();
    } catch {
      /* gone */
    }
  }
}

async function dnsmos(wavDir) {
  if (!existsSync(modelFile)) {
    try {
      mkdirSync(path.dirname(modelFile), { recursive: true });
      const res = await fetch(DNSMOS_URL);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(`${modelFile}.part`));
      renameSync(`${modelFile}.part`, modelFile);
    } catch (e) {
      return { tool: null, error: `DNSMOS model not available (${e.message})`, scores: {} };
    }
  }
  const r = spawnSync("py", ["-3.11", path.join(projectRoot, "workers", "voice_eval", "dnsmos.py"), "--model", modelFile, "--dir", wavDir], { encoding: "utf8", windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) return { tool: null, error: `DNSMOS failed: ${(r.stderr || "").slice(-300)}`, scores: {} };
  const out = JSON.parse(r.stdout);
  return { tool: { name: out.model, onnxruntime: out.onnxruntime }, scores: out.scores };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

async function main() {
  const config = loadConfig();
  const manifest = JSON.parse(readFileSync(path.join(modelDir, "manifest.json"), "utf8"));
  const modelSha = manifest.files["en_AU-librivox-medium.onnx"];
  const db = openDatabase(config.dbPath);
  let voices = loadVoices(db);
  if (only) voices = voices.filter((v) => only.includes(v.name));
  const wavDir = path.join(outDir, "wav");
  mkdirSync(wavDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const server = await startPiper();
  const asr = new Asr();
  const asrReady = await asr.ready;
  const clips = [];
  let aborted = null;
  try {
    for (const v of voices) {
      const t0 = Date.now();
      for (let i = 0; i < SENTENCES.length; i++) {
        const text = SENTENCES[i];
        for (const { factor, noiseW } of plan(i)) {
          const lengthScale = Math.min(1.8, Math.max(0.7, Math.round(v.lengthScale * factor * 100) / 100));
          const s0 = Date.now();
          // the base clips use the voice's own settings, so a later run compares what is really used (the stored noise_w_scale column is only the tried variant)
          const wav = await synth(server.port, text, v.id, lengthScale, noiseW ?? v.noiseWScale, v.noiseScale);
          const synthMs = Date.now() - s0;
          const file = `${v.name}-f${factor}${noiseW !== null ? `-nw${noiseW}` : ""}-${String(i + 1).padStart(2, "0")}.wav`;
          writeFileSync(path.join(wavDir, file), wav);
          const m = measure(wav, text);
          const heard = await asr.transcribe(wav);
          // the same comparison as the live check (D97, D127): numbers spelled out, regional spellings equal
          const wordErrors = heard.ok ? alignWords(tokenize(text), tokenize(spellNumbers(heard.text ?? ""))).distance : null;
          clips.push({ voiceKey: v.key, name: v.name, factor, noiseW, lengthScale, sentenceIndex: i, text, file, heard: heard.ok ? heard.text : `(${heard.error})`, wordErrors, metrics: { factor, ...m, rtf: Math.round((synthMs / m.durationMs) * 1000) / 1000, minWordProb: heard.minWordProb ?? null, meanWordProb: heard.meanWordProb ?? null, avgLogprob: heard.avgLogprob ?? null, mos: null } });
        }
      }
      const mine = clips.filter((c) => c.voiceKey === v.key && c.factor === 1 && c.noiseW === null);
      const sum = summarize(mine);
      console.log(`${v.name.padEnd(8)} base ${v.lengthScale}  exact ${sum.exactRate}  WER ${sum.wer}  wpm ${sum.wpm}  (${Math.round((Date.now() - t0) / 1000)} s)`);
    }
  } catch (e) {
    aborted = e;
    console.error(`stopped early: ${e.message}`);
  } finally {
    await server.stop();
    asr.stop();
  }

  // predicted quality, after the engines are stopped (CPU only)
  const mos = await dnsmos(wavDir);
  if (mos.error) console.error(mos.error);
  for (const c of clips) {
    const s = mos.scores[c.file];
    if (s && typeof s.ovr === "number") Object.assign(c.metrics, { mos: s.ovr, mosSig: s.sig, mosBak: s.bak });
  }

  // per voice: summaries and proposals
  const report = voices.map((v) => {
    const mine = clips.filter((c) => c.voiceKey === v.key);
    const at = (f, subsetOnly) => mine.filter((c) => c.factor === f && c.noiseW === null && (!subsetOnly || inSubset(c.sentenceIndex)));
    const full = Object.fromEntries([1, 0.9, 0.8].map((f) => [f, at(f, false).length ? summarize(at(f, false)) : null]));
    const sub = Object.fromEntries([1.1, 1, 0.9, 0.8].map((f) => [f, at(f, !quick).length ? summarize(at(f, !quick)) : null]));
    const noiseClips = mine.filter((c) => c.noiseW === 0.5);
    const noise = noiseClips.length ? summarize(noiseClips) : null;
    const rec = recommend(v, { sub, full, noise });
    return { key: v.key, name: v.name, gender: v.gender, ageGroup: v.ageGroup, lengthScale: v.lengthScale, full, sub, noise, proposal: rec.patch, notes: rec.notes };
  });
  const complete = !aborted && !quick && !only && voices.length > 0 && mos.tool !== null && clips.every((c) => c.wordErrors !== null);
  const result = { runId, startedAt, finishedAt: new Date().toISOString(), scriptVersion: SCRIPT_VERSION, sentenceSetVersion: sentenceSet.version, sentences: SENTENCES.length, modelSha, tools: { asr: asrReady, mos: mos.tool, accent: null, secondAsr: null }, status: complete ? "complete" : "partial", voices: report };
  writeFileSync(path.join(outDir, "result.json"), JSON.stringify({ ...result, clips }, null, 2));
  writeFileSync(path.join(outDir, "index.html"), page(result, clips));
  console.log(`report: ${path.join(outDir, "index.html")}  (status ${result.status})`);
  for (const r of report) if (r.notes.length) console.log(`${r.name}: ${r.notes.join("; ")}`);

  if (!dry) {
    const manifestBackup = await createBackup(db, { backupsDir: config.backupsDir, kind: "manual", schemaVersion: currentSchemaVersion(db), appVersion: config.appVersion });
    const check = verifyBackup(config.backupsDir, manifestBackup);
    if (!check.checksumOk || check.integrity !== "ok") throw new Error("the backup before writing did not verify");
    const insRun = db.prepare("INSERT INTO tts_voice_eval_runs(id, started_at, finished_at, tts_model_sha256, script_version, sentence_set_version, tools_json, status) VALUES (?,?,?,?,?,?,?,?)");
    const insClip = db.prepare("INSERT INTO tts_voice_eval_clips(id, run_id, voice_key, length_scale, noise_w_scale, sentence_index, text, heard_text, word_errors, metrics_json) VALUES (?,?,?,?,?,?,?,?,?,?)");
    db.transaction(() => {
      insRun.run(runId, startedAt, result.finishedAt, modelSha, SCRIPT_VERSION, sentenceSet.version, JSON.stringify(result.tools), result.status);
      for (const c of clips) insClip.run(randomUUID(), runId, c.voiceKey, c.lengthScale, c.noiseW, c.sentenceIndex, c.text, c.heard, c.wordErrors, JSON.stringify(c.metrics));
    }).immediate();
    console.log(`stored in the database: ${clips.length} clips, run ${runId}`);
    if (apply) {
      if (result.status !== "complete") console.error("--apply skipped: only a complete run may change settings");
      else {
        for (const r of report) {
          if (Object.keys(r.proposal).length === 0) continue;
          saveVoiceSettings(db, { now: () => new Date(), newId: randomUUID }, r.key, r.proposal, "evaluation", `voices:evaluate run ${runId}: ${r.notes.join("; ")}`.slice(0, 500));
          console.log(`${r.name}: new settings revision (${r.notes.join("; ")})`);
        }
      }
    }
  } else console.log("--dry: nothing written to the database");
  db.close();
  if (aborted) process.exit(1);
}

function page(r, clips) {
  const f = (s, k) => (s ? s[k] ?? "—" : "—");
  const rows = r.voices
    .map((v) => `<tr><td>${esc(v.name)} (${v.gender}, ${v.ageGroup})</td><td>${v.lengthScale}</td><td>${f(v.full[1], "exactRate")}</td><td>${f(v.full[1], "wer")}</td><td>${f(v.full[1], "wpm")}</td><td>${f(v.full[1], "mos")}</td><td>${f(v.full[0.9], "exactRate")}</td><td>${f(v.full[0.8], "exactRate")}</td><td>${f(v.full[1], "minWordProb")}</td><td>${f(v.full[1], "trueClip")}</td><td>${f(v.full[1], "longPauses")}</td><td>${esc(v.notes.join("; ") || "no change")}</td></tr>`)
    .join("");
  const detail = r.voices
    .map((v) => {
      const bad = clips.filter((c) => c.voiceKey === v.key && c.wordErrors !== 0 && c.factor === 1 && c.noiseW === null);
      const good = clips.filter((c) => c.voiceKey === v.key && c.wordErrors === 0 && c.factor === 1 && c.noiseW === null).slice(0, 3);
      return `<h2>${esc(v.name)}</h2><table>${[...good, ...bad].map((c) => `<tr class="${c.wordErrors ? "bad" : ""}"><td><audio controls preload="none" src="wav/${esc(c.file)}"></audio></td><td>${esc(c.text)}<br><small>heard: ${esc(c.heard)}</small></td><td>${c.metrics.wpm} wpm${c.metrics.mos ? ` · MOS ${c.metrics.mos}` : ""}</td></tr>`).join("")}</table>`;
    })
    .join("");
  return `<!doctype html><meta charset="utf-8"><title>Voice evaluation</title><style>body{font:15px system-ui;margin:2rem;max-width:1200px}table{border-collapse:collapse;margin-bottom:1rem}td,th{border:1px solid #bbb;padding:.25rem .5rem;text-align:left}.bad{background:#fde}small{color:#555}</style>
<h1>Piper voices: evaluation ${esc(r.runId)}</h1><p>${esc(r.startedAt)} · ${r.sentences} sentences · status <b>${r.status}</b> · speech check ${esc(JSON.stringify(r.tools.asr))} · quality score ${esc(JSON.stringify(r.tools.mos))}. Objective numbers only. <b>Accent and pleasantness are not measured: listen to the clips.</b> The quality score (DNSMOS) was made for noisy speech and says only how clean and speech-like a clip sounds.</p>
<table><tr><th>Voice</th><th>pace</th><th>exact</th><th>WER</th><th>wpm</th><th>MOS</th><th>exact x0.9</th><th>exact x0.8</th><th>min word prob</th><th>clipped</th><th>long pauses</th><th>proposal</th></tr>${rows}</table>${detail}`;
}

main().catch((e) => {
  console.error(e.stack ?? e.message);
  process.exit(1);
});
