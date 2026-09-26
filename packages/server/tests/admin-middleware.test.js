import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createMockAdmin } from "./utils.js";

import { requireAdmin } from "../src/routes/admin/middleware.js";

function makeApp(user) {
  const app = express();
  app.use((req, _res, next) => {
    req.user = user;
    next();
  });
  app.get("/admin", requireAdmin, (_req, res) => res.json({ ok: true }));
  return app;
}

describe("requireAdmin", () => {
  it("lets users with the admin flag through", async () => {
    const res = await request(makeApp(createMockAdmin())).get("/admin");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it.each([
    ["isAdmin false", { isAdmin: false }],
    ["isAdmin missing", { isAdmin: undefined }],
    ["isAdmin truthy but not true", { isAdmin: "true" }]
  ])("refuses a user with %s", async (_label, overrides) => {
    const res = await request(makeApp(createMockAdmin(overrides))).get("/admin");
    expect(res.status).toBe(403);
  });

  it("refuses a request with no user", async () => {
    const res = await request(makeApp(undefined)).get("/admin");
    expect(res.status).toBe(403);
  });
});
