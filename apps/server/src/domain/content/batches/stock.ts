import type { Db } from "../../../db/open.js";
import { loadBlockedFingerprints, loadCandidates } from "../../sessions/bank.js";
import { loadBlueprint, loadSettings } from "../../sessions/policy.js";
import { vocabularyPracticeStatus } from "../../vocabulary/practice.js";
import { difficultyLevels } from "@english-lab/contracts";
import { scaleQuotas, DEFAULT_QUOTAS } from "@english-lab/learning";

/** Read-only stock warning before exhaustion. Availability never counts drafts, used sentences or reservations. */
export function replenishmentStock(db: Db) {
  const settings = loadSettings(db).values;
  const last = db.prepare("SELECT blueprint_revision_id AS id FROM sessions WHERE purpose = 'practice' AND blueprint_revision_id IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as { id: string } | undefined;
  const policy = last ? loadBlueprint(db, last.id).policy : null;
  const pool = policy?.skillPool ?? [];
  const blocked = loadBlockedFingerprints(db);
  const candidates = loadCandidates(db, "practice", pool, difficultyLevels(settings));
  const usable = candidates.filter(c => c.unitFingerprints.length > 0 && c.unitFingerprints.every(f => !blocked.has(f)));
  const claimed = new Set<string>();
  let available = 0;
  for (const c of usable) {
    if (c.unitFingerprints.some(f => claimed.has(f))) continue;
    available++;
    c.unitFingerprints.forEach(f => claimed.add(f));
  }
  const threshold = settings.taskCount * 2;
  const quotas = scaleQuotas(policy?.quotas ?? DEFAULT_QUOTAS, settings.taskCount);
  const formatLow = Object.entries(quotas).some(([format, n]) => n > 0 && usable.filter(c => c.format === format).length < n * 2) || (policy?.readingBlocks === 1 && usable.filter(c => c.format === "context_reading").length < 2);
  const vocab = vocabularyPracticeStatus(db);
  const vocabFresh = vocab.freshAvailable;
  const grammar = { available, threshold, low: available < threshold || formatLow, scope: last ? "current lesson skills" : "all grammar skills", bySkill: [...new Set(usable.map(c => c.skillId))].map(skill => ({ skill, available: usable.filter(c => c.skillId === skill).length })) };
  const vocabulary = { available: vocabFresh, threshold: vocab.taskCount * 2, low: vocab.words > 0 && vocabFresh < vocab.taskCount * 2 };
  return { grammar, vocabulary };
}
