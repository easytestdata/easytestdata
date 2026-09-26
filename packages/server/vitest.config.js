import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // Every test runs Cloud behaviour against a pg URL that never connects (port 1): tests mock
    // db/pool.js, and tests of local mode or PGlite stub DEPLOYMENT=local before importing.
    env: { DEPLOYMENT: "cloud", DATABASE_URL: "postgres://test@127.0.0.1:1/unused" }
  }
});
