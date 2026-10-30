import { REVIEW_CHECKLIST_KEYS } from "@english-lab/contracts";
import type { Db } from "../../../db/open.js";
import { planRelease } from "../repository.js";
import { coverage, getBatch } from "./repository.js";

/**
 * Read-only export of a batch for an external reviewer (spec/06 `lab:export batch <UUID>`). One read transaction; no writes.
 * The manifest template lists every item that still awaits a decision with the hash the reviewer must echo back.
 */
export function exportBatch(db: Db, batchId: string): { json: object; markdown: string } {
  return db
    .transaction(() => {
      const batch = getBatch(db, batchId, true);
      const items = (batch.items ?? []).map((i) => {
        const content = i.revisionId ? (db.prepare("SELECT content_json AS c FROM exercise_revisions WHERE id = ?").get(i.revisionId) as { c: string }).c : null;
        const state = i.revisionId ? (db.prepare("SELECT status FROM latest_content_state WHERE revision_id = ?").get(i.revisionId) as { status: string }).status : null;
        const reviews = i.revisionId ? (db.prepare("SELECT reviewer, review_version, verdict, content_hash FROM content_reviews WHERE revision_id = ? ORDER BY rowid").all(i.revisionId) as unknown[]) : [];
        const advisory = i.revisionId ? (db.prepare("SELECT source, scores_json, flags_json FROM advisory_signals WHERE revision_id = ? ORDER BY rowid DESC LIMIT 1").get(i.revisionId) as { source: string; scores_json: string; flags_json: string } | undefined) : undefined;
        return { ordinal: i.ordinal, advisoryHints: advisory ? { note: "advice from a small model, not a verdict; check the sentence yourself", source: advisory.source, flags: JSON.parse(advisory.flags_json), sentences: JSON.parse(advisory.scores_json) } : null, status: i.status, contentStatus: state, revisionId: i.revisionId, contentHash: i.contentHash, plan: i.plan, error: i.error, content: content ? JSON.parse(content) : null, reviews };
      });
      const approved = items.filter((i) => i.revisionId && i.contentStatus === "approved").map((i) => i.revisionId!);
      let releaseCandidate: { manifestHash: string; revisionIds: string[] } | { error: string } | null = null;
      if (approved.length > 0) {
        try {
          releaseCandidate = { manifestHash: planRelease(db, approved).manifestHash, revisionIds: approved };
        } catch (e) {
          releaseCandidate = { error: (e as Error).message };
        }
      }
      const awaiting = items.filter((i) => i.contentStatus === "pending_review" || i.contentStatus === "flagged");
      const template = {
        schema_version: "content-review-v1",
        reviewer: "agent:<name>@<version> | human:<name>",
        review_version: "<review pass id>",
        items: awaiting.map((i) => ({
          revision_id: i.revisionId,
          content_hash: i.contentHash,
          verdict: "approved | flagged | rejected",
          checklist: Object.fromEntries(REVIEW_CHECKLIST_KEYS.map((k) => [k, "true | false | n/a (only distractors_valid, no_mistake_case_correct)"])),
          reason: "",
        })),
      };
      const json = { schema_version: "batch-export-v1", exportedAt: new Date().toISOString(), batch: { ...batch, items: undefined }, items, reviewManifestTemplate: template, releaseCandidate };
      const md = [
        `# Batch ${batch.id}`,
        `purpose: ${batch.purpose} / mode: ${batch.mode} / prompt: ${batch.promptVersion} / requested ${batch.requestedCount}`,
        `counts: ${Object.entries(batch.counts).map(([k, v]) => `${k}=${v}`).join(", ")}`,
        "",
        "Review EVERY item individually against documentation/spec/05_EXERCISE_FORMAT.md (checklist). Return a content-review-v1 manifest; do not modify the database.",
        "",
        ...items.flatMap((i) => [`## #${i.ordinal} ${i.plan.type} / ${i.plan.target_skill} / ${i.status}`, i.revisionId ? `revision ${i.revisionId} hash ${i.contentHash}` : `no draft: ${JSON.stringify(i.error)}`, ...(i.advisoryHints && (i.advisoryHints.flags as unknown[]).length > 0 ? [`HINTS (small-model advice, verify yourself): ${(i.advisoryHints.flags as Array<{ code: string; text: string; score: number }>).map((f) => `${f.code} "${f.text}" (${f.score})`).join("; ")}`] : []), ...(i.content ? ["```json", JSON.stringify(i.content, null, 1), "```"] : []), ""]),
      ].join("\n");
      return { json, markdown: md };
    })
    .deferred();
}

export function exportCoverage(db: Db): { json: object; markdown: string } {
  const c = coverage(db);
  const md = [
    "# Coverage",
    `target released per skill: ${c.targetPerSkill}; skills with a deficit: ${c.totals.skillsWithDeficit}/${c.totals.skills}; released exercises: ${c.totals.releasedExercises}`,
    "",
    "| skill | released | approved (unreleased) | in review | draft | flagged | rejected | deficit |",
    "|---|---|---|---|---|---|---|---|",
    ...c.skills.map((s) => `| ${s.skill} | ${s.released} | ${s.approvedUnreleased} | ${s.inReview} | ${s.draft} | ${s.flagged} | ${s.rejected} | ${s.deficit} |`),
  ].join("\n");
  return { json: { schema_version: "coverage-export-v1", exportedAt: new Date().toISOString(), coverage: c }, markdown: md };
}
