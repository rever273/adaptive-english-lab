import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBatch } from "../../../apps/server/src/domain/content/batches/repository.js";
import { importReviewManifest } from "../../../apps/server/src/domain/content/batches/reviewImport.js";
import { projectRoot } from "../helpers.js";
import { batchJobsSettled, batchRevisions, closeRigs, drive, makeRig, manifest } from "./fixtures.js";

afterEach(closeRigs);

const node = (args: string[]) => spawnSync(process.execPath, args, { cwd: projectRoot, encoding: "utf8" });

describe("lab:export and content:validate (read-only CLIs; need `npm run build`)", () => {
  it("export writes bounded Markdown + JSON for a batch, validate passes on a consistent batch and fails on bad usage", async () => {
    const r = await makeRig();
    const { batchId } = createBatch(r.env.db, r.deps, { count: 24, mode: "balanced", trial: true });
    await drive(r, () => batchJobsSettled(r, batchId));
    const revs = batchRevisions(r, batchId);
    importReviewManifest(r.env.db, r.deps, batchId, manifest(revs.slice(0, 5).map((rev) => ({ rev, verdict: "approved" as const }))));
    r.env.db.pragma("wal_checkpoint(TRUNCATE)");
    const dbFile = path.join(r.env.scratch.root, "db", "t.sqlite");
    const out = path.join(r.env.scratch.root, "exports");

    const ex = node(["scripts/lab-export.mjs", "batch", batchId, "--db", dbFile, "--out", out]);
    expect(ex.status, ex.stderr).toBe(0);
    const json = JSON.parse(readFileSync(path.join(out, `batch-${batchId}.json`), "utf8")) as { items: unknown[]; reviewManifestTemplate: { items: unknown[] }; releaseCandidate: { revisionIds: string[] } };
    expect(json.items).toHaveLength(24);
    expect(json.reviewManifestTemplate.items).toHaveLength(19);
    expect(json.releaseCandidate.revisionIds).toHaveLength(5);
    expect(existsSync(path.join(out, `batch-${batchId}.md`))).toBe(true);

    const cov = node(["scripts/lab-export.mjs", "coverage", "--db", dbFile, "--out", out]);
    expect(cov.status, cov.stderr).toBe(0);
    expect(existsSync(path.join(out, "coverage.md"))).toBe(true);

    const ok = node(["scripts/content-validate.mjs", "--batch", batchId, "--db", dbFile]);
    expect(ok.status, ok.stderr + ok.stdout).toBe(0);
    expect(ok.stdout).toContain("OK:");
    expect(ok.stdout).toContain("approved=5");

    expect(node(["scripts/content-validate.mjs", "--batch", "nope"]).status).toBe(2);
    expect(node(["scripts/lab-export.mjs", "batch", "nope"]).status).toBe(2);
    expect(node(["scripts/content-validate.mjs", "--batch", "00000000-0000-4000-8000-000000000000", "--db", dbFile]).status).toBe(1);
  });
});
