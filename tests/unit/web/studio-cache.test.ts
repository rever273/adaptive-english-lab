import { afterEach, describe, expect, it, vi } from "vitest";
import { StudioCache } from "../../../apps/web/src/pages/studioCache.js";

afterEach(() => vi.useRealTimers());
describe("Content Studio memory cache", () => {
  it("reuses a snapshot, refreshes when stale and keeps it after an error", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const fetcher = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2).mockRejectedValueOnce(new Error("offline"));
    const cache = new StudioCache(fetcher, 100);
    expect(cache.peek()).toBeNull();
    expect(await cache.get()).toBe(1);
    expect(await cache.get()).toBe(1); expect(fetcher).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(101);
    expect(await cache.get()).toBe(2);
    await expect(cache.get(true)).rejects.toThrow("offline"); expect(cache.peek()).toBe(2);
  });
  it("shares an in-flight request between callers", async () => {
    let finish!: (v: number) => void;
    const fetcher = vi.fn(() => new Promise<number>(resolve => { finish = resolve; }));
    const cache = new StudioCache(fetcher, 1000);
    const a = cache.get(), b = cache.get();
    expect(fetcher).toHaveBeenCalledTimes(1); finish(7);
    expect(await Promise.all([a, b])).toEqual([7, 7]);
  });
});
