import { randomUUID } from "node:crypto";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../../apps/server/src/db/migrate.js";
import { openDatabase, type Db } from "../../../apps/server/src/db/open.js";
import { registerErrorHandling } from "../../../apps/server/src/errors.js";
import { createBackup, verifyBackup } from "../../../apps/server/src/db/backup.js";
import { loadVoices, saveVoiceSettings } from "../../../apps/server/src/domain/voices/catalog.js";
import { VoiceService } from "../../../apps/server/src/domain/voices/service.js";
import type { DictationEnv } from "../../../apps/server/src/domain/typing/dictation/lessons.js";
import { registerTypingDictationRoutes } from "../../../apps/server/src/routes/typingDictation.js";
import { registerVoiceRoutes } from "../../../apps/server/src/routes/voices.js";
import { makeScratchRoot, projectRoot } from "../helpers.js";

let scratch: ReturnType<typeof makeScratchRoot> | null = null;
let db: Db | null = null;
afterEach(() => {
  db?.close();
  db = null;
  scratch?.cleanup();
  scratch = null;
});

const NOW = "2026-11-06T00:00:00.000Z";
async function setup(): Promise<Db> {
  scratch = makeScratchRoot();
  db = openDatabase(path.join(scratch.root, "db", "test.sqlite"));
  await runMigrations(db, { migrationsDir: path.join(projectRoot, "migrations"), appVersion: "test" });
  return db;
}
const service = () => new VoiceService({ now: () => new Date(NOW), newId: randomUUID });
const key = (n: number) => `piper:en_AU-librivox-medium:${n}`;

