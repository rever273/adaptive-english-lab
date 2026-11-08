/** Ephemeral five-second snapshots for the currently open Books level. */
export interface BookSpeedSample { elapsedMs: number; intervalMs: number; wpm: number; errors: number }
type Counters = { charsTyped: number; errorCount: number };
export class BookSpeedSamples {
  private elapsed = 0;
  private lastTime = 0;
  private lastChars: number;
  private lastErrors: number;
  private samples: BookSpeedSample[] = [];
  constructor(initial: Counters) { this.lastChars = initial.charsTyped; this.lastErrors = initial.errorCount; }
  advance(dt: number, counters: Counters) {
    this.elapsed += Math.max(0, dt);
    if (this.elapsed - this.lastTime >= 5000) this.capture(counters);
  }
  finish(counters: Counters): BookSpeedSample[] {
    if (this.elapsed > this.lastTime || counters.charsTyped !== this.lastChars || counters.errorCount !== this.lastErrors) this.capture(counters);
    return this.samples.map((s) => ({ ...s }));
  }
  private capture(counters: Counters) {
    const intervalMs = this.elapsed - this.lastTime;
    const errors = Math.max(0, counters.errorCount - this.lastErrors);
    const correct = Math.max(0, counters.charsTyped - this.lastChars - errors);
    this.samples.push({ elapsedMs: Math.round(this.elapsed), intervalMs: Math.round(intervalMs), wpm: intervalMs > 0 ? Math.round((correct / 5) * (60000 / intervalMs) * 10) / 10 : 0, errors });
    this.lastTime = this.elapsed; this.lastChars = counters.charsTyped; this.lastErrors = counters.errorCount;
  }
}
