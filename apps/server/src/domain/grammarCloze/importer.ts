import { randomUUID } from "node:crypto";
import type { Db } from "../../db/open.js";
import { canonicalCards } from "../skills/cards.js";

/** The prepared (cleaned + classified) file written by `npm run cloze:prepare`. */
export interface CleanedFile {
  source: string;
  sourceSha256: string;
  cleanVersion: string;
  classifierVersion: string;
  configSha256: string;
  items: CleanedItem[];
}
export interface CleanedItem {
  sourceIndex: number;
  gappedText: string;
  solution: string;
  distractors: string[];
  filledText: string;
  sourceTopic: string;
  skillId: string | null;
  skillConfidence: "exact" | "general";
  status: "validated" | "flagged";
  flagReasons: string[];
  contentHash: string;
}
export interface ImportSummary {
  applied: boolean;
  source: string;
  added: number;
  changed: number;
  unchanged: number;
  statusChanged: number;
  retired: number;
  reactivated: number;
  activeValidated: number;
  flagged: number;
}

export class ImportError extends Error {
  readonly code = "IMPORT_INVALID";
}

const itemId = (source: string, index: number): string => `${source}:${index}`;

function validate(file: CleanedFile): void {
  const cards = canonicalCards().skills;
  const seen = new Set<number>();
  for (const it of file.items) {
    const bad = (m: string): never => { throw new ImportError(`item ${it.sourceIndex}: ${m}`); };
    if (!Number.isInteger(it.sourceIndex) || it.sourceIndex < 0 || seen.has(it.sourceIndex)) bad("bad or repeated source index");
    seen.add(it.sourceIndex);
    if ((it.gappedText.match(/___/g) ?? []).length !== 1) bad("needs exactly one gap");
    const opts = [it.solution, ...it.distractors].map((o) => o.toLowerCase());
    if (opts.length < 2 || opts.length > 4 || new Set(opts).size !== opts.length) bad("needs 2-4 different options");
    if (it.skillId !== null && !cards[it.skillId]) bad(`unknown skill ${it.skillId}`);
    if ((it.skillId === null) !== (it.skillConfidence === "general")) bad("skill and confidence disagree");
    if (it.status !== "validated" && it.status !== "flagged") bad("status must be validated or flagged");
    if ((it.status === "flagged") !== (it.flagReasons.length > 0)) bad("flag reasons and status disagree");
  }
}

interface Existing { id: string; status: string; revId: string; hash: string; skillId: string | null; conf: string; flags: string; no: number }

/**
 * Idempotent import (TASK_032 stage 2.1). Same input -> no new rows. A changed exercise gets a NEW revision; answers, exclusions and sessions are never
 * touched, a sentence missing from the new file becomes `retired` (never deleted). apply=false only reports what would change.
 */
export function importCleaned(db: Db, file: CleanedFile, o: { apply: boolean; now?: () => Date } = { apply: false }): ImportSummary {
  validate(file);
  const now = (): string => (o.now?.() ?? new Date()).toISOString();
  const run = db.transaction((): ImportSummary => {
    const source = file.source;
    const sourceRow = db.prepare("SELECT id FROM grammar_cloze_sources WHERE id = ?").get(source);
    if (!sourceRow && o.apply) db.prepare("INSERT INTO grammar_cloze_sources(id, title, created_at) VALUES (?,?,?)").run(source, source, now());
    const existing = new Map<string, Existing>();
    for (const r of db.prepare(`SELECT i.id, i.status, i.current_revision_id AS revId, r.content_hash AS hash, r.skill_id AS skillId, r.skill_confidence AS conf, r.flag_reasons_json AS flags, r.revision_no AS no
      FROM grammar_cloze_items i JOIN grammar_cloze_revisions r ON r.id = i.current_revision_id WHERE i.source_id = ?`).all(source) as Existing[]) existing.set(r.id, r);
    const summary: ImportSummary = { applied: o.apply, source, added: 0, changed: 0, unchanged: 0, statusChanged: 0, retired: 0, reactivated: 0, activeValidated: 0, flagged: 0 };
    const plan: Array<{ it: CleanedItem; ex: Existing | undefined; fresh: boolean }> = [];
    const inFile = new Set<string>();
    for (const it of file.items) {
      const id = itemId(source, it.sourceIndex);
      inFile.add(id);
      const ex = existing.get(id);
      const flags = JSON.stringify(it.flagReasons);
      const fresh = !ex || ex.hash !== it.contentHash || ex.skillId !== it.skillId || ex.conf !== it.skillConfidence || ex.flags !== flags;
      if (!ex) summary.added++;
      else if (fresh) summary.changed++;
      else summary.unchanged++;
      if (ex && ex.status === "retired") summary.reactivated++;
      else if (ex && ex.status !== it.status) summary.statusChanged++;
      plan.push({ it, ex, fresh });
    }
    const toRetire = [...existing.values()].filter((e) => !inFile.has(e.id) && e.status !== "retired");
    summary.retired = toRetire.length;
    summary.flagged = file.items.filter((i) => i.status === "flagged").length;
    summary.activeValidated = file.items.filter((i) => i.status === "validated" && !db.prepare("SELECT 1 FROM grammar_cloze_exclusions WHERE item_id = ?").get(itemId(source, i.sourceIndex))).length;
    if (o.apply) {
      const importId = randomUUID();
      const at = now();
      const ins = db.prepare("INSERT INTO grammar_cloze_imports(id, source_id, source_sha256, clean_version, classifier_version, config_sha256, summary_json, created_at) VALUES (?,?,?,?,?,?,?,?)");
      const insRev = db.prepare(`INSERT INTO grammar_cloze_revisions(id, item_id, revision_no, content_hash, gapped_text, solution, distractors_json, filled_text, source_topic, skill_id, skill_confidence, classifier_version, clean_version, flag_reasons_json, import_id, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const insItem = db.prepare("INSERT INTO grammar_cloze_items(id, source_id, source_index, current_revision_id, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)");
      const updItem = db.prepare("UPDATE grammar_cloze_items SET current_revision_id = ?, status = ?, updated_at = ? WHERE id = ?");
      // the revision row is written first (its item id is plain text, no foreign key), then the item
      const newSummary = { ...summary, applied: true };
      ins.run(importId, source, file.sourceSha256, file.cleanVersion, file.classifierVersion, file.configSha256, JSON.stringify(newSummary), at);
      for (const { it, ex, fresh } of plan) {
        const id = itemId(source, it.sourceIndex);
        let revId = ex?.revId ?? "";
        if (fresh) {
          revId = randomUUID();
          insRev.run(revId, id, (ex?.no ?? 0) + 1, it.contentHash, it.gappedText, it.solution, JSON.stringify(it.distractors), it.filledText, it.sourceTopic, it.skillId, it.skillConfidence, file.classifierVersion, file.cleanVersion, JSON.stringify(it.flagReasons), importId, at);
        }
        if (!ex) insItem.run(id, source, it.sourceIndex, revId, it.status, at, at);
        else if (fresh || ex.status !== it.status) updItem.run(revId, it.status, at, id);
      }
      for (const e of toRetire) db.prepare("UPDATE grammar_cloze_items SET status = 'retired', updated_at = ? WHERE id = ?").run(at, e.id);
    }
    return summary;
  });
  return run();
}
