import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The row-lock table in AGENTS.md ("Row-lock order"): every lock clause in the server's SQL, the
// table it locks and its mode. The connection paths lock teams, then the connection, then the
// membership row, and never the users row; the session paths lock the users row, then its
// tokens. State locks are FOR NO KEY UPDATE, so a foreign-key KEY SHARE (a job, membership or
// token insert) never waits on them or closes a cycle. A lock this test does not know is a new
// path to fit into the order (or a regression to FOR UPDATE / a users-row share lock).

const SRC = new URL("../src/", import.meta.url).pathname;

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith(".js") ? [path] : [];
  });
}

/** Every lock clause in `source`, with the table of the nearest preceding FROM. */
function lockClauses(source) {
  const found = [];
  const clause = /FOR (?:NO KEY UPDATE|KEY SHARE|UPDATE|SHARE)(?: OF \w+)?/g;
  for (const match of source.matchAll(clause)) {
    const before = source.slice(0, match.index);
    // Comment lines describe the rule; only SQL counts.
    const line = before.slice(before.lastIndexOf("\n") + 1);
    if (/^\s*(\*|\/\/)/.test(line)) continue;
    const from = [...before.matchAll(/FROM (\w+)/g)].at(-1);
    found.push({ table: from?.[1] ?? null, clause: match[0] });
  }
  return found;
}

describe("row-lock order", () => {
  it("locks only the rows the order allows, in the modes it allows", () => {
    const locks = [];
    for (const file of walk(SRC)) {
      for (const lock of lockClauses(readFileSync(file, "utf8"))) {
        locks.push({ file: file.slice(SRC.length), ...lock });
      }
    }
    locks.sort((a, b) =>
      `${a.file}${a.table}${a.clause}`.localeCompare(`${b.file}${b.table}${b.clause}`)
    );

    expect(locks).toEqual(
      [
        // Session paths: the users row, before its tokens.
        { file: "auth/session.js", table: "users", clause: "FOR NO KEY UPDATE" },
        { file: "local/identity.js", table: "users", clause: "FOR NO KEY UPDATE" },
        { file: "routes/auth.js", table: "users", clause: "FOR NO KEY UPDATE" },
        // Invites: the team's advisory lock, then the invite row.
        { file: "routes/teams.js", table: "team_invites", clause: "FOR UPDATE" },
        // Connection paths: team, then connection, then the membership row (never users).
        { file: "services/connection-guard.js", table: "teams", clause: "FOR NO KEY UPDATE" },
        {
          file: "services/connection-guard.js",
          table: "qbo_connections",
          clause: "FOR NO KEY UPDATE"
        },
        {
          file: "services/connection-guard.js",
          table: "qbo_connections",
          clause: "FOR NO KEY UPDATE"
        },
        { file: "services/connection-guard.js", table: "team_members", clause: "FOR SHARE OF tm" }
      ].sort((a, b) =>
        `${a.file}${a.table}${a.clause}`.localeCompare(`${b.file}${b.table}${b.clause}`)
      )
    );
  });

  it("never locks the users row on a connection path", async () => {
    const { lockConnectingMember, lockTeam, lockConnection } =
      await import("../src/services/connection-guard.js");
    const sql = [];
    const client = { query: async (text) => (sql.push(text), { rows: [{ id: "c1" }] }) };
    await lockTeam(client, "t1");
    await lockConnection(client, { connectionId: "c1", teamId: "t1" });
    await lockConnectingMember(client, { teamId: "t1", userId: "u1" });
    for (const text of sql) {
      expect(text).not.toMatch(/FOR UPDATE/);
      if (/FROM users|JOIN users/.test(text)) expect(text).toMatch(/FOR SHARE OF tm/);
    }
    // The membership check reads the users row (suspension) without locking it.
    const member = sql.find((text) => text.includes("team_members tm"));
    expect(member).toMatch(/FOR SHARE OF tm$/);
    expect(member).not.toMatch(/FOR SHARE OF u|FOR SHARE$/m);
  });
});
