// Runs vitest from the canonical path. On Windows a shell may start in "d:\..." while Node and the file system say "D:\...": the same
// package then loads twice and every test file fails with "Vitest failed to find the current suite". Usage: node scripts/vitest.mjs <vitest arguments>
import { realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = realpathSync.native(process.cwd());
process.chdir(root);
await import(pathToFileURL(path.join(root, "node_modules", "vitest", "vitest.mjs")).href);
