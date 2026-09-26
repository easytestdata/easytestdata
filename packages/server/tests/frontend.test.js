import express from "express";
import request from "supertest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mountFrontend } from "../src/frontend.js";

let root;
let webDistDir;

function write(file, content) {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "etd-frontend-"));
  webDistDir = join(root, "web");
  write(join(webDistDir, "index.html"), "<html>spa</html>");
  write(join(webDistDir, "favicon.svg"), "<svg>web</svg>");
  write(join(webDistDir, "assets", "app-abc.js"), "console.log('app')");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function bodyOf(res) {
  return res.text ?? Buffer.from(res.body).toString("utf8");
}

function app() {
  const app = express();
  app.get("/api/v1/ping", (_req, res) => res.json({ ok: true }));
  mountFrontend(app, { webDistDir });
  app.use((_req, res) => res.status(404).json({ error: "not found" }));
  return app;
}

// The marketing site lives on its own host (MARKETING_URL); the server only serves the app.
describe("mountFrontend", () => {
  it("serves the SPA for / and any other non-API path", async () => {
    for (const path of ["/", "/features", "/blog", "/blog/hello", "/legal/terms"]) {
      const res = await request(app()).get(path);
      expect(res.status, path).toBe(200);
      expect(res.text, path).toContain("spa");
    }
  });

  it("falls back to the SPA for app routes and serves SPA bundles and static files", async () => {
    expect((await request(app()).get("/home")).text).toContain("spa");
    expect((await request(app()).get("/settings/about")).text).toContain("spa");
    const asset = await request(app()).get("/assets/app-abc.js");
    expect(asset.status).toBe(200);
    expect(asset.headers["cache-control"]).toContain("immutable");
    expect(bodyOf(await request(app()).get("/favicon.svg"))).toContain("web");
  });

  it("does not answer API paths with the SPA", async () => {
    expect((await request(app()).get("/api/v1/ping")).body).toEqual({ ok: true });
    expect((await request(app()).get("/api/v1/unknown")).status).toBe(404);
    // Express matches routes case-insensitively, so /API/... is an API path too.
    expect((await request(app()).get("/API/v1/ping")).body).toEqual({ ok: true });
    const unknown = await request(app()).get("/API/v1/unknown");
    expect(unknown.status).toBe(404);
    expect(unknown.text).not.toContain("spa");
    expect((await request(app()).get("/Api/")).status).toBe(404);
  });
});
