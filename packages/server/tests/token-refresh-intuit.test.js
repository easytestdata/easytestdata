import { createRequire } from "module";
import path from "path";
import { pathToFileURL } from "url";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The daily keepalive against the real QboClient and token crypto; only the database and the
// Intuit token endpoint (axios.post, as QboClient calls it) are faked.
vi.stubEnv("QBO_CLIENT_ID", "client-id");
vi.stubEnv("QBO_CLIENT_SECRET", "client-secret");
vi.stubEnv("TOKEN_ENCRYPTION_KEY", "cd".repeat(32));

const queryMock = vi.fn();
vi.mock("../src/db/pool.js", () => ({ query: (...a) => queryMock(...a) }));
vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

// The axios instance qbo-client itself imports (the same module file, so the spy is shared).
const requireFromQbo = createRequire(new URL("../../qbo-client/package.json", import.meta.url));
const axiosDir = path.dirname(requireFromQbo.resolve("axios/package.json"));
const { default: axios } = await import(pathToFileURL(path.join(axiosDir, "index.js")).href);

const { encryptTokenPair, decryptTokenPair } = await import("../src/crypto/tokens.js");
const { refreshExpiringTokens } = await import("../src/workers/token-refresh.js");

const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

let row;

function fakeTable() {
  queryMock.mockImplementation(async (sql, params) => {
    if (sql.includes("WHERE id = $1") && sql.trim().startsWith("SELECT")) {
      return { rows: params[0] === row.id ? [{ ...row }] : [] };
    }
    if (sql.includes("FROM qbo_connections")) return { rows: [{ ...row }] };
    if (sql.includes("UPDATE qbo_connections")) {
      if (sql.includes("access_token_enc = $1")) {
        // The client's compare-and-swap persist.
        if (params[3] !== row.id || params[4] !== row.refresh_token_enc) return { rowCount: 0 };
        row = {
          ...row,
          access_token_enc: params[0],
          refresh_token_enc: params[1],
          token_iv: params[2],
          last_used_at: "now"
        };
        return { rowCount: 1 };
      }
      // The keepalive's own last_used_at touch for an unrotated token.
      if (params[0] !== row.id || params[1] !== row.refresh_token_enc) return { rowCount: 0 };
      row = { ...row, last_used_at: "now" };
      return { rowCount: 1 };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
}

describe("refreshExpiringTokens against the Intuit token endpoint", () => {
  let postSpy;

  beforeEach(() => {
    vi.clearAllMocks();
    postSpy?.mockRestore();
    postSpy = vi.spyOn(axios, "post");
    row = {
      id: "conn-1",
      company_name: "A",
      realm_id: "r1",
      base_url: "https://sandbox-quickbooks.api.intuit.com",
      last_used_at: "90 days ago",
      ...encryptTokenPair("old-access", "old-refresh")
    };
    fakeTable();
  });

  it("forces a refresh with Intuit and persists the rotated tokens", async () => {
    postSpy.mockResolvedValue({
      data: { access_token: "new-access", refresh_token: "new-refresh" }
    });

    const result = await refreshExpiringTokens({ busyRetryDelayMs: 0 });

    expect(result).toEqual({ refreshed: 1, failed: 0, skipped: 0 });
    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(postSpy.mock.calls[0][0]).toBe(TOKEN_URL);
    expect(postSpy.mock.calls[0][1]).toContain("refresh_token=old-refresh");
    const stored = decryptTokenPair(row.access_token_enc, row.refresh_token_enc, row.token_iv);
    expect(stored).toEqual({ accessToken: "new-access", refreshToken: "new-refresh" });
    expect(row.last_used_at).toBe("now");
  });

  it("records the activity when Intuit returns the same refresh token", async () => {
    postSpy.mockResolvedValue({
      data: { access_token: "new-access", refresh_token: "old-refresh" }
    });

    const result = await refreshExpiringTokens({ busyRetryDelayMs: 0 });

    expect(result).toEqual({ refreshed: 1, failed: 0, skipped: 0 });
    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(row.last_used_at).toBe("now");
  });

  it("reports a failure (not success) when the rotated token could not be persisted", async () => {
    postSpy.mockResolvedValue({
      data: { access_token: "new-access", refresh_token: "new-refresh" }
    });
    const base = queryMock.getMockImplementation();
    queryMock.mockImplementation(async (sql, params) => {
      if (sql.includes("access_token_enc = $1")) throw new Error("db down");
      return base(sql, params);
    });

    const result = await refreshExpiringTokens({ busyRetryDelayMs: 0 });

    expect(result).toEqual({ refreshed: 0, failed: 1, skipped: 0 });
    expect(row.last_used_at).toBe("90 days ago");
  });

  it("reports a failure when Intuit refuses the refresh", async () => {
    postSpy.mockRejectedValue(Object.assign(new Error("400"), { response: { status: 400 } }));

    const result = await refreshExpiringTokens({ busyRetryDelayMs: 0 });

    expect(result).toEqual({ refreshed: 0, failed: 1, skipped: 0 });
    expect(row.last_used_at).toBe("90 days ago");
  });
});
