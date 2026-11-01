import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { courseLessons } from "../../../apps/server/src/domain/sessions/course.js";
import { createPracticeSession } from "../../../apps/server/src/domain/sessions/create.js";
import { makeEnv } from "../attempts/fixtures.js";

it("orders mixed keys numerically and opens the next lesson from completed history", async () => {
  const env = await makeEnv();
  try {
    const ids = ["pack-test-l11", "first10-l02", "first10-l01"].map((key) => {
      const id = randomUUID(), revision = randomUUID();
      env.db.prepare("INSERT INTO blueprints(id, stable_key) VALUES (?,?)").run(id, key);
      env.db.prepare("INSERT INTO blueprint_revisions(id, blueprint_id, revision, policy_json, status, created_at) VALUES (?,?,1,?,'published',?)").run(revision, id, JSON.stringify({ schema_version: "blueprint-policy-v1", title: key }), env.clock.current.toISOString());
      return revision;
    });
    expect(courseLessons(env.db).map((x) => [x.key, x.unlocked])).toEqual([["first10-l01", true], ["first10-l02", false], ["pack-test-l11", false]]);
    expect(() => createPracticeSession(env.db, env.deps, { purpose: "practice", blueprintRevisionId: ids[1]!, timezone: "Australia/Brisbane" })).toThrow(/previous lesson/);
    env.db.prepare("INSERT INTO sessions(id, blueprint_revision_id, purpose, settings_revision_id, plan_id, selection_version, random_seed, status, created_at, timezone) VALUES (?,?, 'practice', ?, ?, 'test', 'seed', 'completed', ?, 'Australia/Brisbane')").run(randomUUID(), ids[2], env.settingsId, env.planId, env.clock.current.toISOString());
    expect(courseLessons(env.db).map((x) => [x.completed, x.unlocked])).toEqual([[1, true], [0, true], [0, false]]);
    const first = env.db.prepare("SELECT blueprint_id AS id, policy_json AS policy FROM blueprint_revisions WHERE id = ?").get(ids[2]) as { id: string; policy: string };
    const latest = randomUUID();
    env.db.prepare("INSERT INTO blueprint_revisions(id, blueprint_id, revision, policy_json, status, created_at) VALUES (?,?,2,?,'published',?)").run(latest, first.id, first.policy, env.clock.current.toISOString());
    env.db.prepare("INSERT INTO sessions(id, blueprint_revision_id, purpose, settings_revision_id, plan_id, selection_version, random_seed, status, created_at, timezone) VALUES (?,?, 'practice', ?, ?, 'test', 'seed', 'ended_early', ?, 'Australia/Brisbane')").run(randomUUID(), ids[1], env.settingsId, env.planId, env.clock.current.toISOString());
    expect(courseLessons(env.db).map((x) => [x.id, x.completed, x.unlocked])).toEqual([[latest, 1, true], [ids[1], 0, true], [ids[0], 0, false]]);
  } finally { env.cleanup(); }
});
