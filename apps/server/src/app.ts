import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Writable } from "node:stream";
import type { Capabilities, Health } from "@english-lab/contracts";
import type { AppConfig } from "./config.js";
import type { Db } from "./db/open.js";
import { readDbInfo } from "./db/info.js";
import { ApiError, envelope, registerErrorHandling } from "./errors.js";
import { registerCsrf } from "./csrf.js";
import type { AttemptDeps } from "./domain/attempts/ports.js";
import { jobsOutbox } from "./queue/outbox.js";
import type { GpuScheduler } from "./queue/scheduler.js";
import { registerQueueRoutes } from "./routes/queue.js";
import { ClosedFormAssessor } from "./domain/content/grader.js";
import type { DiscoveryConfig } from "@english-lab/learning";
import { registerAnalyticsRoutes } from "./routes/analytics.js";
import { registerReportRoutes } from "./routes/reports.js";
import { registerBackupRoutes } from "./routes/backups.js";
import { registerVocabularyRoutes } from "./routes/vocabulary.js";
import { registerTutorRoutes } from "./routes/tutor.js";
import { registerAttemptRoutes } from "./routes/attempts.js";
import { registerContentRoutes } from "./routes/content.js";
import { registerSttRoutes } from "./routes/stt.js";
import type { SttService } from "./domain/stt/sttService.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerSecurity } from "./security.js";

export interface AppDeps {
  config: AppConfig;
  db: Db;
  instanceId: string;
  startedAt: string;
  shutdownToken: string;
  /** Invoked after the 202 response has been sent. */
  onShutdown: () => void;
  /** Log destination; omit to disable logging (tests). */
  logStream?: Writable;
  /** Ports for the attempts domain; defaults: PendingAssessor (no grader yet), NullOutbox (no queue yet). */
  attempts?: Partial<AttemptDeps>;
  /** discovery-v1 configuration (no qualified model by default: the signal is off) and a dashboard banner for non-release profiles */
  sessions?: { discovery?: DiscoveryConfig; banner?: string | null };
  /** the single GPU dispatcher; null/undefined = not running (the API then says so) */
  scheduler?: GpuScheduler | null;
  /** voice capture (TASK_011); absent = the endpoints are not registered and /capabilities says "not_implemented" */
  stt?: SttService | null;
  /** live AI component status; absent = nothing wired (tests, TASK_003 behaviour) */
  aiStatus?: () => Capabilities["ai"];
  /** HMAC key for the session cookie / CSRF token; random per start when omitted. */
  csrfSecret?: Buffer;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, db } = deps;
  const app = Fastify({
    bodyLimit: 1024 * 1024,
    genReqId: () => randomUUID(),
    logger: deps.logStream
      ? {
          level: "info",
          stream: deps.logStream,
          // IDs, status and timings only - never bodies or query strings (spec/11).
          serializers: {
            req: (req: { id: string; method: string; url: string }) => ({ id: req.id, method: req.method, url: req.url.split("?")[0] }),
            res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
          },
        }
      : false,
  });

  registerErrorHandling(app);
  registerSecurity(app, config);
  registerCsrf(app, deps.csrfSecret);
  registerAttemptRoutes(app, db, {
    assessor: ClosedFormAssessor,
    outbox: jobsOutbox({ now: deps.attempts?.now ?? (() => new Date()), newId: deps.attempts?.newId ?? randomUUID }),
    now: () => new Date(),
    newId: randomUUID,
    ...deps.attempts,
  });
  registerAnalyticsRoutes(app, db, deps.attempts?.now ?? (() => new Date()));
  registerVocabularyRoutes(app, db, { now: deps.attempts?.now ?? (() => new Date()), newId: deps.attempts?.newId });
  registerBackupRoutes(app, db, config);
  registerSettingsRoutes(app, db, { now: deps.attempts?.now ?? (() => new Date()), newId: deps.attempts?.newId });
  registerReportRoutes(app, db, { now: deps.attempts?.now ?? (() => new Date()), exportsRoot: path.join(config.dataRoot, "exports") });
  const base = { now: deps.attempts?.now ?? (() => new Date()), newId: deps.attempts?.newId ?? randomUUID };
  registerSessionRoutes(app, db, base, { ...(deps.sessions ?? {}), onLease: () => deps.scheduler?.kick(), onSessionEnd: (id) => void deps.stt?.stopForSession(id) });
  registerQueueRoutes(app, db, base, deps.scheduler ?? null);
  registerTutorRoutes(app, db, base, { onQueued: () => deps.scheduler?.kick() });
  if (deps.stt) registerSttRoutes(app, deps.stt);
  registerContentRoutes(app, db, { now: deps.attempts?.now ?? (() => new Date()), newId: deps.attempts?.newId ?? randomUUID }, { onBatchQueued: () => deps.scheduler?.kick() });

  const uiBuilt = existsSync(path.join(config.webDist, "index.html"));

  const degradedReasons = (): string[] => (uiBuilt ? [] : ["ui_not_built"]);

  app.get("/api/v1/health", async (): Promise<Health> => {
    let dbInfo: Health["db"];
    try {
      dbInfo = readDbInfo(db);
    } catch {
      throw new ApiError(503, "DB_UNAVAILABLE", "Database is not available; answers would not be saved");
    }
    return {
      status: degradedReasons().length === 0 ? "ok" : "degraded",
      appVersion: config.appVersion,
      instanceId: deps.instanceId,
      startedAt: deps.startedAt,
      time: new Date().toISOString(),
      node: { version: process.version },
      db: dbInfo,
      degradedReasons: degradedReasons(),
    };
  });

  app.get("/api/v1/capabilities", async (): Promise<Capabilities> => {
    let schema = 0;
    let dbStatus: "ready" | "unavailable" = "ready";
    try {
      schema = readDbInfo(db).schemaVersion;
    } catch {
      dbStatus = "unavailable";
    }
    return {
      versions: { app: config.appVersion, node: process.version, schema },
      db: { status: dbStatus },
      ui: { built: uiBuilt },
      // STT status comes from the voice service (ready = local weights found). AI status is whatever the runner honestly reports; Nimble routing stays disabled until its gate (D42).
      ai: deps.aiStatus?.() ?? { ollama: "not_implemented", nimble: "not_implemented", qwen: "not_implemented" },
      stt: { status: deps.stt ? (deps.stt.available() ? "ready" : "unavailable") : "not_implemented" },
      degradedReasons: [...degradedReasons(), ...(dbStatus === "ready" ? [] : ["db_unavailable"])],
    };
  });

  // Used only by scripts/stop: token from the lock file (var/run), never from the browser.
  app.post("/internal/shutdown", async (req, reply) => {
    const given = Buffer.from(String(req.headers["x-shutdown-token"] ?? ""));
    const want = Buffer.from(deps.shutdownToken);
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      throw new ApiError(403, "FORBIDDEN", "Invalid shutdown token");
    }
    reply.raw.once("finish", () => setImmediate(deps.onShutdown));
    return reply.code(202).send({ status: "shutting_down" });
  });

  if (uiBuilt) {
    await app.register(fastifyStatic, { root: config.webDist, wildcard: false, index: ["index.html"] });
  }

  app.setNotFoundHandler((req, reply) => {
    const isApi = req.url.startsWith("/api/") || req.url.startsWith("/internal/");
    if (!isApi && uiBuilt && req.method === "GET" && (req.headers.accept ?? "").includes("text/html")) {
      return reply.sendFile("index.html");
    }
    return reply.status(404).send(envelope(req.id, "NOT_FOUND", "Not found"));
  });

  return app;
}
