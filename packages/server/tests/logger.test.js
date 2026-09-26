import { describe, expect, it } from "vitest";
import { loggerOptions } from "../src/logger.js";

describe("loggerOptions", () => {
  it("prints JSON unless LOG_PRETTY=1, whatever NODE_ENV is", () => {
    expect(loggerOptions({}, "development").transport).toBeUndefined();
    expect(loggerOptions({ LOG_PRETTY: "true" }, "development").transport).toBeUndefined();
    expect(loggerOptions({}, "production").transport).toBeUndefined();
  });

  it("uses pino-pretty only when LOG_PRETTY=1 (the server's dev script)", () => {
    expect(loggerOptions({ LOG_PRETTY: "1" }, "development").transport.target).toBe("pino-pretty");
  });

  it("keeps LOG_LEVEL, else debug outside production and info in production", () => {
    expect(loggerOptions({ LOG_LEVEL: "warn" }, "production").level).toBe("warn");
    expect(loggerOptions({}, "development").level).toBe("debug");
    expect(loggerOptions({}, "production").level).toBe("info");
  });
});
