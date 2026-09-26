import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
vi.stubEnv("QBO_CLIENT_ID", "client-id");
vi.stubEnv("QBO_CLIENT_SECRET", "client-secret");
const refreshAccessTokenMock = vi.fn();

vi.mock("../src/db/pool.js", () => ({ query: (...a) => queryMock(...a) }));
vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
vi.mock("../src/crypto/tokens.js", () => ({
  decryptTokenPair: () => ({ accessToken: "a", refreshToken: "r" }),
  encryptTokenPair: () => ({ access_token_enc: "e", refresh_token_enc: "e2", token_iv: "iv" })
}));
vi.mock("@easytestdata/qbo-client", () => ({
  // A `function`, not an arrow: Vitest 4+ calls the implementation with `new`.
  QboClient: vi.fn(function () {
    return { refreshAccessToken: (...a) => refreshAccessTokenMock(...a) };
  })
}));

const { refreshExpiringTokens } = await import("../src/workers/token-refresh.js");
const { acquireConnectionLock, releaseConnectionLock, ConnectionLockBusyError } =
  await import("../src/services/connection-lock.js");

const rows = [
  {
    id: "conn-1",
    company_name: "A",
    access_token_enc: "e",
    refresh_token_enc: "r",
    token_iv: "iv",
    realm_id: "r1",
    base_url: "u"
  },
  {
    id: "conn-2",
    company_name: "B",
    access_token_enc: "e",
    refresh_token_enc: "r",
    token_iv: "iv",
    realm_id: "r2",
    base_url: "u"
  }
];

describe("refreshExpiringTokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshAccessTokenMock.mockResolvedValue();
    queryMock.mockImplementation((sql, params) => {
      // Re-read under the lock (withLockedConnection) — return the matching row.
      if (sql.includes("WHERE id = $1")) {
        return Promise.resolve({ rows: rows.filter((r) => r.id === params[0]) });
      }
      // Upfront keepalive SELECT.
      if (sql.includes("FROM qbo_connections")) return Promise.resolve({ rows });
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
  });

  it("skips the run without touching any connection when no Intuit keys are set", async () => {
    vi.stubEnv("QBO_CLIENT_SECRET", "");
    try {
      await expect(refreshExpiringTokens({ busyRetryDelayMs: 0 })).resolves.toEqual({
        refreshed: 0,
        failed: 0,
        skipped: 0
      });
      expect(queryMock).not.toHaveBeenCalled();
      expect(refreshAccessTokenMock).not.toHaveBeenCalled();
    } finally {
      vi.stubEnv("QBO_CLIENT_SECRET", "client-secret");
    }
  });

  it("never picks a disconnected sandbox (it has no tokens)", async () => {
    await refreshExpiringTokens({ busyRetryDelayMs: 0 });
    const [sql] = queryMock.mock.calls.find(([q]) => q.includes("COALESCE(last_used_at"));
    expect(sql).toContain("disconnected_at IS NULL");
  });

  it("refreshes each expiring connection while holding its per-connection lock", async () => {
    const heldDuringRefresh = [];
    refreshAccessTokenMock.mockImplementation(async () => {
      for (const id of ["conn-1", "conn-2"]) {
        try {
          await releaseConnectionLock(await acquireConnectionLock(id));
        } catch (err) {
          if (err instanceof ConnectionLockBusyError) heldDuringRefresh.push(id);
        }
      }
    });

    const result = await refreshExpiringTokens();

    expect(result).toEqual({ refreshed: 2, failed: 0, skipped: 0 });
    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(2);
    // Each refresh ran under its own connection's lock ...
    expect(heldDuringRefresh).toEqual(["conn-1", "conn-2"]);
    // ... and both locks are released afterwards.
    await releaseConnectionLock(await acquireConnectionLock("conn-1"));
    await releaseConnectionLock(await acquireConnectionLock("conn-2"));
  });

  it("skips (does not fail or refresh) a connection whose lock is already held", async () => {
    const held = await acquireConnectionLock("conn-1");
    try {
      const result = await refreshExpiringTokens({ busyRetryDelayMs: 0 });

      expect(result).toEqual({ refreshed: 1, failed: 0, skipped: 1 });
      // Only the non-busy connection was refreshed.
      expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1);
    } finally {
      await releaseConnectionLock(held);
    }
  });

  it("retries a busy connection once and refreshes it when the lock has freed", async () => {
    // conn-1 is busy on the first pass and freed during the backoff; conn-2 is free.
    const held = await acquireConnectionLock("conn-1");
    setTimeout(() => releaseConnectionLock(held), 10);

    const result = await refreshExpiringTokens({ busyRetryDelayMs: 50 });

    expect(result).toEqual({ refreshed: 2, failed: 0, skipped: 0 });
    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(2);
  });

  it("refreshes no further connection once its signal aborts (the one in flight finishes)", async () => {
    const controller = new AbortController();
    // The server starts shutting down while conn-1's refresh is in flight with Intuit.
    refreshAccessTokenMock.mockImplementationOnce(async () => controller.abort());

    const result = await refreshExpiringTokens({ busyRetryDelayMs: 0, signal: controller.signal });

    expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ refreshed: 1, failed: 0, skipped: 1 });
  });

  it("ends the busy back-off at once when its signal aborts, refreshing nothing more", async () => {
    const controller = new AbortController();
    const held = await acquireConnectionLock("conn-1");
    try {
      const promise = refreshExpiringTokens({
        busyRetryDelayMs: 60_000,
        signal: controller.signal
      });
      setTimeout(() => controller.abort(), 10);
      const outcome = await Promise.race([
        promise,
        new Promise((r) => setTimeout(() => r("still backing off"), 1000))
      ]);

      expect(outcome).toEqual({ refreshed: 1, failed: 0, skipped: 1 });
      expect(refreshAccessTokenMock).toHaveBeenCalledTimes(1);
    } finally {
      await releaseConnectionLock(held);
    }
  });

  it("backs off before retrying busy connections", async () => {
    vi.useFakeTimers();
    try {
      const held = await acquireConnectionLock("conn-1");
      setTimeout(() => releaseConnectionLock(held), 4000);

      const promise = refreshExpiringTokens({ busyRetryDelayMs: 5000 });
      // Drive the scheduled backoff timer (and interleaved microtasks) to completion.
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toEqual({ refreshed: 2, failed: 0, skipped: 0 });
      expect(refreshAccessTokenMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
