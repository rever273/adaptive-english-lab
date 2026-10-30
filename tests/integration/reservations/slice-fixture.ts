import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { openDatabase, type Db } from "../../../apps/server/src/db/open.js";
import type { SessionDeps } from "../../../apps/server/src/domain/sessions/policy.js";
import { ClosedFormAssessor } from "../../../apps/server/src/domain/content/grader.js";
import { NullOutbox, type AttemptDeps } from "../../../apps/server/src/domain/attempts/ports.js";
import { makeScratchRoot, projectRoot } from "../helpers.js";

/** One template profile per test file: the real `scripts/seed-slice.mjs` run once (also exercises the script), then file copies. */
let template: { root: string; cleanup: () => void; dbFile: string } | null = null;

export function buildSliceTemplate(): string {
  if (template) return template.dbFile;
  const scratch = makeScratchRoot();
  const r = spawnSync(process.execPath, [path.join(projectRoot, "scripts", "seed-slice.mjs")], { env: { ...process.env, ENGLISHLAB_DATA_ROOT: scratch.root }, encoding: "utf8", timeout: 120_000 });
  if (r.status !== 0) throw new Error(`seed-slice failed: ${r.stdout}\n${r.stderr}`);
  template = { ...scratch, dbFile: path.join(scratch.root, "db", "english-lab.sqlite") };
  return template.dbFile;
}

export function disposeSliceTemplate(): void {
  template?.cleanup();
  template = null;
}

export interface SliceEnv {
  db: Db;
  deps: SessionDeps & AttemptDeps;
  clock: { current: Date };
  blueprintRevisionId: string;
  root: string;
  cleanup: () => void;
}

/** A private, writable copy of the seeded slice profile with a controllable clock. */
export function openSliceCopy(): SliceEnv {
  const src = buildSliceTemplate();
  const scratch = makeScratchRoot();
  mkdirSync(path.join(scratch.root, "db"), { recursive: true });
  copyFileSync(src, path.join(scratch.root, "db", "english-lab.sqlite"));
  const db = openDatabase(path.join(scratch.root, "db", "english-lab.sqlite"));
  const clock = { current: new Date("2026-10-28T01:00:00.000Z") };
  const deps: SessionDeps & AttemptDeps = { assessor: ClosedFormAssessor, outbox: NullOutbox, now: () => new Date(clock.current), newId: randomUUID };
  const blueprintRevisionId = (db.prepare("SELECT id FROM blueprint_revisions ORDER BY revision DESC LIMIT 1").get() as { id: string }).id;
  return {
    db,
    deps,
    clock,
    blueprintRevisionId,
    root: scratch.root,
    cleanup: () => {
      db.close();
      scratch.cleanup();
    },
  };
}

export const advanceClock = (env: Pick<SliceEnv, "clock">, ms: number): void => {
  env.clock.current = new Date(env.clock.current.getTime() + ms);
};
