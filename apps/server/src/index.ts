import { randomBytes, randomUUID } from "node:crypto";
import { buildApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { prepareDatabase } from "./db/prepare.js";
import { NvidiaSmiTelemetry } from "./adapters/gpu/nvidiaSmi.js";
import { OllamaClient, OllamaModelControl } from "./adapters/gpu/ollamaClient.js";
import { NimbleDecisionClient, OllamaChatClient } from "./adapters/ollama/chat.js";
import { VocabularyJobRunner } from "./domain/vocabulary/enrichment.js";
import { TutorJobRunner } from "./domain/tutor/runner.js";
import { AdvisoryJobRunner } from "./domain/content/batches/advisoryRunner.js";
import { AnalysisJobRunner } from "./domain/ai/analysisRunner.js";
import { GenerationJobRunner } from "./domain/content/batches/generationRunner.js";
import { GpuScheduler } from "./queue/scheduler.js";
import { SttWorker } from "./adapters/stt/sttWorker.js";
import { findSttModel, resolveSttLaunch } from "./adapters/stt/launch.js";
import { SttService } from "./domain/stt/sttService.js";
import { acquireLock, LockError, releaseLock, type LockInfo } from "./lock.js";
import { openLogStream } from "./logging.js";
import { getProcessStartTime } from "./processIdentity.js";
import { regradeNearMatches } from "./domain/attempts/regrade.js";
import { queueMissingLevels, recoverLegacyVocabularyFailures } from "./domain/vocabulary/repository.js";

// Exit codes are read by scripts/start.mjs.
const EXIT = { config: 2, lock: 3, port: 4, database: 5, other: 1 } as const;

function fail(code: number, message: string): never {
  process.stderr.write(`English Lab: ${message}\n`);
  process.exit(code);
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) fail(EXIT.config, `${err.code}: ${err.message}`);
    throw err;
  }

  const instanceId = randomUUID();
  const startedAt = new Date().toISOString();
  const lock: LockInfo = {
    pid: process.pid,
    processStartTime: getProcessStartTime(process.pid),
    instanceId,
    startedAt,
    port: config.port,
    shutdownToken: randomBytes(32).toString("hex"),
  };
  try {
    acquireLock(config.lockPath, lock);
  } catch (err) {
    if (err instanceof LockError) fail(EXIT.lock, `${err.code}: ${err.message}`);
    throw err;
  }

  let prepared;
  try {
    prepared = await prepareDatabase(config);
  } catch (err) {
    releaseLock(config.lockPath, instanceId);
    fail(EXIT.database, `database not usable: ${(err as Error).message}`);
  }
  const { db } = prepared;

  const logStream = openLogStream(config.logsDir);
  let shuttingDown = false;
  let app: Awaited<ReturnType<typeof buildApp>>;
  // The single GPU dispatcher. The only model runner is the Qwen free-text analysis (tentative drafts); Nimble routing stays disabled (D42).
  const ollama = new OllamaClient();
  const analysisOpts = {
    installedDigest: async (tag: string): Promise<string | null> => {
      try {
        const t = await ollama.json<{ models: Array<{ name: string; digest: string }> }>("/api/tags", { method: "GET", timeoutMs: 5000 });
        return t.models.find((m) => m.name === tag)?.digest ?? null;
      } catch {
        return null;
      }
    },
    runtimeVersion: async (): Promise<string> => (await ollama.json<{ version: string }>("/api/version", { method: "GET", timeoutMs: 5000 })).version,
  };
  const analysis = new AnalysisJobRunner({ db, chat: new OllamaChatClient(ollama), ...analysisOpts, deps: { now: () => new Date(), newId: randomUUID } });
  const generation = new GenerationJobRunner({
    db,
    chat: new OllamaChatClient(ollama),
    installedDigest: (tag) => analysisOpts.installedDigest(tag),
    runtimeVersion: () => analysisOpts.runtimeVersion(),
    deps: { now: () => new Date(), newId: randomUUID },
  });
  const advisory = new AdvisoryJobRunner({ db, decision: new NimbleDecisionClient(ollama), installedDigest: (tag) => analysisOpts.installedDigest(tag), runtimeVersion: () => analysisOpts.runtimeVersion(), deps: { now: () => new Date(), newId: randomUUID } });
  const vocabulary = new VocabularyJobRunner({ db, chat: new OllamaChatClient(ollama), installedDigest: (tag) => analysisOpts.installedDigest(tag), runtimeVersion: () => analysisOpts.runtimeVersion(), deps: { now: () => new Date(), newId: randomUUID } });
  const tutor = new TutorJobRunner({ db, chat: new OllamaChatClient(ollama), installedDigest: (tag) => analysisOpts.installedDigest(tag), runtimeVersion: () => analysisOpts.runtimeVersion(), deps: { now: () => new Date(), newId: randomUUID } });
  let analysisReady = false;
  let advisoryReady = false;
  const scheduler = new GpuScheduler({
    db,
    newId: randomUUID,
    telemetry: new NvidiaSmiTelemetry(),
    control: new OllamaModelControl(ollama),
    runners: config.aiRunners === false ? [] : [analysis, generation, advisory, vocabulary, tutor],
    instanceId,
  });

  const stt = new SttService({
    db,
    deps: { now: () => new Date(), newId: randomUUID },
    scheduler,
    available: () => findSttModel() !== null,
    createWorker: () => {
      const l = resolveSttLaunch();
      return l.ok ? { worker: new SttWorker(l.launch), modelPath: l.modelPath } : null;
    },
  });

  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app?.log.info({ reason }, "shutdown: stop admission");
    try {
      await stt.shutdown(); // the voice child first: it holds the card
      await scheduler.stop(); // stop admission, abort + discard the running unit, prove the release, give the lease back
      await app?.close(); // drain in-flight requests
      db.pragma("wal_checkpoint(TRUNCATE)");
      db.close();
    } catch (err) {
      process.stderr.write(`English Lab: error during shutdown: ${(err as Error).message}\n`);
    } finally {
      releaseLock(config.lockPath, instanceId);
      logStream.end(() => process.exit(0));
    }
  };

  app = await buildApp({
    config,
    db,
    instanceId,
    startedAt,
    shutdownToken: lock.shutdownToken,
    onShutdown: () => void shutdown("api"),
    logStream,
    sessions: { banner: process.env.ENGLISHLAB_BANNER ?? null },
    scheduler,
    stt,
    aiStatus: () => ({ ollama: analysisReady ? "ready" : "unavailable", nimble: advisoryReady ? "ready" : "unavailable", qwen: analysisReady ? "ready" : "unavailable" }),
  });

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (err) {
    db.close();
    releaseLock(config.lockPath, instanceId);
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") fail(EXIT.port, `port ${config.port} is already in use; not reusing it. Set ENGLISHLAB_PORT to another port`);
    fail(EXIT.other, `cannot listen: ${(err as Error).message}`);
  }

  app.log.info(
    {
      instanceId,
      schemaVersion: prepared.migration.toVersion,
      appliedMigrations: prepared.migration.applied,
      premigrationBackup: prepared.migration.premigrationBackup?.file ?? null,
      dailyBackup: prepared.dailyBackup?.file ?? null,
    },
    "started",
  );
  // D64: written answers that the near-match rule now confirms, and CEFR levels for words saved before levels existed
  const regraded = regradeNearMatches(db, { now: () => new Date(), newId: randomUUID });
  const recoveredVocabulary = recoverLegacyVocabularyFailures(db, { now: () => new Date(), newId: randomUUID });
  const levelJobs = queueMissingLevels(db, { now: () => new Date(), newId: randomUUID });
  if (regraded + levelJobs + recoveredVocabulary > 0) app.log.info({ regraded, levelJobs, recoveredVocabulary }, "startup follow-ups");
  scheduler.start();
  // Model identity + measured profile; until it succeeds, analysis jobs wait as profile_unknown. Retried while the server runs.
  const prepareAnalysis = async (): Promise<void> => {
    if (shuttingDown || config.aiRunners === false) return;
    const r = await analysis.prepare().catch((e: Error) => ({ ok: false, reason: e.message }));
    const g = await generation.prepare().catch((e: Error) => ({ ok: false, reason: e.message }));
    analysisReady = r.ok && g.ok;
    const v = await vocabulary.prepare().catch((e: Error) => ({ ok: false, reason: e.message }));
    const t = await tutor.prepare().catch((e: Error) => ({ ok: false, reason: e.message }));
    const n = await advisory.prepare().catch((e: Error) => ({ ok: false, reason: e.message }));
    advisoryReady = n.ok; // Nimble is a HELPER (hints for the reviewer, D49), never a gate on Qwen analysis
    if (!n.ok) app.log.info({ reason: n.reason }, "advisory runner not ready");
    app.log.info({ ok: r.ok, reason: r.ok ? undefined : r.reason }, "analysis runner prepare");
    if (!(r.ok && g.ok && n.ok && v.ok && t.ok)) setTimeout(() => void prepareAnalysis(), 60_000).unref();
  };
  void prepareAnalysis();
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  process.stderr.write(`English Lab: fatal: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(EXIT.other);
});
