import { execFileSync } from "node:child_process";

/** True if a process with this PID exists (signal 0 only probes; it never terminates anything). */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Process creation time (ISO, UTC) used as a start identity so a recycled PID is not mistaken for this app.
 * Windows only; returns null when it cannot be determined. Arguments are fixed; the PID is validated as an integer.
 */
export function getProcessStartTime(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0 || process.platform !== "win32") return null;
  try {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate.ToUniversalTime().ToString('o')`,
      ],
      { encoding: "utf8", timeout: 15000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}
