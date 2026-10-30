import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, type WriteStream } from "node:fs";
import path from "node:path";

const MAX_BYTES = 10 * 1024 * 1024;
const KEEP = 5;

/** Size-based rotation at startup: server.log -> server.log.1 ... server.log.5 (10 MiB x 5, spec/11). */
export function openLogStream(logsDir: string, name = "server.log"): WriteStream {
  mkdirSync(logsDir, { recursive: true });
  const file = path.join(logsDir, name);
  if (existsSync(file) && statSync(file).size >= MAX_BYTES) {
    rmSync(`${file}.${KEEP}`, { force: true });
    for (let i = KEEP - 1; i >= 1; i--) {
      if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    }
    renameSync(file, `${file}.1`);
  }
  return createWriteStream(file, { flags: "a" });
}
