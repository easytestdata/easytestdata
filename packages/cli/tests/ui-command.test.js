import { mkdtempSync, rmSync } from "node:fs";
import { get } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { createProgram } from "../src/index.js";

const dir = mkdtempSync(join(tmpdir(), "eztd-ui-"));
let server;
// The embedded server logs as JSON in this process; keep the test output readable.
process.env.LOG_LEVEL = "silent";
afterAll(async () => {
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** GET with an explicit Host header (fetch does not let a caller choose it). */
function getWithHost(url, host) {
  return new Promise((resolve, reject) => {
    get(url, { headers: { host } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    }).on("error", reject);
  });
}

/** Resolves true when nothing listens on 127.0.0.1:port any more (we can bind it ourselves). */
function portIsFree(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

it("registers the ui command with its options", () => {
  const ui = createProgram().commands.find((command) => command.name() === "ui");
  expect(ui).toBeDefined();
  const flags = ui.options.map((option) => option.long);
  expect(flags).toEqual(expect.arrayContaining(["--port", "--data-dir", "--no-open"]));
  expect(ui.options.find((option) => option.long === "--port").defaultValue).toBe(28080);
});

it("rejects a --port that is not a port number", async () => {
  const { uiCommand } = await import("../src/commands/ui.js");
  for (const port of ["abc", "0", "65536", "80x", "-1"]) {
    const errors = [];
    const ui = uiCommand()
      .exitOverride()
      .configureOutput({ writeErr: (text) => errors.push(text) });
    expect(() => ui.parse(["--port", port], { from: "user" }), port).toThrow();
    expect(errors.join(""), port).toContain("Use a port number from 1 to 65535.");
  }
});

it("starts on loopback with an embedded database and serves the app without a login", async () => {
  const { startLocalServer } = await import("@easytestdata/server/local");
  server = await startLocalServer({ port: 28181, dataDir: dir, open: false });
  expect(server.url).toBe("http://localhost:28181");
  expect((await fetch("http://127.0.0.1:28181/health")).status).toBe(200);
  const page = await fetch("http://localhost:28181/");
  expect(page.status).toBe(200);
  expect(await page.text()).toMatch(/<div id="root">/);
  const profile = await fetch("http://localhost:28181/api/v1/auth/profile", {
    headers: { "x-easytestdata": "1" }
  });
  expect(profile.status).toBe(200);
  const setup = await fetch("http://localhost:28181/api/v1/setup", {
    headers: { "x-easytestdata": "1" }
  });
  expect((await setup.json()).redirectUri).toBe(
    "http://localhost:28181/api/v1/connections/callback"
  );
}, 60_000);

it("refuses a foreign Host (DNS rebinding)", async () => {
  expect(server).toBeDefined();
  expect(await getWithHost("http://127.0.0.1:28181/", "evil.example:28181")).toBe(403);
  expect(await getWithHost("http://127.0.0.1:28181/api/v1/auth/profile", "evil.example")).toBe(403);
});

it("shuts down cleanly: close() resolves and frees the port", async () => {
  expect(server).toBeDefined();
  await server.close();
  expect(await portIsFree(28181)).toBe(true);
  await expect(fetch("http://127.0.0.1:28181/health")).rejects.toThrow();
}, 30_000);
