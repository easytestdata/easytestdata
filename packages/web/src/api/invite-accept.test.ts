import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("acceptTeamInvite", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ accepted: true, accessToken: "a", refreshToken: "r", user: {} }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        )
    );
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("sends the invite token in the request body, never in the URL", async () => {
    const { acceptTeamInvite } = await import("./client");

    await acceptTeamInvite("invite_secret_123");

    const [url, init] = vi.mocked(fetch).mock.calls[0] ?? [];
    expect(String(url)).toMatch(/\/teams\/invites\/accept$/);
    expect(String(url)).not.toContain("invite_secret_123");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ token: "invite_secret_123" });
  });
});
