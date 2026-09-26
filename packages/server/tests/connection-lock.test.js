import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
// Intuit app keys come from the environment (Cloud mode in tests).
vi.stubEnv("QBO_CLIENT_ID", "client-id");
vi.stubEnv("QBO_CLIENT_SECRET", "client-secret");
const CREDS = { clientId: "client-id", clientSecret: "client-secret" };
const loggerMock = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };

// Capture the config passed to QboClient so we can drive its onTokenRefresh.
const qboClientInstances = [];

vi.mock("../src/db/pool.js", () => ({
  query: (...args) => queryMock(...args)
}));

vi.mock("../src/logger.js", () => ({
  logger: loggerMock
}));

vi.mock("../src/crypto/tokens.js", () => ({
  decryptTokenPair: () => ({ accessToken: "plain-access", refreshToken: "plain-refresh" }),
  encryptTokenPair: () => ({
    access_token_enc: "new-access-enc",
    refresh_token_enc: "new-refresh-enc",
    token_iv: "new-iv"
  })
}));

vi.mock("@easytestdata/qbo-client", () => ({
  QboClient: class {
    constructor(cfg) {
      this.cfg = cfg;
      qboClientInstances.push(this);
    }
  }
}));

const {
  acquireConnectionLock,
  releaseConnectionLock,
  withConnectionLock,
  withLockedConnection,
  buildLockedQboClient,
  ConnectionLockBusyError
} = await import("../src/services/connection-lock.js");

const CONN = {
  id: "11111111-1111-1111-1111-111111111111",
  realm_id: "realm-1",
  base_url: "https://sandbox-quickbooks.api.intuit.com",
  access_token_enc: "old-access-enc",
  refresh_token_enc: "old-refresh-enc",
  token_iv: "old-iv"
};

describe("connection-lock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    qboClientInstances.length = 0;
  });

  it("serializes holders of one connection and only the owner releases it", async () => {
    const a = await acquireConnectionLock("c1");
    await expect(acquireConnectionLock("c1")).rejects.toBeInstanceOf(ConnectionLockBusyError);
    await releaseConnectionLock({ connectionId: "c1", token: "not-mine" });
    await expect(acquireConnectionLock("c1")).rejects.toBeInstanceOf(ConnectionLockBusyError);
    await releaseConnectionLock(a);
    await releaseConnectionLock(await acquireConnectionLock("c1"));
  });

  it("waits up to waitMs for a releasing holder", async () => {
    const a = await acquireConnectionLock("c2");
    setTimeout(() => releaseConnectionLock(a), 30);
    const b = await acquireConnectionLock("c2", { waitMs: 500, retryDelayMs: 10 });
    await releaseConnectionLock(b);
  });

  it("releases the lock even when the wrapped function throws", async () => {
    await expect(
      withConnectionLock(CONN.id, async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    // Released: the connection can be locked again at once.
    await releaseConnectionLock(await acquireConnectionLock(CONN.id));
  });

  it("persists refreshed tokens with a compare-and-swap on the original ciphertext", async () => {
    queryMock.mockResolvedValue({ rowCount: 1 });
    buildLockedQboClient(CONN, CREDS);
    const { onTokenRefresh } = qboClientInstances[0].cfg;

    await onTokenRefresh({ accessToken: "a", refreshToken: "r" });

    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("UPDATE qbo_connections");
    expect(sql).toContain("WHERE id = $4 AND refresh_token_enc = $5");
    expect(params).toEqual([
      "new-access-enc",
      "new-refresh-enc",
      "new-iv",
      CONN.id,
      "old-refresh-enc" // CAS guard = the ciphertext read when the client was built
    ]);
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it("warns and does not throw when the CAS matches zero rows (lost race)", async () => {
    queryMock.mockResolvedValue({ rowCount: 0 });
    buildLockedQboClient(CONN, CREDS);
    const { onTokenRefresh } = qboClientInstances[0].cfg;

    await expect(onTokenRefresh({ accessToken: "a", refreshToken: "r" })).resolves.toBeUndefined();
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
  });

  it("advances the CAS guard so repeated refreshes by the same client keep persisting", async () => {
    queryMock.mockResolvedValue({ rowCount: 1 });
    buildLockedQboClient(CONN, CREDS);
    const { onTokenRefresh } = qboClientInstances[0].cfg;

    await onTokenRefresh({ accessToken: "a1", refreshToken: "r1" });
    await onTokenRefresh({ accessToken: "a2", refreshToken: "r2" });

    // First refresh guards on the original ciphertext read at build time...
    expect(queryMock.mock.calls[0][1][4]).toBe("old-refresh-enc");
    // ...the second guards on what the first write persisted (mock encrypt output),
    // instead of colliding with the original and being dropped as a CAS miss.
    expect(queryMock.mock.calls[1][1][4]).toBe("new-refresh-enc");
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it("withLockedConnection re-reads the row under the lock and builds from it", async () => {
    const freshRow = { ...CONN, refresh_token_enc: "fresher-enc" };
    queryMock.mockResolvedValue({ rows: [freshRow] });
    const received = vi.fn();

    await withLockedConnection(CONN.id, async ({ client, conn }) => {
      await expect(acquireConnectionLock(CONN.id)).rejects.toBeInstanceOf(ConnectionLockBusyError);
      received({ hasClient: !!client, conn });
    });

    // The row is re-read by id while the lock is held.
    expect(queryMock).toHaveBeenCalledWith("SELECT * FROM qbo_connections WHERE id = $1", [
      CONN.id
    ]);
    expect(received).toHaveBeenCalledWith({ hasClient: true, conn: freshRow });
    // The client is built with the Intuit app keys.
    expect(qboClientInstances[0].cfg).toMatchObject({
      qboClientId: "client-id",
      qboClientSecret: "client-secret"
    });
  });

  it("withLockedConnection refuses with QBO_NOT_CONFIGURED when no Intuit keys are set", async () => {
    vi.stubEnv("QBO_CLIENT_ID", "");
    try {
      const fn = vi.fn();
      await expect(withLockedConnection(CONN.id, fn)).rejects.toMatchObject({
        statusCode: 503,
        code: "QBO_NOT_CONFIGURED"
      });
      expect(fn).not.toHaveBeenCalled();
      // Never took the lock.
      await releaseConnectionLock(await acquireConnectionLock(CONN.id));
    } finally {
      vi.stubEnv("QBO_CLIENT_ID", "client-id");
    }
  });

  it("withLockedConnection throws when the connection no longer exists", async () => {
    queryMock.mockResolvedValue({ rows: [] });

    await expect(withLockedConnection(CONN.id, async () => {})).rejects.toThrow(
      "QBO connection not found"
    );
    // The lock was still released despite the throw.
    await releaseConnectionLock(await acquireConnectionLock(CONN.id));
  });
});
