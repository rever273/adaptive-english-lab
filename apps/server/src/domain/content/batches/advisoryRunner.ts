import type { ExerciseType } from "@english-lab/contracts";
import type { Db } from "../../../db/open.js";
import { RunnerError, type JobRunner, type RunnerContext, type RunnerOutput } from "../../../queue/types.js";
import { upsertModelVersion } from "../../attempts/transcripts.js";
import type { DecisionClient } from "../../ai/clients.js";
import { AI_CONFIG_V2, MEASURED_ADDITIONAL_PEAK_MIB, configHashOf } from "../../ai/config.js";
import { DRAFT_SCREEN_V1, ensurePromptVersion } from "../../ai/prompts.js";
import { flagsFor, screenSentences } from "./screen.js";

export const SCREEN_PROMPT = "draft-screen-v1";

export interface AdvisoryPayload {
  revisionId: string;
}

export interface AdvisoryRunnerOptions {
  db: Db;
  decision: DecisionClient;
  installedDigest: (tag: string) => Promise<string | null>;
  runtimeVersion: () => Promise<string>;
  deps: { now: () => Date; newId: () => string };
}

/**
 * Nimble as a cheap HELPER for the human reviewer (D49): for a stored draft it asks, sentence by sentence, whether the text reads as correct
 * English, and records the raw scores plus the flags that fixed rules derive from them. The result is a hint attached to the revision. It does
 * not change the revision's state, is read by nothing that selects, grades or scores, and never replaces the reviewer.
 */
export class AdvisoryJobRunner implements JobRunner<AdvisoryPayload> {
  readonly kind = "triage" as const;
  private modelVersionId: string | null = null;

  constructor(private readonly o: AdvisoryRunnerOptions) {}

  private get pinned() {
    return AI_CONFIG_V2.triage;
  }

  async prepare(): Promise<{ ok: boolean; reason?: string }> {
    const m = this.pinned;
    const digest = await this.o.installedDigest(m.tag);
    if (digest === null) return { ok: false, reason: "model_server_or_model_unavailable" };
    if (digest !== m.digest) return { ok: false, reason: "digest_drift" };
    const id = upsertModelVersion(this.o.db, this.o.deps.newId, { tag: m.tag, digest, runtime: "ollama", runtimeVersion: await this.o.runtimeVersion(), parameters: { decision: "systemone/choice", prompt: SCREEN_PROMPT } });
    const peak = MEASURED_ADDITIONAL_PEAK_MIB[m.tag];
    if (peak !== undefined) {
      this.o.db
        .prepare("INSERT OR IGNORE INTO gpu_profiles(id, model_version_id, config_hash, measured_peak_mib, timings_json, validated_at) VALUES (?,?,?,?,?,?)")
        .run(this.o.deps.newId(), id, configHashOf({ numCtx: 0 }), peak, JSON.stringify({ source: "TASK_009 benchmark (whole-card peak 11756 MiB at ~2000 MiB baseline)", note: "additional peak above the desktop baseline" }), this.o.deps.now().toISOString());
    }
    ensurePromptVersion(this.o.db, SCREEN_PROMPT, JSON.stringify(DRAFT_SCREEN_V1));
    this.modelVersionId = id;
    return { ok: true };
  }

  ownedModels(): string[] {
    return [this.pinned.tag];
  }
  profileKey() {
    return this.modelVersionId ? { modelVersionId: this.modelVersionId, configHash: configHashOf({ numCtx: 0 }) } : null;
  }

  async run(ctx: RunnerContext<AdvisoryPayload>): Promise<RunnerOutput> {
    const m = this.pinned;
    const { revisionId } = ctx.job.payload;
    const installed = await this.o.installedDigest(m.tag);
    if (installed !== m.digest) throw new RunnerError("model_digest_mismatch", `installed digest of ${m.tag} differs from the pinned one`, false);
    const row = this.o.db.prepare("SELECT type, content_json AS c FROM exercise_revisions WHERE id = ?").get(revisionId) as { type: ExerciseType; c: string } | undefined;
    if (!row) throw new RunnerError("revision_missing", "unknown revision", false);
    const already = this.o.db.prepare("SELECT 1 FROM advisory_signals WHERE revision_id = ? AND prompt_version_id = ?").get(revisionId, SCREEN_PROMPT);
    if (already) return { schemaVersion: "draft-screen-v1", output: { revisionId, skipped: "already_screened" }, metrics: { calls: 0 } };

    const sentences = screenSentences(row.type, JSON.parse(row.c));
    const scores: number[] = [];
    for (const s of sentences) {
      if (ctx.signal.aborted) throw new DOMException("aborted", "AbortError");
      const d = await this.o.decision.decide({ model: m.tag, text: s.text, instructions: DRAFT_SCREEN_V1.instructions, criteria: DRAFT_SCREEN_V1.criteria, signal: ctx.signal });
      scores.push(round3(d.probabilities.review ?? (d.choice === "review" ? 1 : 0)));
    }
    const flags = flagsFor(sentences, scores, DRAFT_SCREEN_V1.thresholds);
    const detail = sentences.map((s, i) => ({ role: s.role, label: s.label, text: s.text, score: scores[i] }));
    const source = `${m.tag}@${m.digest.slice(0, 12)}`;
    return {
      schemaVersion: "draft-screen-v1",
      output: { revisionId, sentences: detail, flags },
      metrics: { calls: sentences.length },
      alsoCommit: (db) => {
        const jr = db.prepare("SELECT id FROM job_results WHERE job_id = ?").get(ctx.job.id) as { id: string };
        db.prepare("INSERT OR IGNORE INTO advisory_signals(id, revision_id, source, prompt_version_id, job_result_id, scores_json, flags_json, created_at) VALUES (?,?,?,?,?,?,?,?)").run(this.o.deps.newId(), revisionId, source, SCREEN_PROMPT, jr.id, JSON.stringify(detail), JSON.stringify(flags), this.o.deps.now().toISOString());
      },
    };
  }
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
