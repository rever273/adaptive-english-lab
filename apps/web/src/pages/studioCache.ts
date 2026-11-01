import { fetchContentStock, fetchCoverage, fetchStudioBatches, fetchVocabCoverage } from "../api";

/** One in-memory snapshot and one in-flight request; failures never erase the last good data. */
export class StudioCache<T> {
  private value: T | null = null;
  private fetchedAt = 0;
  private pending: Promise<T> | null = null;
  constructor(private readonly fetcher: () => Promise<T>, private readonly ttl: number) {}
  peek(): T | null { return this.value; }
  async get(force = false): Promise<T> {
    if (this.pending) return this.pending;
    if (!force && this.value !== null && Date.now() - this.fetchedAt < this.ttl) return this.value;
    this.pending = this.fetcher().then(value => { this.value = value; this.fetchedAt = Date.now(); return value; }).finally(() => { this.pending = null; });
    return this.pending;
  }
}

export const batchCache = new StudioCache(fetchStudioBatches, 5_000);
export const coverageCache = new StudioCache(fetchCoverage, 30_000);
export const stockCache = new StudioCache(fetchContentStock, 30_000);
export const vocabCoverageCache = new StudioCache(fetchVocabCoverage, 10_000);
