// npm run slice:stop - stops the slice profile started by `npm run slice` (same data root, so the right lock file is used).
import path from "node:path";
import { projectRoot } from "./_common.mjs";

process.env.ENGLISHLAB_DATA_ROOT ??= path.join(projectRoot, "var", "slice");
await import("./stop.mjs");
