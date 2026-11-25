/** Ephemeral five-second snapshots for the currently open Books level. */
export interface BookSpeedSample { elapsedMs: number; intervalMs: number; wpm: number; errors: number }
type Counters = { charsTyped: number; errorCount: number };
export class BookSpeedSamples {
  private elapsed = 0;
  private lastTime = 0;
  private lastChars: number;
  private lastErrors: number;
  private samples: BookSpeedSample[] = [];
  private lastSampleCorrect = 0;
  constructor(initial: Counters) { this.lastChars = initial.charsTyped; this.lastErrors = initial.errorCount; }
  advance(dt: number, counters: Counters) {
    this.elapsed += Math.max(0, dt);
    if (this.elapsed - this.lastTime >= 5000) this.capture(counters);
  }
  finish(counters: Counters): BookSpeedSample[] {
    if (this.elapsed > this.lastTime || counters.charsTyped !== this.lastChars || counters.errorCount !== this.lastErrors) this.capture(counters, true);
    return this.samples.map((s) => ({ ...s }));
  }
  private capture(counters: Counters, final = false) {
    const intervalMs = this.elapsed - this.lastTime;
    const errors = Math.max(0, counters.errorCount - this.lastErrors);
    const correct = Math.max(0, counters.charsTyped - this.lastChars - errors);
    const previous = this.samples.at(-1);
    if (final && intervalMs < 1000) {
      if (previous) {
        const combinedMs = this.elapsed - (previous.elapsedMs - previous.intervalMs);
        const combinedCorrect = this.lastSampleCorrect + correct;
        previous.elapsedMs = Math.round(this.elapsed);
        previous.intervalMs = Math.round(combinedMs);
        previous.errors += errors;
        previous.wpm = Math.round((combinedCorrect / 5) * (60000 / combinedMs) * 10) / 10;
        this.lastSampleCorrect = combinedCorrect;
      }
      this.lastTime = this.elapsed; this.lastChars = counters.charsTyped; this.lastErrors = counters.errorCount;
      return;
    }
    this.samples.push({ elapsedMs: Math.round(this.elapsed), intervalMs: Math.round(intervalMs), wpm: intervalMs > 0 ? Math.round((correct / 5) * (60000 / intervalMs) * 10) / 10 : 0, errors });
    this.lastSampleCorrect = correct;
    this.lastTime = this.elapsed; this.lastChars = counters.charsTyped; this.lastErrors = counters.errorCount;
  }
}
