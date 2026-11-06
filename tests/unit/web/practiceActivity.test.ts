import { describe, expect, it } from "vitest";
import { activeInterval, IDLE_MS } from "../../../apps/web/src/practiceActivity";

describe("active practice time", () => {
  it("records visible time, cuts off idle time and stops when hidden", () => {
    expect(activeInterval(1000, 6000, 5000, 1000, true)).toEqual({ startMs: 1000, endMs: 6000 });
    expect(activeInterval(IDLE_MS - 2000, IDLE_MS + 3000, 5000, 0, true)).toEqual({ startMs: IDLE_MS - 2000, endMs: IDLE_MS });
    expect(activeInterval(IDLE_MS, IDLE_MS + 5000, 5000, 0, true)).toBeNull();
    expect(activeInterval(1000, 6000, 5000, 1000, false)).toBeNull();
  });
  it("does not count suspended timers or wall clock jumps", () => {
    expect(activeInterval(1000, 12000, 11000, 1000, true)).toBeNull();
    expect(activeInterval(1000, 6000, 100, 1000, true)).toBeNull();
    expect(activeInterval(1000, 500, 500, 1000, true)).toBeNull();
  });
});
