import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import { buildPublicConfig } from "../src/public-config.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("buildPublicConfig", () => {
  it("exposes QBO setup state and the exact OAuth redirect URI", async () => {
    vi.stubEnv("QBO_CLIENT_ID", "");
    vi.stubEnv("QBO_CLIENT_SECRET", "");
    const cfg = await buildPublicConfig();
    expect(cfg.qboConfigured).toBe(false);
    expect(cfg.qboRedirectUri).toBe(`${config.appUrl}/api/v1/connections/callback`);

    vi.stubEnv("QBO_CLIENT_ID", "id");
    vi.stubEnv("QBO_CLIENT_SECRET", "secret");
    expect((await buildPublicConfig()).qboConfigured).toBe(true);
  });

  it("tells the app where the marketing site (and its legal pages) lives", async () => {
    const cfg = await buildPublicConfig();
    expect(cfg.marketingUrl).toBe(config.marketingUrl);
    expect(cfg.marketingUrl).toMatch(/^https?:\/\/[^/]+.*[^/]$/);
  });

  it("includes the server version and never leaks secrets", async () => {
    vi.stubEnv("QBO_CLIENT_ID", "id");
    vi.stubEnv("QBO_CLIENT_SECRET", "qbo-secret");
    const cfg = await buildPublicConfig();
    expect(cfg.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(JSON.stringify(cfg)).not.toContain("qbo-secret");
  });
});
