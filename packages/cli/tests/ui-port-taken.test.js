import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createProgram } from "../src/index.js";

// Its own file: the server's config is read once per process, at import time.
const PORT = 28184;
const dir = mkdtempSync(join(tmpdir(), "eztd-ui-taken-"));
const SIGNALS = ["SIGINT", "SIGTERM"];
const listenersBefore = Object.fromEntries(SIGNALS.map((s) => [s, process.listeners(s)]));
let blocker;
process.env.LOG_LEVEL = "silent";

beforeAll(async () => {
  blocker = createServer();
  await new Promise((resolve) => blocker.listen(PORT, "127.0.0.1", resolve));
});

afterAll(async () => {
  vi.restoreAllMocks();
  // Drop the signal handlers `ui` installed in this test process.
  for (const signal of SIGNALS) {
    for (const listener of process.listeners(signal)) {
      if (!listenersBefore[signal].includes(listener)) process.off(signal, listener);
    }
  }
  await new Promise((resolve) => blocker.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

it("says it could not start and exits 1 when the port is taken", async () => {
  const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`exit ${code}`);
  });
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const argv = ["node", "easytestdata", "ui", "--port", String(PORT), "--no-open"];
  await expect(createProgram().parseAsync([...argv, "--data-dir", dir])).rejects.toThrow("exit 1");
  expect(exit).toHaveBeenCalledWith(1);
  expect(error).toHaveBeenCalledWith(
    expect.stringMatching(/^Could not start EasyTestData: .*EADDRINUSE/)
  );
}, 60_000);
