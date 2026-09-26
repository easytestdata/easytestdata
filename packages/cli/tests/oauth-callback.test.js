import { describe, expect, it } from "vitest";
import { waitForCallback } from "../src/oauth.js";

const PORT = 28185;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("OAuth callback listener", () => {
  it("ignores a callback with the wrong state and keeps waiting for the right one", async () => {
    const pending = waitForCallback(PORT, "right-state", { timeoutMs: 5000 });
    let settled = false;
    pending.then(
      () => (settled = true),
      () => (settled = true)
    );
    await sleep(50);

    const stray = await fetch(`http://127.0.0.1:${PORT}/callback?state=wrong&code=x&realmId=1`);
    expect(stray.status).toBe(400);
    await sleep(20);
    expect(settled).toBe(false);

    const good = await fetch(
      `http://127.0.0.1:${PORT}/callback?state=right-state&code=abc&realmId=123`
    );
    expect(good.status).toBe(200);
    await expect(pending).resolves.toEqual({ code: "abc", realmId: "123" });
  });
});
