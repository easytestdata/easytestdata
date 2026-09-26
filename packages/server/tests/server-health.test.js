import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const poolQuery = vi.hoisted(() => vi.fn());
vi.mock("../src/db/pool.js", () => ({
  query: (...args) => poolQuery(...args)
}));
vi.mock("../src/logger.js", async () => {
  const { default: pino } = await import("pino");
  return { logger: pino({ level: "silent" }) };
});

const { createApp } = await import("../src/server.js");

describe("GET /health", () => {
  beforeEach(() => {
    poolQuery.mockReset();
  });

  it("answers ok when the database responds", async () => {
    poolQuery.mockResolvedValue({ rows: [{ "?column?": 1 }] });
    const res = await request(createApp()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
    expect(poolQuery).toHaveBeenCalledWith("SELECT 1");
  });

  it("answers 503 error when the database query fails", async () => {
    poolQuery.mockRejectedValue(new Error("connection refused"));
    const res = await request(createApp()).get("/health");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: "error" });
  });

  it("does not touch the database until a request arrives", () => {
    createApp();
    expect(poolQuery).not.toHaveBeenCalled();
  });
});
