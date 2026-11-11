import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../../apps/server/src/db/migrate.js";
import { openDatabase, type Db } from "../../../apps/server/src/db/open.js";
import { importCleaned, ImportError, type CleanedFile, type CleanedItem } from "../../../apps/server/src/domain/grammarCloze/importer.js";
import { makeScratchRoot, projectRoot } from "../helpers.js";

const item = (i: number, o: Partial<CleanedItem> = {}): CleanedItem => ({
  sourceIndex: i, gappedText: `She ___ to school number ${i}.`, solution: "goes", distractors: ["go", "going"], filledText: `She goes to school number ${i}.`,
  sourceTopic: "present_simple", skillId: "agreement.third_person", skillConfidence: "exact", status: "validated", flagReasons: [], contentHash: `h${i}`, ...o,
});
const file = (items: CleanedItem[]): CleanedFile => ({ source: "zanichelli", sourceSha256: "s", cleanVersion: "c1", classifierVersion: "k1", configSha256: "x", items });
const count = (db: Db, t: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;

describe("grammar cloze import", () => {
  const scratch = makeScratchRoot();
  let db: Db;
  beforeAll(async () => {
    db = openDatabase(path.join(scratch.root, "db", "test.sqlite"));
    await runMigrations(db, { migrationsDir: path.join(projectRoot, "migrations"), appVersion: "test" });
  });
  afterAll(() => { db.close(); scratch.cleanup(); });

  it("a dry run changes nothing and reports the plan", () => {
    const s = importCleaned(db, file([item(1), item(2), item(3, { status: "flagged", flagReasons: ["modal_synonyms"] })]), { apply: false });
    expect(s).toMatchObject({ applied: false, added: 3, activeValidated: 2, flagged: 1 });
    expect(count(db, "grammar_cloze_items")).toBe(0);
    expect(count(db, "grammar_cloze_imports")).toBe(0);
  });

  it("imports once and a second run adds nothing", () => {
    const f = file([item(1), item(2), item(3, { status: "flagged", flagReasons: ["modal_synonyms"] })]);
    expect(importCleaned(db, f, { apply: true })).toMatchObject({ added: 3, changed: 0, unchanged: 0, activeValidated: 2 });
    expect(count(db, "grammar_cloze_items")).toBe(3);
    expect(count(db, "grammar_cloze_revisions")).toBe(3);
    const again = importCleaned(db, f, { apply: true });
    expect(again).toMatchObject({ added: 0, changed: 0, unchanged: 3, retired: 0 });
    expect(count(db, "grammar_cloze_items")).toBe(3);
    expect(count(db, "grammar_cloze_revisions")).toBe(3);
    expect(count(db, "grammar_cloze_imports")).toBe(2);
  });

  it("a changed exercise gets a new revision; answers, exclusions and sessions stay", () => {
    const rev1 = (db.prepare("SELECT current_revision_id AS r FROM grammar_cloze_items WHERE id='zanichelli:1'").get() as { r: string }).r;
    db.prepare("INSERT INTO grammar_cloze_sessions(id, level_no, stage, planned_count, status, algorithm_version, seed, settings_revision, tab_id, started_at) VALUES ('s1',1,1,2,'active','cloze-select-v1',1,1,'t','2026-11-08T00:00:00Z')").run();
    db.prepare("INSERT INTO grammar_cloze_session_items(session_id, position, item_id, revision_id, stage, rule_key, options_json) VALUES ('s1',1,'zanichelli:1',?,1,'agreement.third_person','[\"goes\",\"go\"]')").run(rev1);
    db.prepare("INSERT INTO grammar_cloze_attempts(id, session_id, position, item_id, revision_id, stage, chosen_text, correct_text, is_correct, rule_key, source_topic, answered_at) VALUES ('a1','s1',1,'zanichelli:1',?,1,'go','goes',0,'agreement.third_person','present_simple','2026-11-08T00:00:01Z')").run(rev1);
    db.prepare("INSERT INTO grammar_cloze_exclusions(item_id, revision_id, stage, answered_before, created_at) VALUES ('zanichelli:2',(SELECT current_revision_id FROM grammar_cloze_items WHERE id='zanichelli:2'),1,0,'2026-11-08T00:00:02Z')").run();
    const changed = file([item(1, { gappedText: "She ___ to school number 1 every day.", filledText: "She goes to school number 1 every day.", contentHash: "h1b" }), item(2), item(3, { status: "validated", flagReasons: [] })]);
    const s = importCleaned(db, changed, { apply: true });
    expect(s).toMatchObject({ added: 0, changed: 2, unchanged: 1, statusChanged: 1, activeValidated: 2 }); // item 2 is excluded by the learner
    expect(count(db, "grammar_cloze_revisions")).toBe(5);
    const row = db.prepare("SELECT r.revision_no AS no FROM grammar_cloze_items i JOIN grammar_cloze_revisions r ON r.id=i.current_revision_id WHERE i.id='zanichelli:1'").get() as { no: number };
    expect(row.no).toBe(2);
    expect(count(db, "grammar_cloze_attempts")).toBe(1);
    expect((db.prepare("SELECT revision_id AS r FROM grammar_cloze_attempts").get() as { r: string }).r).toBe(rev1); // the answer keeps the text it was given for
    expect(count(db, "grammar_cloze_exclusions")).toBe(1);
  });

  it("a sentence missing from a new file is retired, not deleted, and comes back when it returns", () => {
    const s = importCleaned(db, file([item(1, { gappedText: "She ___ to school number 1 every day.", filledText: "She goes to school number 1 every day.", contentHash: "h1b" })]), { apply: true });
    expect(s.retired).toBe(2);
    expect(db.prepare("SELECT status FROM grammar_cloze_items WHERE id='zanichelli:3'").get()).toEqual({ status: "retired" });
    expect(count(db, "grammar_cloze_items")).toBe(3);
    const back = importCleaned(db, file([item(1, { gappedText: "She ___ to school number 1 every day.", filledText: "She goes to school number 1 every day.", contentHash: "h1b" }), item(3)]), { apply: true });
    expect(back.reactivated).toBe(1);
    expect(db.prepare("SELECT status FROM grammar_cloze_items WHERE id='zanichelli:3'").get()).toEqual({ status: "validated" });
  });

  it("refuses an unknown skill, a missing gap and repeated options, and writes nothing", () => {
    const n = count(db, "grammar_cloze_imports");
    expect(() => importCleaned(db, file([item(50, { skillId: "nope.nothing" })]), { apply: true })).toThrow(ImportError);
    expect(() => importCleaned(db, file([item(51, { gappedText: "no gap" })]), { apply: true })).toThrow(/gap/);
    expect(() => importCleaned(db, file([item(52, { distractors: ["GOES"] })]), { apply: true })).toThrow(/options/);
    expect(count(db, "grammar_cloze_imports")).toBe(n);
  });

  it("keeps sources apart", () => {
    const other: CleanedFile = { ...file([item(1)]), source: "sc-ques" };
    importCleaned(db, other, { apply: true });
    expect(db.prepare("SELECT id FROM grammar_cloze_items WHERE source_id='sc-ques'").all()).toEqual([{ id: "sc-ques:1" }]);
    expect(db.prepare("SELECT status FROM grammar_cloze_items WHERE id='zanichelli:1'").get()).toEqual({ status: "validated" });
  });
});
