// npm run slice: seed (if needed) and start the NON-RELEASE vertical slice in its own profile (var/slice), so it never touches var/db.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { projectRoot } from "./_common.mjs";

process.env.ENGLISHLAB_DATA_ROOT ??= path.join(projectRoot, "var", "slice");
process.env.ENGLISHLAB_BANNER ??= "Non-release practice slice: 45 hand-written exercises reviewed by an AI agent. Voice and AI review are not implemented yet.";
const seed = spawnSync(process.execPath, [path.join(projectRoot, "scripts", "seed-slice.mjs")], { stdio: "inherit", env: process.env });
if (seed.status !== 0) process.exit(seed.status ?? 1);
await import("./start.mjs");
