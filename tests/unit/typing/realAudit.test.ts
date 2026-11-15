import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RealAudit } from "../../../apps/server/src/domain/typing/dictation/realAudit.js";

describe("real speech background audit", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  it("counts verified candidates separately and stops on missing corpus", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "dictation-audit-")); dirs.push(root);
    const base = path.join(root, "data", "dictation-real");
    const batches = path.join(base, "auto", "batches"); mkdirSync(batches, { recursive: true });
    writeFileSync(path.join(base, "reviewed.json"), JSON.stringify({ clips: [{ sentenceId: "approved" }] }));
    const pass = { "large-v3": { matches: true }, medium: { matches: true } };
    writeFileSync(path.join(batches, "batch-one.json"), JSON.stringify({ asr_checks_completed: true, clips: [
      { sentence_id: "approved", checks: pass }, { sentence_id: "waiting", checks: pass },
      { sentence_id: "different", checks: { ...pass, medium: { matches: false } } },
    ] }));
    const audit = new RealAudit(path.join(root, "missing-project"), path.join(root, "data"));
    expect(audit.status()).toMatchObject({ enabled: false, checked: 3, matched: 2 });
    writeFileSync(path.join(base, "auto", "decisions.json"), JSON.stringify({ decisions: [{ sentenceId: "waiting", verdict: "rejected" }] }));
    expect(audit.status()).toMatchObject({ matched: 2 });
    expect(audit.setEnabled(true)).toMatchObject({ enabled: true, running: false, error: "Common Voice dataset or audit script is missing." });
    expect(audit.setEnabled(false)).toMatchObject({ enabled: false, error: null });
    audit.stop();
  });
  it("reports progress and an estimated duration for an independently running worker", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "dictation-progress-")); dirs.push(root);
    const auto = path.join(root, "data", "dictation-real", "auto"); mkdirSync(auto, { recursive: true });
    writeFileSync(path.join(auto, "worker.lock"), JSON.stringify({ worker: process.pid }));
    writeFileSync(path.join(auto, "settings.json"), JSON.stringify({ enabled: true }));
    writeFileSync(path.join(auto, "pending.json"), JSON.stringify({ active_model: "large-v3", clips: [
      { checks: { "large-v3": { matches: true, seconds: 10 } } }, { checks: {} },
    ] }));
    const audit = new RealAudit(root, path.join(root, "data"));
    expect(audit.status()).toMatchObject({ running: true, batch: { total: 2, largeDone: 1, mediumDone: 0, activeModel: "large-v3", etaSeconds: 30 } });
    audit.stop();
  });
});
