import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Re-inviting a pending address on the real schema (embedded PGlite): the new link carries the
// role just chosen and a full expiry, never the old invite's.
const dir = mkdtempSync(join(tmpdir(), "eztd-teams-invite-pglite-"));
vi.stubEnv("DEPLOYMENT", "local");
vi.stubEnv("EASYTESTDATA_DATA_DIR", dir);

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));
const who = vi.hoisted(() => ({ user: null }));
vi.mock("../src/middleware/auth.js", () => ({
  authenticate: (req, _res, next) => {
    req.user = who.user;
    next();
  }
}));

const db = await import("../src/db/pool.js");
const { runMigrations } = await import("../src/db/migrate.js");
const { teamRoutes } = await import("../src/routes/teams.js");
const { config } = await import("../src/config.js");
const app = express().use(express.json()).use("/api/v1/teams", teamRoutes());

let teamId;

describe("re-inviting a pending address", () => {
  beforeAll(async () => {
    await runMigrations({ closePool: false });
    teamId = (await db.query("INSERT INTO teams (name) VALUES ('t') RETURNING id")).rows[0].id;
    const ownerId = (
      await db.query("INSERT INTO users (email) VALUES ('owner@example.com') RETURNING id")
    ).rows[0].id;
    await db.query("INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'owner')", [
      teamId,
      ownerId
    ]);
    who.user = { id: ownerId, teamId, role: "owner" };
  }, 60_000);
  afterAll(async () => {
    await db.closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });

  const invite = (role) =>
    request(app).post(`/api/v1/teams/${teamId}/invites`).send({ email: "new@example.com", role });

  it("updates the role and restarts the expiry along with the token", async () => {
    const first = await invite("admin");
    expect(first.status).toBe(201);
    // The first link is about to expire.
    await db.query("UPDATE team_invites SET expires_at = NOW() + INTERVAL '1 hour'");

    const before = Date.now();
    const again = await invite("member");
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ id: first.body.id, role: "member", alreadyPending: true });
    expect(again.body.inviteUrl).not.toBe(first.body.inviteUrl);

    const { rows } = await db.query("SELECT role, expires_at FROM team_invites");
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe("member");
    const expiresIn = new Date(rows[0].expires_at).getTime() - before;
    expect(expiresIn).toBeGreaterThan(config.tokens.teamInviteTtlMs - 60_000);
    expect(new Date(again.body.expires_at).getTime()).toBe(new Date(rows[0].expires_at).getTime());
  });
});
