import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectProjectRoot } from "../../config.js";
import type { SttLaunch } from "./sttWorker.js";

export type LaunchResult = { ok: true; launch: SttLaunch; modelPath: string } | { ok: false; reason: string };

/**
 * Finds the LOCAL faster-whisper weights that are already installed (never downloads). Order: ENGLISHLAB_STT_MODEL_PATH, then the
 * Hugging Face cache snapshot of Systran/faster-whisper-small that TASK_002 verified. `small.en` is not installed; the multilingual
 * small model is used with language=en (D52).
 */
export function findSttModel(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.ENGLISHLAB_STT_MODEL_PATH;
  if (explicit) return existsSync(path.join(explicit, "model.bin")) ? explicit : null;
  const hub = path.join(env.HF_HOME ?? path.join(os.homedir(), ".cache", "huggingface"), "hub", "models--Systran--faster-whisper-small", "snapshots");
  try {
    for (const snap of readdirSync(hub)) {
      const p = path.join(hub, snap);
      if (existsSync(path.join(p, "model.bin"))) return p;
    }
  } catch {
    /* no cache */
  }
  return null;
}

/** Python 3.11 is selected explicitly (the system default is 3.13, where the CUDA stack is not installed): `py -3.11` on Windows. */
export function resolveSttLaunch(env: NodeJS.ProcessEnv = process.env, projectRoot = detectProjectRoot()): LaunchResult {
  const modelPath = findSttModel(env);
  if (!modelPath) return { ok: false, reason: "no_local_stt_model" };
  const script = path.join(projectRoot, "workers", "stt", "worker.py");
  if (!existsSync(script)) return { ok: false, reason: "worker_missing" };
  const custom = env.ENGLISHLAB_PYTHON;
  const [command, ...pre] = custom ? [custom] : process.platform === "win32" ? ["py", "-3.11"] : ["python3.11"];
  return { ok: true, modelPath, launch: { command: command!, args: [...pre, script, "--model-path", modelPath, "--device", "cuda", "--compute-type", "int8_float16", "--language", "en"] } };
}
