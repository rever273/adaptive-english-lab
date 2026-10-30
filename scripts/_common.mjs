// Shared helpers for start/stop/backup. They import the compiled server modules so that
// config, lock and identity logic exist in exactly one place (run `npm run build` first).
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverDist = path.join(projectRoot, "apps", "server", "dist");

export function requireBuild({ web = true } = {}) {
  const missing = [];
  if (!existsSync(path.join(serverDist, "index.js"))) missing.push("apps/server/dist");
  if (web && !existsSync(path.join(projectRoot, "apps", "web", "dist", "index.html"))) missing.push("apps/web/dist");
  if (missing.length > 0) {
    console.error(`Build output missing (${missing.join(", ")}). Run: npm ci && npm run build`);
    process.exit(1);
  }
}

export async function loadServerModule(name) {
  return import(pathToFileURL(path.join(serverDist, name)).href);
}

export const serverEntry = path.join(serverDist, "index.js");
