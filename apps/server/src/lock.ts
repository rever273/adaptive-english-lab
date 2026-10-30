import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import { getProcessStartTime, isPidAlive } from "./processIdentity.js";

/** Contents of var/run/server.lock.json: singleton lock + identity used by stop/start scripts. */
export interface LockInfo {
  pid: number;
  /** ISO creation time of the PID; null when it could not be read. */
  processStartTime: string | null;
  instanceId: string;
  startedAt: string;
  port: number;
  /** Random per-start token; authorises POST /internal/shutdown from the stop script only. */
  shutdownToken: string;
}

export class LockError extends Error {
  constructor(
    readonly code: "ALREADY_RUNNING" | "LOCK_UNVERIFIABLE",
    message: string,
    readonly lock: LockInfo | null,
  ) {
    super(message);
    this.name = "LockError";
  }
}

export function readLock(lockPath: string): LockInfo | null {
  let text: string;
  try {
    text = readFileSync(lockPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    const v = JSON.parse(text) as LockInfo;
    if (!Number.isInteger(v.pid) || typeof v.instanceId !== "string" || !Number.isInteger(v.port)) throw new Error("shape");
    return v;
  } catch {
    throw new LockError("LOCK_UNVERIFIABLE", `lock file ${lockPath} exists but is unreadable; inspect it manually instead of deleting blindly`, null);
  }
}

export type LockState = "alive" | "stale" | "unverifiable";

/** Decides whether the recorded holder is still this application (PID alive AND same start time). */
export function classifyLock(lock: LockInfo): LockState {
  if (!isPidAlive(lock.pid)) return "stale";
  const now = getProcessStartTime(lock.pid);
  if (lock.processStartTime && now) return lock.processStartTime === now ? "alive" : "stale";
  return "unverifiable";
}

export function acquireLock(lockPath: string, info: LockInfo): void {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeSync(fd, JSON.stringify(info, null, 2));
      } finally {
        closeSync(fd);
      }
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const existing = readLock(lockPath);
      if (!existing) continue;
      const state = classifyLock(existing);
      if (state === "alive") {
        throw new LockError("ALREADY_RUNNING", `English Lab is already running (pid ${existing.pid}, port ${existing.port})`, existing);
      }
      if (state === "unverifiable") {
        throw new LockError(
          "LOCK_UNVERIFIABLE",
          `lock held by live pid ${existing.pid} but its identity cannot be verified; not removing it`,
          existing,
        );
      }
      rmSync(lockPath, { force: true }); // verified stale: holder is gone or the PID was recycled
    }
  }
  throw new LockError("LOCK_UNVERIFIABLE", "could not acquire lock", null);
}

/** Removes the lock only if it still belongs to this instance. */
export function releaseLock(lockPath: string, instanceId: string): void {
  try {
    const cur = readLock(lockPath);
    if (cur && cur.instanceId === instanceId) rmSync(lockPath, { force: true });
  } catch {
    // leave an unreadable lock for manual inspection
  }
}
