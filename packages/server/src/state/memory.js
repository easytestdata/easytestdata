/** A Map with per-entry expiry; take() reads and deletes in one step (single-use values). */
export function createTtlStore() {
  const entries = new Map();
  const live = (key) => {
    const entry = entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  };
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of entries) if (entry.expiresAt <= now) entries.delete(key);
  }, 60_000);
  sweeper.unref?.();
  return {
    set(key, value, ttlMs) {
      entries.set(key, { value, expiresAt: Date.now() + ttlMs });
    },
    get: (key) => live(key)?.value,
    take(key) {
      const entry = live(key);
      entries.delete(key);
      return entry?.value;
    },
    delete: (key) => entries.delete(key),
    clear: () => entries.clear()
  };
}

/** Fixed-window counters; hits never extend a window. */
export function createFixedWindowLimiter() {
  const windows = new Map();
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, window] of windows) if (window.resetAt <= now) windows.delete(key);
  }, 60_000);
  sweeper.unref?.();
  return {
    hit(key, limit, windowMs) {
      const now = Date.now();
      let window = windows.get(key);
      if (!window || window.resetAt <= now) {
        window = { count: 0, resetAt: now + windowMs };
        windows.set(key, window);
      }
      window.count += 1;
      return window.count <= limit;
    },
    clear: () => windows.clear()
  };
}

export const oauthStates = createTtlStore();
export const oauthCodes = createTtlStore();

export const rateLimits = createFixedWindowLimiter();
