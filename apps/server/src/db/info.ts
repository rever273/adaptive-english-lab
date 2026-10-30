import { createRequire } from "node:module";
import type { Health } from "@english-lab/contracts";
import { currentSchemaVersion } from "./migrate.js";
import type { Db } from "./open.js";

const require = createRequire(import.meta.url);
const driverVersion = (require("better-sqlite3/package.json") as { version: string }).version;

/** Actual values reported by the running driver, not assumed defaults (TASK_003). */
export function readDbInfo(db: Db): Health["db"] {
  const sqliteVersion = (db.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v;
  const jsonSupport = (db.prepare("SELECT json_valid('{\"a\":1}') AS ok").get() as { ok: number }).ok === 1;
  return {
    ready: true,
    schemaVersion: currentSchemaVersion(db),
    driver: "better-sqlite3",
    driverVersion,
    sqliteVersion,
    jsonSupport,
    pragmas: {
      journal_mode: String(db.pragma("journal_mode", { simple: true })),
      foreign_keys: Number(db.pragma("foreign_keys", { simple: true })),
      busy_timeout: Number(db.pragma("busy_timeout", { simple: true })),
      synchronous: Number(db.pragma("synchronous", { simple: true })),
    },
  };
}
