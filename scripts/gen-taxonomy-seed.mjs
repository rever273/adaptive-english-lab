// Regenerates the taxonomy seed section of migrations/001_foundation.sql from
// content/taxonomy/taxonomy-v1.json. The migration is checksummed, so run this only
// BEFORE the migration has been applied anywhere; later taxonomy changes need a new migration.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const taxPath = path.join(root, "content/taxonomy/taxonomy-v1.json");
const sqlPath = path.join(root, "migrations/001_foundation.sql");
const bytes = readFileSync(taxPath);
const tax = JSON.parse(bytes.toString("utf8"));
const hash = createHash("sha256").update(bytes).digest("hex");
const q = (s) => `'${String(s).replaceAll("'", "''")}'`;
const uuid =
  "lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6)))";
const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const label = (s) => s.specific.replaceAll("_", " ");

const lines = [];
lines.push(
  `INSERT INTO taxonomy_versions(id, version, created_at, manifest_hash) VALUES (${uuid}, ${q(tax.schema_version)}, ${now}, ${q(hash)});`,
);
for (const s of tax.skills) lines.push(`INSERT INTO skills(id, created_at) VALUES (${q(s.id)}, ${now});`);
for (const s of tax.skills) {
  lines.push(
    `INSERT INTO skill_revisions(id, skill_id, taxonomy_id, parent_skill_id, label_en, domain, family, active) VALUES (${uuid}, ${q(s.id)}, (SELECT id FROM taxonomy_versions WHERE version = ${q(tax.schema_version)}), NULL, ${q(label(s))}, ${q(s.domain)}, ${q(s.family)}, 1);`,
  );
}
const begin = "-- BEGIN GENERATED TAXONOMY SEED";
const end = "-- END GENERATED TAXONOMY SEED";
const sql = readFileSync(sqlPath, "utf8");
const i = sql.indexOf(begin);
const j = sql.indexOf(end);
if (i < 0 || j < 0) throw new Error("seed markers not found");
writeFileSync(
  sqlPath,
  sql.slice(0, i + begin.length) +
    `\n-- source: content/taxonomy/taxonomy-v1.json sha256=${hash} skills=${tax.skills.length}\n` +
    lines.join("\n") +
    "\n" +
    sql.slice(j),
);
console.log(`seeded ${tax.skills.length} skills, manifest sha256=${hash}`);
