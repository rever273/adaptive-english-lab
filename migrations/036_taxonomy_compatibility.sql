-- Additive taxonomy versions explicitly declare which earlier skill revisions have unchanged meaning.
CREATE TABLE taxonomy_skill_compatibility (
  target_taxonomy_id TEXT NOT NULL REFERENCES taxonomy_versions(id),
  source_skill_revision_id TEXT NOT NULL REFERENCES skill_revisions(id),
  PRIMARY KEY (target_taxonomy_id, source_skill_revision_id)
);
INSERT INTO taxonomy_skill_compatibility SELECT taxonomy_id, id FROM skill_revisions;
INSERT INTO taxonomy_versions(id,version,created_at,manifest_hash) VALUES (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))), 'taxonomy-v2', strftime('%Y-%m-%dT%H:%M:%fZ','now'), '49437dbebbeda55ee7402ccce49b9f56f6cbaf845c52034db3ccfcc1f8ec40eb');
INSERT INTO skills(id,created_at) VALUES ('verb_forms.resultant_states',strftime('%Y-%m-%dT%H:%M:%fZ','now')),('subjunctive.present_wishes',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
INSERT INTO skill_revisions(id,skill_id,taxonomy_id,parent_skill_id,label_en,domain,family,active)
 SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))), skill_id, (SELECT id FROM taxonomy_versions WHERE version='taxonomy-v2'), parent_skill_id,label_en,domain,family,active FROM skill_revisions WHERE taxonomy_id=(SELECT id FROM taxonomy_versions WHERE version='taxonomy-v1');
INSERT INTO skill_revisions(id,skill_id,taxonomy_id,label_en,domain,family,active) VALUES
 (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))),'verb_forms.resultant_states',(SELECT id FROM taxonomy_versions WHERE version='taxonomy-v2'),'Resultant states: be gone / finished','grammar','verb_forms',1),
 (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))),'subjunctive.present_wishes',(SELECT id FROM taxonomy_versions WHERE version='taxonomy-v2'),'Wishes about the present','grammar','subjunctive',1);
INSERT INTO taxonomy_skill_compatibility
 SELECT (SELECT id FROM taxonomy_versions WHERE version='taxonomy-v2'), id FROM skill_revisions WHERE taxonomy_id IN (SELECT id FROM taxonomy_versions WHERE version IN ('taxonomy-v1','taxonomy-v2'));
