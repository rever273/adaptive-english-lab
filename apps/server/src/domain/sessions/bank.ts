import type { Candidate, Format } from "@english-lab/learning";
import type { Db } from "../../db/open.js";

export interface BankCandidate extends Candidate {
  rubricVersion: string;
  difficulty: string;
}

/**
 * Approved + released revisions of one bank role (`selectable_revisions`), with the target skill, family and the sentence
 * units they would reserve. Held-out candidates are never loaded for practice: the bank role is part of the query.
 */
export function loadCandidates(db: Db, bankRole: "practice" | "diagnostic" | "heldout", skillPool: readonly string[] = []): BankCandidate[] {
  const rows = db
    .prepare(
      `SELECT er.id AS revisionId, er.exercise_id AS exerciseId, er.type AS format, er.dimension AS dimension, er.difficulty AS difficulty,
              er.context_id AS contextId, er.template_cluster AS templateCluster, er.bank_role AS bankRole, er.rubric_version AS rubricVersion,
              er.content_json AS content, sr.skill_id AS skillId, sr.family AS family
         FROM selectable_revisions s
         JOIN exercise_revisions er ON er.id = s.revision_id
         JOIN exercise_skills es ON es.revision_id = er.id AND es.role = 'target'
         JOIN skill_revisions sr ON sr.id = es.skill_revision_id
        WHERE er.bank_role = ? AND json_type(er.content_json, '$.vocabulary') IS NULL
        ORDER BY er.id`,
    )
    .all(bankRole) as Array<{
    revisionId: string;
    exerciseId: string;
    format: Format;
    dimension: "recognition" | "correction" | "production";
    difficulty: string;
    contextId: string;
    templateCluster: string;
    bankRole: "practice" | "diagnostic" | "heldout";
    rubricVersion: string;
    content: string;
    skillId: string;
    family: string;
  }>;
  const units = new Map<string, string[]>();
  for (const u of db
    .prepare(
      `SELECT rpu.revision_id AS revisionId, u.fingerprint AS fingerprint
         FROM revision_prompt_units rpu JOIN prompt_units u ON u.id = rpu.unit_id
        WHERE rpu.revision_id IN (SELECT revision_id FROM selectable_revisions)
        ORDER BY rpu.revision_id, u.fingerprint`,
    )
    .all() as Array<{ revisionId: string; fingerprint: string }>) {
    (units.get(u.revisionId) ?? units.set(u.revisionId, []).get(u.revisionId)!).push(u.fingerprint);
  }
  const pool = new Set(skillPool);
  return rows
    .filter((r) => pool.size === 0 || pool.has(r.skillId))
    .map((r) => {
      const content = JSON.parse(r.content) as { payload: { no_mistake?: boolean; questions?: unknown[] } };
      return {
        revisionId: r.revisionId,
        exerciseId: r.exerciseId,
        format: r.format,
        dimension: r.dimension,
        skillId: r.skillId,
        family: r.family,
        contextId: r.contextId,
        templateCluster: r.templateCluster,
        bankRole: r.bankRole,
        cohort: `${r.rubricVersion}|${r.difficulty}`,
        noMistake: r.format === "detect_error" && content.payload.no_mistake === true,
        childCount: r.format === "context_reading" ? (content.payload.questions?.length ?? 0) : 1,
        unitFingerprints: units.get(r.revisionId) ?? [],
        rubricVersion: r.rubricVersion,
        difficulty: r.difficulty,
      };
    });
}

/** Every sentence that was shown (global, permanent) or is reserved by an unfinished snapshot. */
export function loadBlockedFingerprints(db: Db): Set<string> {
  const rows = db
    .prepare(
      `SELECT u.fingerprint AS f FROM exposures e JOIN prompt_units u ON u.id = e.unit_id
       UNION SELECT u.fingerprint FROM prompt_reservations r JOIN prompt_units u ON u.id = r.unit_id`,
    )
    .all() as Array<{ f: string }>;
  return new Set(rows.map((r) => r.f));
}
