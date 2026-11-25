import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

type Clip = { sentence_id?: string; checks?: Record<string, { matches?: boolean; seconds?: number }> };
type Batch = { asr_checks_completed?: boolean; active_model?: string | null; active_started?: number | null; clips?: Clip[] };
export type AuditStatus = { enabled: boolean; running: boolean; checked: number; matched: number; error: string | null; progress: string | null; batch: { total: number; largeDone: number; mediumDone: number; activeModel: string | null; etaSeconds: number | null } | null };
const alive = (pid?: number): boolean => { if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch { return false; } };

/** the checks keep going in the background until this many checked recordings are waiting unused (10 sentences a lesson: hundreds of lessons) */
export const AUDIT_STOCK_CEILING = 5000;

/** CPU-only checks against the existing source transcript; no generated text is approved. */
export class RealAudit {
  private child: ChildProcess | null = null;
  private error: string | null = null;
  private progress: string | null = null;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly root: string;
  private readonly batches: string;
  private readonly settings: string;
  private readonly pending: string;
  private readonly lock: string;
  private readonly cancelled = new WeakSet<ChildProcess>();
  constructor(private readonly projectRoot: string, dataRoot: string, private readonly remaining?: () => number) {
    this.root = path.join(dataRoot, "dictation-real", "auto");
    this.batches = path.join(this.root, "batches");
    this.settings = path.join(this.root, "settings.json");
    this.pending = path.join(this.root, "pending.json");
    this.lock = path.join(this.root, "worker.lock");
  }
  private enabled(): boolean {
    try { return JSON.parse(readFileSync(this.settings, "utf8")).enabled === true; } catch { return false; }
  }
  status(): AuditStatus {
    let checked = 0, matched = 0;
    const times: Record<string, number[]> = { "large-v3": [], medium: [] };
    const collect = (clips: Clip[]) => { for (const c of clips) for (const name of ["large-v3", "medium"]) { const seconds = c.checks?.[name]?.seconds; if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) times[name]!.push(seconds); } };
    if (existsSync(this.batches)) for (const name of readdirSync(this.batches).filter((n) => /^batch-.*\.json$/.test(n))) {
      try {
        const batch = JSON.parse(readFileSync(path.join(this.batches, name), "utf8")) as Batch;
        if (!batch.asr_checks_completed || !Array.isArray(batch.clips)) throw new Error("incomplete batch");
        checked += batch.clips.length;
        collect(batch.clips);
        const passing = batch.clips.filter((c) => c.checks?.["large-v3"]?.matches === true && c.checks?.medium?.matches === true);
        matched += passing.length;
      } catch { this.error = "Cannot read a completed audit batch."; }
    }
    let externalRunning = false;
    try { const lock = JSON.parse(readFileSync(this.lock, "utf8")) as { worker?: number }; externalRunning = alive(lock.worker); } catch { /* no worker */ }
    const running = this.child !== null || externalRunning;
    let batch: AuditStatus["batch"] = null;
    if (running) try {
      const pending = JSON.parse(readFileSync(this.pending, "utf8")) as Batch;
      if (Array.isArray(pending.clips) && pending.clips.length) {
        collect(pending.clips);
        const total = pending.clips.length;
        const largeDone = pending.clips.filter((c) => c.checks?.["large-v3"] !== undefined).length;
        const mediumDone = pending.clips.filter((c) => c.checks?.medium !== undefined).length;
        const activeModel = pending.active_model ?? (largeDone < total ? "large-v3" : mediumDone < total ? "medium" : null);
        const allTimes = [...times["large-v3"]!, ...times.medium!];
        const average = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length;
        let etaSeconds: number | null = null;
        if (allTimes.length) {
          const overall = average(allTimes);
          etaSeconds = (total - largeDone) * (times["large-v3"]!.length ? average(times["large-v3"]!) : overall) + (total - mediumDone) * (times.medium!.length ? average(times.medium!) : overall);
          if (typeof pending.active_started === "number") etaSeconds -= Math.max(0, Date.now() / 1000 - pending.active_started);
          etaSeconds = Math.max(0, Math.ceil(etaSeconds));
        }
        batch = { total, largeDone, mediumDone, activeModel, etaSeconds };
      }
    } catch { /* worker may be starting or replacing its checkpoint */ }
    return { enabled: this.enabled(), running, checked, matched, error: this.error, progress: this.progress, batch };
  }
  setEnabled(enabled: boolean): AuditStatus {
    mkdirSync(this.root, { recursive: true });
    const temp = `${this.settings}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify({ enabled }), "utf8");
    renameSync(temp, this.settings);
    this.error = null;
    if (!enabled && this.child) { this.cancelled.add(this.child); this.child.kill(); }
    else this.kick();
    return this.status();
  }
  start(): void { this.stopped = false; this.kick(); }
  stop(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = null; if (this.child) { this.cancelled.add(this.child); this.child.kill(); } }
  private releaseLock(): void {
    try {
      const owner = JSON.parse(readFileSync(this.lock, "utf8")) as { owner?: number };
      if (owner.owner === process.pid) unlinkSync(this.lock);
    } catch { /* already gone */ }
  }
  private claimLock(): boolean {
    try {
      if (existsSync(this.lock)) {
        const data = JSON.parse(readFileSync(this.lock, "utf8")) as { owner?: number; worker?: number };
        if (alive(data.owner) || alive(data.worker)) return false;
        unlinkSync(this.lock);
      }
      const fd = openSync(this.lock, "wx");
      try { writeFileSync(fd, JSON.stringify({ owner: process.pid })); } finally { closeSync(fd); }
      return true;
    } catch { return false; }
  }
  private kick(): void {
    if (this.stopped || this.child || !this.enabled() || this.error) return;
    const status = this.status();
    if (this.error) return;
    if ((this.remaining?.() ?? status.matched) >= AUDIT_STOCK_CEILING) {
      this.progress = `${AUDIT_STOCK_CEILING} unused checked recordings are ready; checks continue as they are used`;
      this.timer = setTimeout(() => { this.timer = null; this.kick(); }, 60_000);
      this.timer.unref();
      return;
    }
    const dataset = path.join(this.projectRoot, "data", "Common Voice Mozilla", "commonvoice-v24_en-AU");
    const script = path.join(this.projectRoot, "scripts", "dictation-real-audit.py");
    if (!existsSync(path.join(dataset, "commonvoice-v24_en-AU.csv")) || !existsSync(script)) { this.error = "Common Voice dataset or audit script is missing."; return; }
    mkdirSync(this.batches, { recursive: true });
    const probe = process.platform === "win32" ? spawnSync("py", ["-3.11", "-c", "import sys; print(sys.executable)"], { encoding: "utf8", windowsHide: true }) : spawnSync("python3.11", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" });
    const python = probe.status === 0 ? probe.stdout.trim() : "";
    if (!python) { this.error = "Python 3.11 is unavailable."; return; }
    if (!this.claimLock()) {
      this.progress = "Waiting for another audit to finish";
      this.timer = setTimeout(() => { this.timer = null; this.kick(); }, 60_000);
      this.timer.unref();
      return;
    }
    this.progress = "Starting CPU checks";
    const child = spawn(python, [script, dataset, "--count", "10", "--seed", "425", "--verify", "--output", this.pending, "--exclude-reviewed", path.join(this.root, "..", "reviewed.json"), "--exclude-batches", this.batches, "--metadata-index", path.join(this.root, "source-metadata.json")], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HF_HUB_OFFLINE: "1", PYTHONUNBUFFERED: "1" } });
    this.child = child;
    if (child.pid) writeFileSync(this.lock, JSON.stringify({ owner: process.pid, worker: child.pid }), "utf8");
    let stderr = "";
    child.stdout?.on("data", (data: Buffer) => { const lines = data.toString().trim().split(/\r?\n/); this.progress = lines[lines.length - 1] ?? null; });
    child.stderr?.on("data", (data: Buffer) => { stderr = (stderr + data.toString()).slice(-4000); });
    child.once("error", (err) => { this.error = `Could not start audit: ${err.message}`; });
    child.once("close", (code) => {
      this.child = null;
      this.progress = null;
      this.releaseLock();
      if (this.cancelled.has(child)) { if (!this.stopped && this.enabled()) this.kick(); return; }
      if (this.stopped || !this.enabled()) return;
      if (code !== 0) { this.error = `Audit failed: ${stderr.trim().split(/\r?\n/).pop() || `exit ${code}`}`; return; }
      try {
        const batch = JSON.parse(readFileSync(this.pending, "utf8")) as Batch;
        if (!batch.clips?.length) { this.error = "No more eligible recordings were found."; return; }
        if (!batch.asr_checks_completed) throw new Error("Incomplete audit batch");
        renameSync(this.pending, path.join(this.batches, `batch-${randomUUID()}.json`));
      } catch (err) { this.error = `Could not save audit batch: ${(err as Error).message}`; return; }
      this.timer = setTimeout(() => { this.timer = null; this.kick(); }, 1000);
      this.timer.unref();
    });
  }
}
