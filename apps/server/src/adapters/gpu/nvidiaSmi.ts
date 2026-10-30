import { execFile } from "node:child_process";
import type { GpuSample, TelemetryProvider } from "../../queue/types.js";

/**
 * GPU telemetry from nvidia-smi: allowlisted executable, fixed argument array, no shell (spec/07, spec/11). Readings are raw
 * numbers about the whole card (other applications included); they are never presented as this app's own usage.
 */
export class NvidiaSmiTelemetry implements TelemetryProvider {
  constructor(private readonly exe = "nvidia-smi") {}

  sample(): Promise<GpuSample | null> {
    return new Promise((resolve) => {
      execFile(this.exe, ["--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"], { timeout: 5000, windowsHide: true }, (err, stdout) => {
        if (err) return resolve(null);
        const first = String(stdout).trim().split(/\r?\n/)[0] ?? "";
        const m = /^(\d+)\s*,\s*(\d+)$/.exec(first);
        if (!m) return resolve(null);
        resolve({ usedMib: Number(m[1]), totalMib: Number(m[2]), at: Date.now() });
      });
    });
  }
}
