import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/db/pool.js", () => ({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }));
// adminRoutes() mounts authenticate itself (routes/admin/index.js); pass the stub user through.
vi.mock("../src/middleware/auth.js", async (orig) => ({
  ...(await orig()),
  authenticate: (_q, _s, n) => n()
}));

function appWith(
  path,
  routerFactory,
  user = { id: "a", teamId: "t", role: "owner", isAdmin: true }
) {
  return express()
    .use(express.json())
    .use((req, _res, next) => ((req.user = user), next()))
    .use(path, routerFactory());
}

describe("admin area", () => {
  it("refuses non-admins", async () => {
    const { adminRoutes } = await import("../src/routes/admin/index.js");
    const user = { id: "u", teamId: "t", role: "owner", isAdmin: false };
    expect((await request(appWith("/admin", adminRoutes, user)).get("/admin/users")).status).toBe(
      403
    );
  });
});
