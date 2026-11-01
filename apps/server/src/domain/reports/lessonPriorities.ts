import type { Db } from "../../db/open.js";
import { currentWatermark, loadDiagnosticOutcomes, loadEvidence, type Cohort } from "../analytics/evidence.js";
import { loadCandidates } from "../sessions/bank.js";
import { loadPriorities } from "../sessions/priorities.js";

/** Read-only planning evidence. Cohorts remain separate; no answer text is exported. */
export function exportLessonPriorities(db: Db, asOf = new Date().toISOString(), lessonCount = 5): { json: object; markdown: string } {
  if (!Number.isInteger(lessonCount) || lessonCount < 1 || lessonCount > 100) throw new Error("lesson count must be between 1 and 100");
  return db.transaction(() => {
    const taxonomy = db.prepare("SELECT id, version FROM taxonomy_versions ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as { id: string; version: string };
    const watermark = currentWatermark(db);
    const candidates = loadCandidates(db, "practice");
    const historicCohorts = db.prepare(`SELECT DISTINCT t.criterion_version AS criterionVersion, er.difficulty AS difficulty
      FROM attempts t JOIN session_slots ss ON ss.id = t.slot_id JOIN sessions s ON s.id = ss.session_id
      JOIN exercise_revisions er ON er.id = ss.exercise_revision_id
      WHERE s.purpose IN ('practice', 'heldout') AND t.submitted_at <= ?`).all(asOf) as Array<{ criterionVersion: string; difficulty: Cohort["difficulty"] }>;
    const priorities = loadPriorities(db, candidates, asOf, taxonomy.id, historicCohorts);
    const diagnostic = loadDiagnosticOutcomes(db, { watermark, asOf, taxonomyId: taxonomy.id });
    const skills = db.prepare("SELECT skill_id AS id, label_en AS label FROM skill_revisions WHERE taxonomy_id = ? AND active = 1 AND domain = 'grammar' ORDER BY skill_id").all(taxonomy.id) as Array<{ id: string; label: string }>;
    const cohorts = new Map<string, Cohort>();
    for (const c of candidates) cohorts.set(`${c.rubricVersion}|${c.difficulty}`, { criterionVersion: c.rubricVersion, difficulty: c.difficulty as Cohort["difficulty"] });
    for (const c of historicCohorts) cohorts.set(`${c.criterionVersion}|${c.difficulty}`, c);
    const evidence = [...cohorts.entries()].flatMap(([cohort, value]) => loadEvidence(db, { watermark, asOf, taxonomyId: taxonomy.id, cohort: value }).map((e) => ({ ...e, cohort })));
    const rows = skills.map((skill) => {
      const relevant = evidence.filter((e) => e.skillId === skill.id);
      const groups = new Map<string, { cohort: string; dimension: string; attempts: number; failures: number; priority: number }>();
      for (const e of relevant) {
        const key = `${e.cohort}|${e.dimension}`;
        const g = groups.get(key) ?? { cohort: e.cohort, dimension: e.dimension, attempts: 0, failures: 0, priority: priorities.lookup(skill.id, e.dimension, e.cohort) };
        g.attempts++; if (!e.success) g.failures++; groups.set(key, g);
      }
      const series = [...groups.values()].sort((a, b) => b.priority - a.priority || a.cohort.localeCompare(b.cohort) || a.dimension.localeCompare(b.dimension));
      const diag = diagnostic.get(skill.id) ?? { attempts: 0, failures: 0 };
      return { ...skill, confirmedAttempts: relevant.length, diagnostic: diag, series, priority: series[0]?.priority ?? null, uncertainty: relevant.length < 5 ? "insufficient_evidence" : "limited_evidence" };
    }).sort((a, b) => (b.priority ?? -1) - (a.priority ?? -1)
      || (b.diagnostic.attempts ? b.diagnostic.failures / b.diagnostic.attempts : -1) - (a.diagnostic.attempts ? a.diagnostic.failures / a.diagnostic.attempts : -1)
      || a.id.localeCompare(b.id));
    const practiced = rows.filter((r) => r.confirmedAttempts > 0 || r.diagnostic.attempts > 0).map((r) => r.id);
    const novel = rows.filter((r) => r.confirmedAttempts === 0 && r.diagnostic.attempts === 0).map((r) => r.id).sort();
    const targetNovel = Math.round(lessonCount * 5 * 0.35);
    let nextNovel = 0, nextPracticed = 0, novelUsed = 0;
    const lessons = Array.from({ length: lessonCount }, (_, lessonIndex) => {
      const selected: string[] = [];
      for (let slot = 0; slot < 5; slot++) {
        const position = lessonIndex * 5 + slot;
        const preferNovel = novelUsed < Math.round((position + 1) * targetNovel / (lessonCount * 5));
        const pick = (pool: string[], offset: number) => {
          for (let j = 0; j < pool.length; j++) { const id = pool[(offset + j) % pool.length]!; if (!selected.includes(id)) return { id, next: offset + j + 1 }; }
          return null;
        };
        const first = pick(preferNovel ? novel : practiced, preferNovel ? nextNovel : nextPracticed);
        const chosenNovel = first ? preferNovel : !preferNovel;
        const chosen = first ?? pick(chosenNovel ? novel : practiced, chosenNovel ? nextNovel : nextPracticed);
        if (!chosen) break;
        selected.push(chosen.id);
        if (chosenNovel) { nextNovel = chosen.next; novelUsed++; } else nextPracticed = chosen.next;
      }
      return selected;
    });
    const json = { schema_version: "lesson-priorities-v1", asOf, taxonomy: taxonomy.version, watermark, priorityAlgorithm: "mastery-v1 selection priority", note: "Confirmed independent evidence only; series are separated by criterion, difficulty and dimension. Missing data is not mastery. Provisional model decisions are excluded. Historical practice cohorts are included even when no matching exercise remains selectable; diagnostic evidence is separate.", selection: { practiced, novel, targetNovel, novelUsed, lessons, rule: "35% of slots rounded to nearest; ordered lists cycled deterministically without duplicates within a lesson; fallback to the other list when needed." }, skills: rows };
    return { json, markdown: `# Lesson priorities\n\nConfirmed independent evidence only; cohorts remain separate. Insufficient evidence does not mean mastery.\n\n\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\`` };
  }).deferred();
}
