import { beforeEach, describe, expect, it, vi } from "vitest";

// Session issuance and revocation serialize on the users row (SELECT ... FOR NO KEY UPDATE) inside a
// transaction and record each refresh token's generation. These tests script a fake pg client
// to check the SQL protocol directly.

vi.mock("../src/db/pool.js", async () => {
  const { fakeTransaction } = await import("./fake-transaction.js");
  return { query: vi.fn(), ...fakeTransaction(() => fakeClient) };
});

import { issueSession, revokeUserCredentials, SessionRevokedError } from "../src/auth/session.js";

const log = [];
let lockedVersion = 0;
const fakeClient = {
  query: vi.fn(async (sql, params) => {
    log.push(sql);
    if (sql.includes("SELECT session_version FROM users")) {
      return { rows: lockedVersion === null ? [] : [{ session_version: lockedVersion }] };
    }
    if (sql.includes("session_version + 1")) {
      lockedVersion += 1;
      return { rows: [{ session_version: lockedVersion }] };
    }
    if (sql.includes("INSERT INTO refresh_tokens")) {
      return { rows: [], rowCount: Number(params[3]) === lockedVersion ? 1 : 0 };
    }
    return { rows: [] };
  }),
  release: vi.fn()
};

const user = { id: "u1", email: "u@x.com", session_version: 0 };
const membership = { teamId: "t1", role: "owner" };
const idx = (needle) => log.findIndex((sql) => sql.includes(needle));

describe("issueSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    log.length = 0;
    lockedVersion = 0;
  });

  it("locks the users row, then stores the refresh token with its generation, in one transaction", async () => {
    const tokens = await issueSession(user, membership);
    expect(tokens.refreshToken).toEqual(expect.any(String));
    expect(log[0]).toBe("BEGIN");
    expect(log[1]).toBe("SELECT session_version FROM users WHERE id = $1 FOR NO KEY UPDATE");
    const insert = fakeClient.query.mock.calls.find(([sql]) =>
      sql.includes("INSERT INTO refresh_tokens")
    );
    expect(insert[0]).toContain("(user_id, token_hash, expires_at, session_version)");
    expect(insert[0]).toContain("session_version = $4");
    expect(insert[1][3]).toBe(0);
    expect(log.at(-1)).toBe("COMMIT");
    expect(fakeClient.release).toHaveBeenCalledOnce();
  });

  it("refuses when the row lock reveals a newer generation (a revocation committed meanwhile)", async () => {
    // The issuing request minted for generation 0; it waited on the row lock behind a
    // revocation, which committed generation 1 and deleted every refresh token.
    lockedVersion = 1;
    await expect(issueSession(user, membership)).rejects.toBeInstanceOf(SessionRevokedError);
    expect(log.some((sql) => sql.includes("INSERT INTO refresh_tokens"))).toBe(false);
    expect(log.at(-1)).toBe("ROLLBACK");
    expect(fakeClient.release).toHaveBeenCalledOnce();
  });

  it("refuses for a user that no longer exists", async () => {
    lockedVersion = null;
    await expect(issueSession(user, membership)).rejects.toBeInstanceOf(SessionRevokedError);
  });

  it("uses the caller's transaction when given one, without committing it", async () => {
    await issueSession(user, membership, fakeClient);
    expect(log[0]).toBe("SELECT session_version FROM users WHERE id = $1 FOR NO KEY UPDATE");
    expect(log).not.toContain("BEGIN");
    expect(log).not.toContain("COMMIT");
    expect(fakeClient.release).not.toHaveBeenCalled();
  });
});

describe("revokeUserCredentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    log.length = 0;
    lockedVersion = 0;
  });

  it("takes the row lock before bumping the generation and deleting refresh tokens", async () => {
    const revoked = await revokeUserCredentials("u1", fakeClient);
    expect(revoked.sessionVersion).toBe(1);
    expect(idx("FOR NO KEY UPDATE")).toBe(0);
    expect(idx("FOR NO KEY UPDATE")).toBeLessThan(idx("session_version + 1"));
    expect(idx("session_version + 1")).toBeLessThan(idx("DELETE FROM refresh_tokens"));
  });

  it("returns only the new generation", async () => {
    expect(await revokeUserCredentials("u1", fakeClient)).toEqual({ sessionVersion: 1 });
  });

  it("without a client, commits the bump and the refresh-token delete in one transaction", async () => {
    const revoked = await revokeUserCredentials("u1");
    expect(revoked.sessionVersion).toBe(1);
    expect(log[0]).toBe("BEGIN");
    expect(idx("session_version + 1")).toBeGreaterThan(0);
    expect(idx("DELETE FROM refresh_tokens")).toBeGreaterThan(idx("session_version + 1"));
    expect(log.at(-1)).toBe("COMMIT");
    expect(log.filter((sql) => sql === "COMMIT")).toHaveLength(1);
    expect(fakeClient.release).toHaveBeenCalledOnce();
  });

  it("with ifSessionVersion, revokes nothing once the generation has moved on", async () => {
    lockedVersion = 1;
    await expect(
      revokeUserCredentials("u1", fakeClient, { ifSessionVersion: 0 })
    ).rejects.toBeInstanceOf(SessionRevokedError);
    expect(log.some((sql) => sql.includes("session_version + 1"))).toBe(false);
    expect(log.some((sql) => sql.includes("DELETE FROM refresh_tokens"))).toBe(false);
    expect(lockedVersion).toBe(1);
  });
});
