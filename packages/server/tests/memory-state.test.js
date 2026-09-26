import { afterEach, describe, expect, it, vi } from "vitest";
import { createFixedWindowLimiter, createTtlStore } from "../src/state/memory.js";

afterEach(() => vi.useRealTimers());

describe("createTtlStore", () => {
  it("expires entries, and take() is single-use", () => {
    vi.useFakeTimers();
    const store = createTtlStore();
    store.set("a", 1, 1000);
    expect(store.take("a")).toBe(1);
    expect(store.take("a")).toBeUndefined();
    store.set("b", 2, 1000);
    vi.advanceTimersByTime(1001);
    expect(store.get("b")).toBeUndefined();
  });
});

describe("createFixedWindowLimiter", () => {
  it("allows `limit` hits per window and resets after it", () => {
    vi.useFakeTimers();
    const limiter = createFixedWindowLimiter();
    expect([1, 2, 3].map(() => limiter.hit("ip", 2, 1000))).toEqual([true, true, false]);
    vi.advanceTimersByTime(999);
    expect(limiter.hit("ip", 2, 1000)).toBe(false);
    vi.advanceTimersByTime(2);
    expect(limiter.hit("ip", 2, 1000)).toBe(true);
  });
});
