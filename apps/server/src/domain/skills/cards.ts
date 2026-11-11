import { readFileSync } from "node:fs";
import path from "node:path";
import { detectProjectRoot } from "../../config.js";

/**
 * The one canonical skill-card reference (TASK_032, D140-D142): content/taxonomy/skill-cards.json.
 * skill-cards-v1.json and skill-cards-v2-extra.json stay as frozen snapshots ONLY for the generation prompt hash (draftFormats.ts).
 */
export interface CanonicalSkill {
  family: string;
  displayName: string;
  displayNameRu: string;
  since: "taxonomy-v1" | "taxonomy-v2" | "skill-cards-v3";
  inTaxonomy: boolean;
  status: "draft" | "validated";
  rule: string;
  good: string[];
  wrong: string;
}
export interface CanonicalCards {
  schema_version: "skill-cards-v3";
  skills: Record<string, CanonicalSkill>;
}

const ID = /^[a-z_]+\.[a-z_]+$/;

/** throws with a readable message on the first structural problem */
export function validateCards(data: unknown): CanonicalCards {
  const d = data as CanonicalCards;
  if (!d || d.schema_version !== "skill-cards-v3" || typeof d.skills !== "object") throw new Error("skill-cards: wrong schema_version");
  for (const [id, s] of Object.entries(d.skills)) {
    const bad = (m: string): never => { throw new Error(`skill-cards: ${id}: ${m}`); };
    if (!ID.test(id)) bad("id must look like family.specific");
    if (s.family !== id.split(".")[0]) bad("family differs from the id");
    for (const k of ["displayName", "displayNameRu", "rule", "wrong"] as const) if (typeof s[k] !== "string" || s[k].trim() === "") bad(`${k} is empty`);
    if (!Array.isArray(s.good) || s.good.length < 1 || s.good.some((g) => typeof g !== "string" || g.trim() === "")) bad("good needs at least one example");
    if (!["taxonomy-v1", "taxonomy-v2", "skill-cards-v3"].includes(s.since)) bad("bad since");
    if ((s.since === "skill-cards-v3") === s.inTaxonomy) bad("inTaxonomy must be false exactly for skill-cards-v3 skills");
    if (!["draft", "validated"].includes(s.status)) bad("bad status");
  }
  return d;
}

let cache: CanonicalCards | null = null;
export function canonicalCards(): CanonicalCards {
  return (cache ??= validateCards(JSON.parse(readFileSync(path.join(detectProjectRoot(), "content", "taxonomy", "skill-cards.json"), "utf8"))));
}
export const skillCard = (id: string): CanonicalSkill | undefined => canonicalCards().skills[id];
/** readable English name; "General Grammar" for no skill */
export const displayName = (id: string | null | undefined): string => (id ? skillCard(id)?.displayName ?? id : "General Grammar");
