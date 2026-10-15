import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { query, transaction, rollback } from "../src/db/pool.js";
import {
  encryptTokenPair,
  decryptTokenPair,
  encryptValue,
  decryptValue
} from "../src/crypto/tokens.js";
import { beginOAuthState, consumeOAuthState, OAuthStateError } from "../src/auth/oauth-state.js";
import { authenticate, requireRole, requireTeamManager } from "../src/middleware/auth.js";
import { withConnectionLock, ConnectionLockBusyError } from "../src/services/connection-lock.js";
import { lockTeam } from "../src/services/connection-guard.js";
import { AppError } from "../src/errors.js";
import { logger } from "../src/logger.js";
import { config } from "../src/config.js";
import { bootstrap, handleShutdownSignals } from "../src/start.js";
import { runMigrations, runMigrationCommand } from "../src/db/migrate.js";

const bindings = {
  query,
  transaction,
  rollback,
  encryptTokenPair,
  decryptTokenPair,
  encryptValue,
  decryptValue,
  beginOAuthState,
  consumeOAuthState,
  OAuthStateError,
  authenticate,
  requireRole,
  requireTeamManager,
  withConnectionLock,
  ConnectionLockBusyError,
  lockTeam,
  AppError,
  logger,
  config
};

describe("public server extension API", () => {
  it("exports exactly the documented bindings, without raw QBO helpers", async () => {
    const api = await import("@easytestdata/server/extension");
    expect(Object.keys(api).sort()).toEqual(Object.keys(bindings).sort());
  });

  it.each(Object.entries(bindings))("shares the internal %s binding", async (name, binding) => {
    const api = await import("@easytestdata/server/extension");
    expect(api[name]).toBe(binding);
    expect(api[name]).toBeTypeOf(["config", "logger"].includes(name) ? "object" : "function");
  });

  it("shares lock contention with internal callers and accepts work after release", async () => {
    const api = await import("@easytestdata/server/extension");
    const blocked = vi.fn();
    await withConnectionLock("extension-api-test", async () => {
      await expect(api.withConnectionLock("extension-api-test", blocked)).rejects.toBeInstanceOf(
        api.ConnectionLockBusyError
      );
      expect(blocked).not.toHaveBeenCalled();
      await expect(
        api.withConnectionLock("extension-api-other", async () => "independent")
      ).resolves.toBe("independent");
    });
    await expect(
      api.withConnectionLock("extension-api-test", async () => "released")
    ).resolves.toBe("released");
  });
});

describe("public server start API", () => {
  it.each(Object.entries({ bootstrap, handleShutdownSignals, runMigrations, runMigrationCommand }))(
    "shares the internal %s binding",
    async (name, binding) => {
      const api = await import("@easytestdata/server/start");
      expect(api[name]).toBe(binding);
      expect(api[name]).toBeTypeOf("function");
    }
  );
});

it.each(["@easytestdata/server/extension", "@easytestdata/server/start"])(
  "%s imports in a fresh process without listening, migrations or database files",
  (subpath) => {
    const work = mkdtempSync(join(tmpdir(), "eztd-extension-import-"));
    const dataDir = join(work, "import-data");
    try {
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `
            import assert from "node:assert/strict";
            import { Server } from "node:net";
            let listens = 0;
            Server.prototype.listen = () => {
              listens++;
              throw new Error("Import must not listen");
            };
            const signals = ["SIGINT", "SIGTERM"].map((name) => process.listenerCount(name));
            await import(${JSON.stringify(subpath)});
            assert.equal(listens, 0);
            assert.deepEqual(
              ["SIGINT", "SIGTERM"].map((name) => process.listenerCount(name)),
              signals
            );
            console.log("Import completed");
          `
        ],
        {
          cwd: fileURLToPath(new URL("..", import.meta.url)),
          env: {
            PATH: process.env.PATH,
            HOME: work,
            DEPLOYMENT: "local",
            EASYTESTDATA_DATA_DIR: dataDir
          },
          encoding: "utf8",
          timeout: 10_000,
          killSignal: "SIGKILL"
        }
      );
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("Import completed\n");
      for (const file of ["db", "server.lock", "secret.key"]) {
        expect(existsSync(join(dataDir, file)), file).toBe(false);
      }
      expect(existsSync(dataDir)).toBe(false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  },
  // Fresh Node imports can be slow when the machine is loaded.
  30_000
);