/** a voiced exercise to mark (all in one lesson: only one lesson can be open) */
let ordinal = 0;
function addExercise(d: Db, id: string, voiceId: number, source = "tts"): void {
  if (ordinal === 0) d.prepare("INSERT INTO typing_dictation_lessons(id, level_number, status, exercise_count, settings_revision, settings_json, plan_json, generation_attempt, created_at) VALUES (?,?,?,?,?,?,?,?,?)").run("l1", 1, "ready", 20, 1, "{}", "{}", 1, NOW);
  d.prepare(
    `INSERT INTO typing_dictation_exercises(id, lesson_id, ordinal, text_en, translation_ru, topic, target_skill_id, word_count, fingerprint, source, voice_id, voice_name, length_scale, tts_model_sha256, audio_file, audio_ms, asr_model, asr_text, status, job_result_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, "l1", ordinal++, `Sentence ${id} is here today.`, "ru", "t", null, 5, `fp-${id}`, source, source === "tts" ? voiceId : null, source === "tts" ? "x" : null, source === "tts" ? 1.1 : null, source === "tts" ? "a".repeat(64) : null, "f.wav", 1000, "m", "t", "validated", null, NOW);
}

describe("migration 037: the voice catalogue", () => {
  it("seeds ten voices with the learner's starting weights, the calibrated pace and the older voices' topic limits", async () => {
    const d = await setup();
    const voices = loadVoices(d);
    expect(voices.map((v) => v.name)).toEqual(["clancy", "bindi", "marlo", "kirra", "angus", "banjo", "flynn", "matilda", "tully", "willow"]);
    const by = Object.fromEntries(voices.map((v) => [v.name, v]));
    expect(Object.fromEntries(voices.map((v) => [v.name, v.priorWeight]))).toEqual({ clancy: 0.15, bindi: 0.45, marlo: 0.3, kirra: 0.9, angus: 0.5, banjo: 1, flynn: 0.9, matilda: 1, tully: 0.6, willow: 0.3 });
    expect(by.clancy).toMatchObject({ enabled: true, lengthScale: 1.39, gender: "male" });
    expect(by.banjo).toMatchObject({ lengthScale: 1.5, ageGroup: "adult", avoidGroups: [] });
    expect(by.marlo).toMatchObject({ ageGroup: "elderly", avoidGroups: ["tech", "gaming", "crypto"] });
    expect(by.bindi!.ageGroup).toBe("mature");
    expect(voices.every((v) => v.enabled && v.source === "seed" && v.revision === 1 && v.maxSpeedUp === 0.2)).toBe(true);
  });

  it("is append-only and keeps the old live-check table as it was", async () => {
    const d = await setup();
    expect(() => d.prepare("UPDATE tts_voices SET name = 'x'").run()).toThrow(/append-only/);
    expect(() => d.prepare("DELETE FROM tts_voice_settings").run()).toThrow(/append-only/);
    service().recordChecks(d, NOW, [{ key: key(1), purpose: "dictation", outcome: "ok", attemptGroup: "g" }]);
    expect(() => d.prepare("UPDATE tts_voice_checks SET outcome = 'asr_mismatch'").run()).toThrow(/append-only/);
    expect(() => d.prepare("DELETE FROM tts_voice_checks").run()).toThrow(/append-only/);
    expect(() => d.prepare("INSERT INTO tts_voice_checks(id, voice_key, purpose, attempt_group, outcome, created_at) VALUES ('c', 'no-such', 'dictation', 'g', 'ok', 'now')").run()).toThrow(/FOREIGN KEY/);
    expect((d.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'typing_dictation_voice_checks'").get() as { n: number }).n).toBe(1);
  });

  it("copies the checks of migration 035 when it is applied to a database that has them", async () => {
    scratch = makeScratchRoot();
    db = openDatabase(path.join(scratch.root, "db", "test.sqlite"));
    const fs = await import("node:fs");
    const dir = path.join(scratch.root, "migrations");
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(path.join(projectRoot, "migrations")).filter((n) => /^0(0\d|1\d|2\d|3[0-6])_/.test(n))) fs.copyFileSync(path.join(projectRoot, "migrations", f), path.join(dir, f));
    await runMigrations(db, { migrationsDir: dir, appVersion: "test" });
    db.prepare("INSERT INTO typing_dictation_voice_checks(id, voice_id, outcome, created_at) VALUES ('a', 5, 'ok', '2026-11-05T00:00:00.000Z'), ('b', 5, 'asr_mismatch', '2026-11-05T00:00:01.000Z')").run();
    fs.copyFileSync(path.join(projectRoot, "migrations", "037_tts_voices.sql"), path.join(dir, "037_tts_voices.sql"));
    const backupsDir = path.join(scratch.root, "backups");
    const result = await runMigrations(db, { migrationsDir: dir, appVersion: "test", backup: () => createBackup(db!, { backupsDir, kind: "premigration", schemaVersion: 36, appVersion: "test" }) });
    expect(result.premigrationBackup).toMatchObject({ schemaVersion: 36, status: "ready" });
    expect(verifyBackup(backupsDir, result.premigrationBackup!)).toEqual({ checksumOk: true, integrity: "ok", foreignKeyViolations: 0 });
    // the backup is the recovery point: it holds the database before 037 and none of the new tables
    const before = openDatabase(path.join(backupsDir, result.premigrationBackup!.file), { readonly: true });
    expect(before.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'tts_voices'").get()).toEqual({ n: 0 });
    expect(before.prepare("SELECT COUNT(*) AS n FROM typing_dictation_voice_checks").get()).toEqual({ n: 2 });
    before.close();
    const rows = db.prepare("SELECT id, voice_key, purpose, attempt_group, outcome FROM tts_voice_checks ORDER BY id").all();
    expect(rows).toEqual([
      { id: "a", voice_key: key(5), purpose: "dictation", attempt_group: "a", outcome: "ok" },
      { id: "b", voice_key: key(5), purpose: "dictation", attempt_group: "b", outcome: "asr_mismatch" },
    ]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM typing_dictation_voice_checks").get() as { n: number }).n).toBe(2);
  });
});

describe("weights and shares", () => {
  it("shares follow the starting weights when there is no evidence, and the older voices have less", async () => {
    const d = await setup();
    const list = service().list(d, { purpose: "dictation" });
    const share = Object.fromEntries(list.map((v) => [v.name, v.share]));
    expect(list.reduce((a, v) => a + v.share, 0)).toBeGreaterThan(0.99);
    expect(share.banjo).toBeGreaterThan(share.angus!);
    expect(share.angus).toBeGreaterThan(share.willow!);
    expect(share.clancy).toBeGreaterThan(0);
    expect(share.clancy).toBeLessThan(0.04);
    expect(list.every((v) => v.weight.version === 1 && v.weight.offline === 1 && v.weight.flags === 1)).toBe(true);
  });

  it("a voice switched off, or not meant for a purpose, has no weight there", async () => {
    const d = await setup();
    const s = service();
    saveVoiceSettings(d, { now: () => new Date(NOW), newId: randomUUID }, key(5), { enabled: false }, "user");
    saveVoiceSettings(d, { now: () => new Date(NOW), newId: randomUUID }, key(7), { purposes: ["dictation"] }, "user");
    expect(s.list(d, { purpose: "dictation" }).find((v) => v.name === "banjo")!.weight.effective).toBe(0);
    expect(s.list(d, { purpose: "books" }).find((v) => v.name === "matilda")!.weight.effective).toBe(0);
    expect(s.list(d, { purpose: "dictation" }).find((v) => v.name === "matilda")!.weight.effective).toBeGreaterThan(0);
    for (let seed = 0; seed < 200; seed++) expect(s.pick(d, { purpose: "dictation", seed })!.name).not.toBe("banjo");
  });

  it("live checks lower a misheard voice (a sentence nobody could say counts for half), but never below the floor", async () => {
    const d = await setup();
    const s = service();
    const checks: Array<{ key: string; purpose: "dictation"; outcome: "ok" | "asr_mismatch"; attemptGroup: string }> = [];
    for (let i = 0; i < 10; i++) checks.push({ key: key(1), purpose: "dictation", outcome: "asr_mismatch", attemptGroup: `bindi-${i}` }, { key: key(2), purpose: "dictation", outcome: "ok", attemptGroup: `bindi-${i}` });
    // kirra and angus: the same number of misses, but on sentences where nobody was heard
    for (let i = 0; i < 10; i++) checks.push({ key: key(3), purpose: "dictation", outcome: "asr_mismatch", attemptGroup: `lost-${i}` }, { key: key(4), purpose: "dictation", outcome: "asr_mismatch", attemptGroup: `lost-${i}` });
    s.recordChecks(d, NOW, checks);
    const w = Object.fromEntries(s.list(d, { purpose: "dictation" }).map((v) => [v.name, v.weight]));
    expect(w.bindi!.live).toBe(0.4);
    expect(w.marlo!.live).toBeGreaterThan(1);
    expect(w.kirra!.live).toBeGreaterThan(0.4);
    expect(w.kirra!.live).toBe(w.angus!.live);
    expect(w.bindi!.effective).toBeCloseTo(0.45 * 0.4, 3);
  });

  it("an evaluation run of the installed model scales the weights; a partial run and another model do not", async () => {
    const d = await setup();
    const s = service();
    const run = (id: string, status: string, sha: string) => d.prepare("INSERT INTO tts_voice_eval_runs(id, started_at, finished_at, tts_model_sha256, script_version, sentence_set_version, tools_json, status) VALUES (?,?,?,?,?,?,?,?)").run(id, NOW, NOW, sha, 1, 1, "{}", status);
    const clip = (runId: string, voice: number, errors: number, mos: number) => d.prepare("INSERT INTO tts_voice_eval_clips(id, run_id, voice_key, length_scale, noise_w_scale, sentence_index, text, heard_text, word_errors, metrics_json) VALUES (?,?,?,?,?,?,?,?,?,?)").run(randomUUID(), runId, key(voice), 1.1, null, 0, "t", "t", errors, JSON.stringify({ factor: 1, mos }));
    run("r-partial", "partial", "sha-a");
    for (let i = 0; i < 10; i++) clip("r-partial", 5, 1, 2.0);
    expect(s.list(d, { purpose: "dictation", modelSha: "sha-a" }).find((v) => v.name === "banjo")!.weight.offline).toBe(1);
    run("r-complete", "complete", "sha-a");
    for (let i = 0; i < 10; i++) { clip("r-complete", 5, 0, 3.6); clip("r-complete", 3, i < 5 ? 0 : 1, 3.0); clip("r-complete", 7, 0, 3.0); }
    const at = (sha?: string) => Object.fromEntries(s.list(d, { purpose: "dictation", ...(sha ? { modelSha: sha } : {}) }).map((v) => [v.name, v.weight.offline]));
    expect(at("sha-a").banjo).toBeGreaterThan(1);
    expect(at("sha-a").kirra).toBeLessThan(1);
    expect(at("sha-a").clancy).toBe(1); // not in the run
    expect(at("sha-b").banjo).toBe(1); // another installed model: the evaluation does not apply
  });
});

describe("settings revisions", () => {
  it("every change is a new revision, older ones stay, an unknown voice is a 404", async () => {
    const d = await setup();
    const s = service();
    const v = s.updateSettings(d, key(8), { priorWeight: 0.2, lengthScale: 1.3 });
    expect(v).toMatchObject({ revision: 2, priorWeight: 0.2, lengthScale: 1.3, source: "user", ageGroup: "mature" });
    s.updateSettings(d, key(8), { enabled: false });
    expect(s.history(d, key(8)).map((r) => [r.revision, r.source, r.priorWeight, r.enabled])).toEqual([[3, "user", 0.2, false], [2, "user", 0.2, true], [1, "seed", 0.6, true]]);
    expect(() => s.updateSettings(d, "piper:nothing:1", { enabled: false })).toThrow(/no such voice/);
    expect(() => d.prepare("INSERT INTO tts_voice_settings(id, voice_key, revision, enabled, prior_weight, length_scale, age_group, source, created_at) VALUES ('z', ?, 9, 1, 3, 1, 'adult', 'user', 'now')").run(key(8))).toThrow(/CHECK/);
  });

  it("the pace of a sentence keeps its small variation within the voice's own speed-up limit", async () => {
    const d = await setup();
    const s = service();
    const banjo = s.bySpeaker(d, 5)!;
    expect(s.synthesisParams(banjo)).toEqual({ speakerId: 5, lengthScale: 1.5 });
    const seeds = Array.from({ length: 200 }, (_, i) => `x:${i}`);
    expect(Math.min(...seeds.map((x) => s.synthesisParams(banjo, x).lengthScale))).toBeLessThan(1.45);
    s.updateSettings(d, key(5), { maxSpeedUp: 0 });
    expect(seeds.every((x) => s.synthesisParams(s.bySpeaker(d, 5)!, x).lengthScale === 1.5)).toBe(true);
    s.updateSettings(d, key(5), { noiseWScale: 0.5 });
    expect(s.synthesisParams(s.bySpeaker(d, 5)!)).toEqual({ speakerId: 5, lengthScale: 1.5, noiseWScale: 0.5 });
  });
});

describe("Sounds bad (D128)", () => {
  it("writes events only when the state changes, lowers the voice's weight, and touches nothing else", async () => {
    const d = await setup();
    const s = service();
    ordinal = 0;
    for (let i = 0; i < 10; i++) addExercise(d, `e${i}`, 8);
    expect(s.setFlag(d, { exerciseId: "e0", flagged: false })).toEqual({ flagged: false });
    expect((d.prepare("SELECT COUNT(*) AS n FROM tts_voice_flags").get() as { n: number }).n).toBe(0);
    expect(s.setFlag(d, { exerciseId: "e0", flagged: true })).toEqual({ flagged: true });
    expect(s.setFlag(d, { exerciseId: "e0", flagged: true })).toEqual({ flagged: true });
    expect((d.prepare("SELECT COUNT(*) AS n FROM tts_voice_flags").get() as { n: number }).n).toBe(1);
    const tully = () => s.list(d, { purpose: "dictation" }).find((v) => v.name === "tully")!;
    expect(tully().flags).toBe(1);
    expect(tully().weight.flags).toBe(0.7);
    expect(tully().weight.effective).toBeCloseTo(0.6 * 0.7, 3);
    s.setFlag(d, { exerciseId: "e0", flagged: false });
    s.setFlag(d, { exerciseId: "e0", flagged: true });
    expect((d.prepare("SELECT action FROM tts_voice_flags ORDER BY rowid").all() as Array<{ action: string }>).map((r) => r.action)).toEqual(["flag", "unflag", "flag"]);
    s.setFlag(d, { exerciseId: "e0", flagged: false });
    expect(tully().flags).toBe(0);
    expect(tully().weight.flags).toBe(1);
    expect(() => d.prepare("DELETE FROM tts_voice_flags").run()).toThrow(/append-only/);
    expect(() => s.setFlag(d, { exerciseId: "nope", flagged: true })).toThrow(/does not exist/);
    // nothing about the answers changed
    expect((d.prepare("SELECT COUNT(*) AS n FROM typing_dictation_attempts").get() as { n: number }).n).toBe(0);
    expect((d.prepare("SELECT COUNT(*) AS n FROM typing_dictation_xp_events").get() as { n: number }).n).toBe(0);
  });
});

describe("voice routes", () => {
  it("lists the voices, saves a change as a revision, validates input and plays a cached sample", async () => {
    const d = await setup();
    const calls: Array<{ speakerId: number; lengthScale: number }> = [];
    const env = {
      tts: { available: () => ({ ok: true as const, modelSha256: "a".repeat(64) }), synthesize: async (i: { speakerId: number; lengthScale: number }) => { calls.push(i); return Buffer.from("RIFF-sample"); }, stop: async () => {} },
      voices: service(),
    } as unknown as DictationEnv;
    const app = Fastify();
    registerErrorHandling(app);
    registerVoiceRoutes(app, d, { env, sampleDir: path.join(scratch!.root, "samples") });
    const listed = (await app.inject({ method: "GET", url: "/api/v1/voices" })).json() as { purpose: string; voices: Array<{ name: string; share: number; weight: { effective: number } }> };
    expect(listed.purpose).toBe("dictation");
    expect(listed.voices).toHaveLength(10);
    const enc = encodeURIComponent(key(2));
    const saved = await app.inject({ method: "PATCH", url: `/api/v1/voices/${enc}/settings`, payload: { priorWeight: 0.1 } });
    expect(saved.statusCode).toBe(200);
    expect((saved.json() as typeof listed).voices.find((v) => v.name === "marlo")!.weight.effective).toBeCloseTo(0.1, 2);
    expect((await app.inject({ method: "PATCH", url: `/api/v1/voices/${enc}/settings`, payload: { priorWeight: 9 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: `/api/v1/voices/${enc}/settings`, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: `/api/v1/voices/${enc}/settings`, payload: { voiceKey: "x" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: `/api/v1/voices/${encodeURIComponent("piper:nothing:1")}/settings`, payload: { enabled: false } })).statusCode).toBe(404);
    expect(((await app.inject({ method: "GET", url: `/api/v1/voices/${enc}/history` })).json() as { revisions: unknown[] }).revisions).toHaveLength(2);
    const a = await app.inject({ method: "GET", url: `/api/v1/voices/${enc}/sample` });
    const b = await app.inject({ method: "GET", url: `/api/v1/voices/${enc}/sample` });
    expect(a.statusCode).toBe(200);
    expect(b.rawPayload.equals(a.rawPayload)).toBe(true);
    expect(calls).toHaveLength(1); // the second sample came from the cache
    expect(calls[0]).toMatchObject({ speakerId: 2 });
    // an unsaved pace is heard as it is, not as saved; a pace out of range is refused
    const draft = await app.inject({ method: "GET", url: `/api/v1/voices/${enc}/sample?lengthScale=1.05` });
    expect(draft.statusCode).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ speakerId: 2, lengthScale: 1.05 });
    expect((await app.inject({ method: "GET", url: `/api/v1/voices/${enc}/sample?lengthScale=3` })).statusCode).toBe(400);
    await app.close();
  });
});

describe("Sounds bad route", () => {
  it("marks and unmarks a voiced sentence and rejects bad requests", async () => {
    const d = await setup();
    ordinal = 0;
    addExercise(d, "e0", 4);
    const env = { voices: service(), tts: { available: () => ({ ok: true as const, modelSha256: "a".repeat(64) }) } } as unknown as DictationEnv;
    const app = Fastify();
    registerErrorHandling(app);
    registerTypingDictationRoutes(app, d, { now: () => new Date(NOW), newId: randomUUID }, { env });
    const post = (id: string, payload: unknown) => app.inject({ method: "POST", url: `/api/v1/typing/dictation/exercises/${id}/sound-flag`, payload });
    expect((await post("e0", { flagged: true })).json()).toEqual({ flagged: true });
    expect(env.voices.list(d, { purpose: "dictation" }).find((v) => v.name === "angus")!.flags).toBe(1);
    expect((await post("e0", { flagged: false })).json()).toEqual({ flagged: false });
    expect((await post("e0", { flagged: "yes" })).statusCode).toBe(400);
    expect((await post("e0", {})).statusCode).toBe(400);
    expect((await post("nope", { flagged: true })).statusCode).toBe(404);
    await app.close();
  });
});
