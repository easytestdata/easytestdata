import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/middleware/auth.js", () => ({
  authenticate: (req, _res, next) => {
    req.user = { id: "user-1", teamId: "team-1", role: "owner" };
    next();
  }
}));

vi.mock("../src/db/pool.js", () => ({
  // What pg raises when a non-UUID string is compared with a uuid column.
  query: async () => {
    throw Object.assign(new Error('invalid input syntax for type uuid: "nonexistent"'), {
      code: "22P02"
    });
  }
}));

vi.mock("../src/workers/runner.js", () => ({ notifyJobQueued: () => {} }));

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../src/logger.js", () => ({ logger }));

import { errorHandler } from "../src/middleware/error-handler.js";
import { jobRoutes } from "../src/routes/jobs.js";

describe("error handler", () => {
  it("answers a malformed id with 404 instead of 500", async () => {
    const app = express();
    app.use("/api/jobs", jobRoutes());
    app.use(errorHandler);

    const res = await request(app).get("/api/jobs/nonexistent");

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
    expect(res.body.error).toBe("Not found");
  });
});

describe("request bodies express.json() refuses", () => {
  function app() {
    const app = express();
    app.use(express.json());
    app.post("/api/echo", (req, res) => res.json(req.body));
    app.use(errorHandler);
    return app;
  }

  it("answers a body over the size limit with 413, not a 500 crash", async () => {
    logger.error.mockClear();
    const res = await request(app())
      .post("/api/echo")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ blob: "x".repeat(200 * 1024) }));

    expect(res.status).toBe(413);
    expect(res.body.code).toBe("PAYLOAD_TOO_LARGE");
    expect(res.body.error).toBe("Request body is too large.");
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("answers malformed JSON with 400 and a plain message", async () => {
    logger.error.mockClear();
    const res = await request(app())
      .post("/api/echo")
      .set("Content-Type", "application/json")
      .send('{"a":');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
    expect(res.body.error).toBe("Request body is not valid JSON.");
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe("other client errors express.json() raises", () => {
  it("answers an unsupported body encoding with its 415 and a plain message, not a 500", async () => {
    logger.error.mockClear();
    const app = express();
    app.use(express.json());
    app.post("/api/echo", (req, res) => res.json(req.body));
    app.use(errorHandler);

    const res = await request(app)
      .post("/api/echo")
      .set("Content-Type", "application/json")
      .set("Content-Encoding", "made-up")
      .send("{}");

    expect(res.status).toBe(415);
    expect(res.body.code).toBe("INVALID_INPUT");
    expect(res.body.error).toBe("Unsupported Media Type");
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe("sanitizeBody (request bodies attached to error reports)", () => {
  it("redacts every credential-like field, at any depth", async () => {
    const { sanitizeBody } = await import("../src/middleware/error-handler.js");
    const body = {
      currentPassword: "old-secret",
      newPassword: "new-secret",
      refreshToken: "rt",
      code: "123456",
      sessionToken: "ts",
      token: "invite-token", // POST /teams/invites/accept
      name: "Scenario A",
      config: { clientSecret: "cs", apiKey: "k", months: 3 },
      items: [{ password: "p", label: "x" }]
    };
    const clean = sanitizeBody(body);
    expect(JSON.stringify(clean)).not.toMatch(
      /old-secret|new-secret|"rt"|123456|"ts"|invite-token|"cs"|"k"|"p"/
    );
    expect(clean.name).toBe("Scenario A");
    expect(clean.config.months).toBe(3);
    expect(clean.items[0].label).toBe("x");
  });
});
