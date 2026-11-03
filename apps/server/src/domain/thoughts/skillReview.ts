import { ReviewerSchema } from "@english-lab/contracts";
import { z } from "zod";
import type { Db } from "../../db/open.js";
import { ApiError } from "../../errors.js";
import { skillCards } from "../content/batches/draftFormats.js";
import { taxonomyForNewRevisions } from "../content/repository.js";
import type { ThoughtDeps } from "./repository.js";

/**
 * TASK_026: the local model reads a thought (English + reusable patterns) but does NOT choose grammar skills: on a live run it picked a wrong
 * skill for about half of the patterns. An agent (never the model) chooses, for every pattern, the skill it genuinely exercises, or none.
 * `thought-skill-review-v1` is applied by APPENDING a new thought_analyses row (the model's reading stays in the history). All or nothing; a
 * stale analysis refuses the whole manifest; applying the same manifest twice is a no-op.
 */
export const ThoughtSkillManifestSchema = z
  .object({
    schema_version: z.literal("thought-skill-review-v1"),
    reviewer: z.string().min(1).max(200),
    review_version: z.string().min(1).max(120),
    items: z
      .array(
        z
          .object({
            analysis_id: z.string().min(1).max(64),
            constructions: z
              .array(
                z
                  .object({
                    index: z.number().int().min(0),
                    /** a skill id of the current taxonomy, or null when no skill genuinely fits this pattern */
                    skill_id: z.string().min(1).max(80).nullable(),
                    rationale: z.string().trim().min(1).max(400),
                  })
                  .strict(),
              )
              .min(1)
              .max(3),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();

interface Latest {
  id: string;
  thoughtId: string;
  status: string;
  output: string;
}

const latestOf = (db: Db, analysisId: string): { row: Latest; isLatest: boolean } | undefined => {
  const row = db.prepare("SELECT id, thought_id AS thoughtId, status, output_json AS output FROM thought_analyses WHERE id = ?").get(analysisId) as Latest | undefined;
  if (!row) return undefined;
  const last = db.prepare("SELECT id FROM thought_analyses WHERE thought_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(row.thoughtId) as { id: string };
  return { row, isLatest: last.id === row.id };
};

export interface ThoughtForSkillReview {
  analysis_id: string;
  thought_ru: string;
  english: string;
  constructions: Array<{ index: number; pattern: string; why_ru: string }>;
}

/** The thoughts waiting for a skill decision, oldest first. */
export function thoughtsForSkillReview(db: Db, limit = 100): ThoughtForSkillReview[] {
  const rows = db
    .prepare(
      `SELECT a.id AS id, t.text_ru AS text, a.output_json AS output FROM thought_analyses a JOIN personal_thoughts t ON t.id = a.thought_id
        WHERE a.status = 'needs_skills' AND a.id = (SELECT id FROM thought_analyses WHERE thought_id = a.thought_id ORDER BY created_at DESC, rowid DESC LIMIT 1)
        ORDER BY a.created_at, a.rowid LIMIT ?`,
    )
    .all(limit) as Array<{ id: string; text: string; output: string }>;
  return rows.map((r) => {
    const o = JSON.parse(r.output) as { english: string; constructions: Array<{ pattern: string; why_ru: string }> };
    return { analysis_id: r.id, thought_ru: r.text, english: o.english, constructions: o.constructions.map((c, index) => ({ index, pattern: c.pattern, why_ru: c.why_ru })) };
  });
}

/** Every active skill with the rule it tests (from the skill cards), for the reviewer's choice. */
export function skillChoices(db: Db): Array<{ skill_id: string; rule: string }> {
  const cards = skillCards();
  return [...taxonomyForNewRevisions(db).skills].sort().map((id) => ({ skill_id: id, rule: cards[id]?.rule ?? "" }));
}

export interface ThoughtSkillResult {
  reviewer: string;
  applied: number;
  alreadyApplied: number;
  withSkills: number;
  withoutSkills: number;
}

export function applyThoughtSkills(db: Db, deps: Pick<ThoughtDeps, "now" | "newId">, input: unknown): ThoughtSkillResult {
  const parsed = ThoughtSkillManifestSchema.safeParse(input);
  if (!parsed.success) throw new ApiError(400, "VALIDATION_ERROR", "Skill manifest is invalid", parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const m = parsed.data;
  const reviewer = ReviewerSchema.safeParse(m.reviewer);
  if (!reviewer.success) throw new ApiError(422, "REVIEWER_INVALID", reviewer.error.issues[0]?.message ?? "invalid reviewer");
  return db
    .transaction((): ThoughtSkillResult => {
      const skills = taxonomyForNewRevisions(db).skills;
      const problems: Array<{ analysisId: string; code: string; message: string }> = [];
      const seen = new Set<string>();
      const plan: Array<{ thoughtId: string; output: Record<string, unknown>; status: "ok" | "no_skill" }> = [];
      let already = 0;
      for (const it of m.items) {
        const add = (code: string, message: string) => problems.push({ analysisId: it.analysis_id, code, message });
        if (seen.has(it.analysis_id)) {
          add("DUPLICATE_ITEM", "the analysis appears twice in the manifest");
          continue;
        }
        seen.add(it.analysis_id);
        const found = latestOf(db, it.analysis_id);
        if (!found) {
          add("ANALYSIS_NOT_FOUND", "unknown analysis");
          continue;
        }
        const out = JSON.parse(found.row.output) as Record<string, unknown> & { constructions?: Array<Record<string, unknown>> };
        if (found.row.status !== "needs_skills" || !found.isLatest) {
          // re-apply: the very next analysis of the thought is this manifest's own result for this analysis
          const next = db.prepare("SELECT output_json AS o FROM thought_analyses WHERE thought_id = ? AND rowid > (SELECT rowid FROM thought_analyses WHERE id = ?) ORDER BY rowid LIMIT 1").get(found.row.thoughtId, it.analysis_id) as { o: string } | undefined;
          const review = next ? (JSON.parse(next.o) as { review?: { reviewer?: string; reviewVersion?: string; sourceAnalysisId?: string } }).review : undefined;
          if (review?.sourceAnalysisId === it.analysis_id && review.reviewer === m.reviewer && review.reviewVersion === m.review_version) already++;
          else add(found.row.status === "needs_skills" ? "STALE_ANALYSIS" : "NOT_WAITING", found.row.status === "needs_skills" ? "the thought has a newer analysis" : `the analysis is ${found.row.status}, not waiting for skills`);
          continue;
        }
        const list = out.constructions ?? [];
        const given = new Set(it.constructions.map((c) => c.index));
        if (given.size !== it.constructions.length || list.some((_, i) => !given.has(i)) || it.constructions.some((c) => c.index >= list.length)) {
          add("CONSTRUCTIONS_MISMATCH", `decide every pattern exactly once (indexes 0..${list.length - 1})`);
          continue;
        }
        let bad = false;
        for (const c of it.constructions) {
          if (c.skill_id !== null && !skills.has(c.skill_id)) {
            add("UNKNOWN_SKILL", `${c.skill_id} is not an active skill of the current taxonomy`);
            bad = true;
          }
        }
        if (bad) continue;
        const merged = list.map((c, i) => {
          const d = it.constructions.find((x) => x.index === i)!;
          return { ...c, skill_id: d.skill_id, skill_rationale: d.rationale };
        });
        const usable = merged.filter((c) => c.skill_id !== null);
        plan.push({
          thoughtId: found.row.thoughtId,
          output: { ...out, constructions: usable, discarded_patterns: merged.filter((c) => c.skill_id === null), review: { reviewer: m.reviewer, reviewVersion: m.review_version, sourceAnalysisId: it.analysis_id } },
          status: usable.length > 0 ? "ok" : "no_skill",
        });
      }
      if (problems.length > 0) throw new ApiError(422, "THOUGHT_SKILLS_REFUSED", "The manifest was refused as a whole; nothing was applied.", problems);
      const now = deps.now().toISOString();
      const ins = db.prepare("INSERT INTO thought_analyses(id, thought_id, status, output_json, created_at) VALUES (?,?,?,?,?)");
      for (const p of plan) ins.run(deps.newId(), p.thoughtId, p.status, JSON.stringify(p.output), now);
      return { reviewer: m.reviewer, applied: plan.length, alreadyApplied: already, withSkills: plan.filter((p) => p.status === "ok").length, withoutSkills: plan.filter((p) => p.status === "no_skill").length };
    })
    .immediate();
}
