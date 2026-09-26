import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();

vi.mock("../src/db/pool.js", () => ({
  query: (...args) => queryMock(...args)
}));

import { requireAdmin } from "../src/routes/admin/middleware.js";
import { userRoutes } from "../src/routes/admin/users.js";

function makeApp(user, { gated = true } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = user;
    next();
  });
  // The admin router applies requireAdmin to every admin route (routes/admin/index.js).
  if (gated) app.use(requireAdmin);
  app.use("/admin/users", userRoutes());
  return app;
}

const admin = { id: "admin-1", isAdmin: true };
const nonAdmin = { id: "user-1", isAdmin: false };

describe("admin user routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryMock.mockResolvedValue({ rows: [{ id: "target-user" }] });
  });

  it.each([
    ["post", "/admin/users/target-user/suspend"],
    ["post", "/admin/users/target-user/unsuspend"],
    ["post", "/admin/users/target-user/revoke-sessions"],
    ["get", "/admin/users/export"]
  ])("refuses non-admins: %s %s", async (method, path) => {
    const res = await request(makeApp(nonAdmin))[method](path).send({});
    expect(res.status).toBe(403);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("gates the user export in its own handler, not only at the admin router", async () => {
    const res = await request(makeApp(nonAdmin, { gated: false })).get("/admin/users/export");
    expect(res.status).toBe(403);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("serves a user's detail to an admin", async () => {
    queryMock.mockResolvedValue({ rows: [{ id: "target-user", email: "t@x.com" }] });
    const res = await request(makeApp(admin)).get("/admin/users/target-user");
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: "target-user" });
  });

  it("suspending a user records the suspension", async () => {
    const res = await request(makeApp(admin))
      .post("/admin/users/target-user/suspend")
      .send({ reason: "abuse" });
    expect(res.status).toBe(200);
    const [sql, params] = queryMock.mock.calls.find(([q]) => q.includes("suspended_at = NOW()"));
    expect(sql).toContain("UPDATE users");
    expect(params).toEqual(["abuse", "admin-1", "target-user"]);
  });
});
