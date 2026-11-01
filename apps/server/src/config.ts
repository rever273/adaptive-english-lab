import { existsSync, realpathSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export class ConfigError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface AppConfig {
  /** Always loopback; never configurable (spec/11). */
  host: "127.0.0.1";
  port: number;
  /** Extra exact browser origin allowed in development (Vite), e.g. http://localhost:5173. */
  devOrigin: string | null;
  /** false = no model runner is registered (queued AI jobs simply wait): ENGLISHLAB_AI=off, used by browser tests and when the GPU must stay free */
  aiRunners?: boolean;
  appVersion: string;
  projectRoot: string;
  dataRoot: string;
  vocabularyImagesDir?: string;
  /** optional old word list (D69), a hint for the word job; never imported */
  lexiconCsv?: string;
  dbPath: string;
  backupsDir: string;
  logsDir: string;
  runDir: string;
  lockPath: string;
  migrationsDir: string;
  webDist: string;
}

const EnvSchema = z.object({
  ENGLISHLAB_PORT: z.coerce.number().int().min(1024).max(65535).default(4318),
  ENGLISHLAB_DATA_ROOT: z.string().min(1).optional(),
  /** folder of the database file only (e.g. a shared folder for databases on a fast drive); backups, logs and exports stay in the data root */
  ENGLISHLAB_DB_DIR: z.string().min(1).optional(),
  ENGLISHLAB_AI: z.enum(["on", "off"]).default("on"),
  ENGLISHLAB_DEV_ORIGIN: z
    .string()
    .regex(/^http:\/\/(localhost|127\.0\.0\.1):\d{2,5}$/, "must be http://localhost:<port> or http://127.0.0.1:<port>")
    .optional(),
});

/** apps/server/dist/config.js (or src/config.ts under vitest) -> project root. */
export function detectProjectRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..");
}

/** realpath of the nearest existing ancestor plus the not-yet-existing remainder. */
function realpathLenient(p: string): string {
  const missing: string[] = [];
  let cur = path.resolve(p);
  while (!existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    missing.unshift(path.basename(cur));
    cur = parent;
  }
  return path.join(realpathSync.native(cur), ...missing);
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent.toLowerCase(), child.toLowerCase());
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Resolve the data root. Allowed only inside the project or %LOCALAPPDATA%/EnglishLab (spec/02, spec/11).
 * Rejects UNC / device / extended paths and anything whose real path escapes the allowed roots (reparse points).
 */
export function resolveDataRoot(requested: string | undefined, projectRoot: string, localAppData = process.env.LOCALAPPDATA): string {
  const defaultRoot = path.join(projectRoot, "var");
  if (!requested) return realpathLenient(defaultRoot);
  if (/^[\\/]{2}/.test(requested)) {
    throw new ConfigError("DATA_ROOT_FORBIDDEN", "UNC, network, device and extended-length paths are not allowed for the data root");
  }
  if (!path.isAbsolute(requested)) {
    throw new ConfigError("DATA_ROOT_FORBIDDEN", "data root must be an absolute path");
  }
  if (requested.split(/[\\/]/).includes("..")) {
    throw new ConfigError("DATA_ROOT_FORBIDDEN", "data root must not contain '..' segments");
  }
  const real = realpathLenient(requested);
  const allowed = [realpathLenient(projectRoot)];
  if (localAppData) allowed.push(realpathLenient(path.join(localAppData, "EnglishLab")));
  if (!allowed.some((a) => isInside(real, a))) {
    throw new ConfigError("DATA_ROOT_FORBIDDEN", "data root must be inside the project directory or %LOCALAPPDATA%\\EnglishLab");
  }
  return real;
}

/** Git-ignored per-machine settings in the project root (D62), e.g. { "dbDir": "C:\\Databases\\EnglishLab" }. */
export function readLocalSettings(projectRoot: string): { dbDir?: string; vocabularyImagesDir?: string; lexiconCsv?: string } {
  const file = path.join(projectRoot, "englishlab.local.json");
  if (!existsSync(file)) return {};
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as { dbDir?: unknown; vocabularyImagesDir?: unknown; lexiconCsv?: unknown };
    return { ...(typeof v.dbDir === "string" && v.dbDir.length > 0 ? { dbDir: v.dbDir } : {}), ...(typeof v.vocabularyImagesDir === "string" && v.vocabularyImagesDir.length > 0 ? { vocabularyImagesDir: v.vocabularyImagesDir } : {}), ...(typeof v.lexiconCsv === "string" && v.lexiconCsv.length > 0 ? { lexiconCsv: v.lexiconCsv } : {}) };
  } catch {
    throw new ConfigError("CONFIG_INVALID", "englishlab.local.json is not valid JSON");
  }
}

/** The database folder must be a plain absolute local path (no UNC/device paths, no '..'). */
export function resolveDbDir(requested: string): string {
  if (/^[\\/]{2}/.test(requested) || !path.isAbsolute(requested) || requested.split(/[\\/]/).includes("..")) {
    throw new ConfigError("DB_DIR_FORBIDDEN", "the database folder must be an absolute local path without '..' (no network or device paths)");
  }
  return realpathLenient(requested);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, projectRoot = detectProjectRoot(), local?: { dbDir?: string; vocabularyImagesDir?: string; lexiconCsv?: string }): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError("CONFIG_INVALID", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  const root = realpathLenient(projectRoot);
  const dataRoot = resolveDataRoot(parsed.data.ENGLISHLAB_DATA_ROOT, root, env.LOCALAPPDATA ?? "");
  // the per-machine database folder applies to the regular profile only: a profile with its own data root (tests, slice) keeps its database inside it
  const dbDirSetting = parsed.data.ENGLISHLAB_DB_DIR ?? (parsed.data.ENGLISHLAB_DATA_ROOT ? undefined : (local ?? readLocalSettings(root)).dbDir);
  const dbDir = dbDirSetting ? resolveDbDir(dbDirSetting) : path.join(dataRoot, "db");
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string };
  return {
    host: "127.0.0.1",
    port: parsed.data.ENGLISHLAB_PORT,
    devOrigin: parsed.data.ENGLISHLAB_DEV_ORIGIN ?? null,
    aiRunners: parsed.data.ENGLISHLAB_AI === "on",
    appVersion: pkg.version,
    projectRoot: root,
    dataRoot,
    vocabularyImagesDir: (local ?? readLocalSettings(root)).vocabularyImagesDir,
    lexiconCsv: (local ?? readLocalSettings(root)).lexiconCsv,
    dbPath: path.join(dbDir, "english-lab.sqlite"),
    backupsDir: path.join(dataRoot, "backups"),
    logsDir: path.join(dataRoot, "logs"),
    runDir: path.join(dataRoot, "run"),
    lockPath: path.join(dataRoot, "run", "server.lock.json"),
    migrationsDir: path.join(root, "migrations"),
    webDist: path.join(root, "apps", "web", "dist"),
  };
}
