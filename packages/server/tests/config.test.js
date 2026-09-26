import { afterEach, describe, expect, it, vi } from "vitest";
import { allowsAny, isUnlimited, withinLimit } from "@easytestdata/shared/constants";
import { config } from "../src/config.js";

describe("server config", () => {
  it("defines the same limit keys for both deployments", () => {
    for (const deployment of ["cloud", "local"]) {
      const limits = config.limits[deployment];
      expect(limits).toBeTruthy();
      expect(typeof limits.connections).toBe("number");
      expect(typeof limits.loadsPerMonth).toBe("number");
      expect(typeof limits.entitiesPerJob).toBe("number");
      expect(typeof limits.teamMembers).toBe("number");
    }
  });

  it("sets the abuse limits for EasyTestData Cloud", () => {
    expect(config.limits.cloud).toEqual({
      connections: 3,
      loadsPerMonth: 10,
      entitiesPerJob: 5000,
      teamMembers: 5
    });
  });

  describe("deployment", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    async function loadConfig(env) {
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
      vi.resetModules();
      return (await import("../src/config.js")).config;
    }

    it("normalizes DEPLOYMENT like the startup checks do", async () => {
      const local = await loadConfig({ DEPLOYMENT: " Local ", PORT: "", LOCAL_PUBLIC_URL: "" });
      expect(local.deployment).toBe("local");
      expect(local.host).toBe("127.0.0.1");
      expect(local.port).toBe(28080);
      expect(local.appUrl).toBe("http://localhost:28080");
    });

    it("defaults to local without DATABASE_URL and to cloud with it", async () => {
      expect((await loadConfig({ DEPLOYMENT: "", DATABASE_URL: "" })).deployment).toBe("local");
      const cloud = await loadConfig({
        DEPLOYMENT: "",
        DATABASE_URL: "postgres://x",
        PORT: "",
        HOST: "",
        APP_URL: "https://app.example/"
      });
      expect(cloud.deployment).toBe("cloud");
      expect(cloud.host).toBe("0.0.0.0");
      expect(cloud.port).toBe(3000);
      expect(cloud.qbo.redirectUri).toBe("https://app.example/api/v1/connections/callback");
    });

    it("never binds local mode beyond loopback, whatever HOST says", async () => {
      expect((await loadConfig({ DEPLOYMENT: "local", HOST: "0.0.0.0" })).host).toBe("127.0.0.1");
    });

    it("uses the dev server as the public URL in local development", async () => {
      const dev = await loadConfig({
        DEPLOYMENT: "local",
        PORT: "28080",
        LOCAL_PUBLIC_URL: "http://localhost:5173",
        APP_URL: "https://ignored.example"
      });
      expect(dev.appUrl).toBe("http://localhost:5173");
      expect(dev.qbo.redirectUri).toBe("http://localhost:5173/api/v1/connections/callback");
    });

    it("ignores a LOCAL_PUBLIC_URL that is not on localhost", async () => {
      const cfg = await loadConfig({
        DEPLOYMENT: "local",
        PORT: "28080",
        LOCAL_PUBLIC_URL: "http://evil.example:5173"
      });
      expect(cfg.appUrl).toBe("http://localhost:28080");
    });
  });

  it("treats -1 as unlimited in the limit helpers", () => {
    expect(isUnlimited(-1)).toBe(true);
    expect(isUnlimited(0)).toBe(false);
    expect(allowsAny(-1)).toBe(true);
    expect(allowsAny(5)).toBe(true);
    expect(allowsAny(0)).toBe(false);
    expect(allowsAny(undefined)).toBe(false);
    expect(withinLimit(1000, -1)).toBe(true);
    expect(withinLimit(4, 5)).toBe(true);
    expect(withinLimit(5, 5)).toBe(false);
  });
});
