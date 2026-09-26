import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

async function loadClientWithTokens() {
  vi.resetModules();
  localStorage.setItem("accessToken", "old-access-token");
  localStorage.setItem("refreshToken", "stored-refresh-token");
  return import("@easytestdata/shared/api-client");
}

describe("shared API client token refresh", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("preserves tokens and surfaces service outages when refresh fails transiently", async () => {
    const client = await loadClientWithTokens();
    client.setErrorHandler(() => {});
    const fetchMock = vi.mocked(fetch);

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: "Access token expired" }, 401))
      .mockResolvedValueOnce(jsonResponse({ error: "Authentication service unavailable" }, 503));

    await expect(client.request("GET", "/jobs")).rejects.toMatchObject({
      message: "Authentication service unavailable",
      status: 503
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem("accessToken")).toBe("old-access-token");
    expect(localStorage.getItem("refreshToken")).toBe("stored-refresh-token");
    expect(client.getAccessToken()).toBe("old-access-token");
  });

  it("clears tokens when the refresh token is rejected", async () => {
    const client = await loadClientWithTokens();
    client.setErrorHandler(() => {});
    const fetchMock = vi.mocked(fetch);

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: "Access token expired" }, 401))
      .mockResolvedValueOnce(jsonResponse({ error: "Invalid or expired refresh token" }, 401));

    await expect(client.request("GET", "/jobs")).rejects.toMatchObject({
      message: "Access token expired",
      status: 401
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem("accessToken")).toBeNull();
    expect(localStorage.getItem("refreshToken")).toBeNull();
    expect(client.isAuthenticated()).toBe(false);
  });

  describe("when another tab changes the stored tokens", () => {
    function otherTabWrites(key: string | null, newValue: string | null) {
      if (key && newValue !== null) localStorage.setItem(key, newValue);
      else if (key) localStorage.removeItem(key);
      else localStorage.clear();
      window.dispatchEvent(new StorageEvent("storage", { key, newValue }));
    }

    it("adopts tokens the other tab stored (sign-in, team switch) and announces them", async () => {
      const client = await loadClientWithTokens();
      const changed = vi.fn();
      window.addEventListener(client.TOKENS_CHANGED_EVENT, changed);
      try {
        otherTabWrites("accessToken", "other-tab-access");
        otherTabWrites("refreshToken", "other-tab-refresh");

        expect(client.getAccessToken()).toBe("other-tab-access");
        expect(changed).toHaveBeenCalled();
        expect((changed.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ fromOtherTab: true });

        // The next request and refresh use the adopted tokens.
        vi.mocked(fetch)
          .mockResolvedValueOnce(jsonResponse({ error: "expired" }, 401))
          .mockResolvedValueOnce(jsonResponse({ accessToken: "new", refreshToken: "newer" }))
          .mockResolvedValueOnce(jsonResponse({ ok: true }));
        await client.request("GET", "/jobs");
        const calls = vi.mocked(fetch).mock.calls;
        expect((calls[0]?.[1]?.headers as Record<string, string>).Authorization).toBe(
          "Bearer other-tab-access"
        );
        expect(JSON.parse(String(calls[1]?.[1]?.body))).toEqual({
          refreshToken: "other-tab-refresh"
        });
      } finally {
        window.removeEventListener(client.TOKENS_CHANGED_EVENT, changed);
      }
    });

    it("signs out when the other tab clears the tokens, without writing storage back", async () => {
      const client = await loadClientWithTokens();
      const changed = vi.fn();
      window.addEventListener(client.TOKENS_CHANGED_EVENT, changed);
      const setItem = vi.spyOn(Storage.prototype, "setItem");
      const removeItem = vi.spyOn(Storage.prototype, "removeItem");
      try {
        localStorage.removeItem("accessToken");
        localStorage.removeItem("refreshToken");
        removeItem.mockClear();
        window.dispatchEvent(new StorageEvent("storage", { key: "accessToken", newValue: null }));

        expect(client.isAuthenticated()).toBe(false);
        expect(changed).toHaveBeenCalled();
        expect(setItem).not.toHaveBeenCalled();
        expect(removeItem).not.toHaveBeenCalled();
      } finally {
        setItem.mockRestore();
        removeItem.mockRestore();
        window.removeEventListener(client.TOKENS_CHANGED_EVENT, changed);
      }
    });

    it("ignores unrelated storage keys", async () => {
      const client = await loadClientWithTokens();
      const changed = vi.fn();
      window.addEventListener(client.TOKENS_CHANGED_EVENT, changed);
      try {
        otherTabWrites("somethingElse", "x");
        expect(changed).not.toHaveBeenCalled();
        expect(client.getAccessToken()).toBe("old-access-token");
      } finally {
        window.removeEventListener(client.TOKENS_CHANGED_EVENT, changed);
      }
    });
  });

  it("announces cleared tokens through TOKENS_CHANGED_EVENT when the refresh token is rejected", async () => {
    const client = await loadClientWithTokens();
    client.setErrorHandler(() => {});
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: "Access token expired" }, 401))
      .mockResolvedValueOnce(jsonResponse({ error: "Session revoked" }, 401));
    const changed = vi.fn(() => client.getAccessToken());
    window.addEventListener(client.TOKENS_CHANGED_EVENT, changed);
    try {
      await expect(client.request("GET", "/jobs")).rejects.toMatchObject({ status: 401 });
    } finally {
      window.removeEventListener(client.TOKENS_CHANGED_EVENT, changed);
    }
    // Fired once the tokens are gone, so a listener reading them sees the signed-out state.
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed.mock.results[0]?.value).toBeNull();
  });

  it("uses tokens another tab stored while its refresh was in flight instead of signing out", async () => {
    const client = await loadClientWithTokens();
    client.setErrorHandler(() => {});
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url).endsWith("/auth/refresh")) {
        // The other tab rotated the token first, so the server rejects ours.
        localStorage.setItem("accessToken", "other-tab-access");
        localStorage.setItem("refreshToken", "other-tab-refresh");
        return jsonResponse({ error: "Invalid or expired refresh token" }, 401);
      }
      const auth = (init?.headers as Record<string, string>)?.Authorization;
      return auth === "Bearer other-tab-access"
        ? jsonResponse({ ok: true })
        : jsonResponse({ error: "expired" }, 401);
    });

    await expect(client.request("GET", "/jobs")).resolves.toEqual({ ok: true });

    expect(localStorage.getItem("refreshToken")).toBe("other-tab-refresh");
    expect(client.getAccessToken()).toBe("other-tab-access");
    expect(client.isAuthenticated()).toBe(true);
  });

  it("shares one refresh between concurrent 401s and uses the newest stored refresh token", async () => {
    const client = await loadClientWithTokens();
    client.setErrorHandler(() => {});
    // Another tab rotated the refresh token after this module loaded.
    localStorage.setItem("refreshToken", "rotated-by-other-tab");
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url).endsWith("/auth/refresh")) {
        return jsonResponse({ accessToken: "new-access", refreshToken: "new-refresh" });
      }
      const auth = (init?.headers as Record<string, string>)?.Authorization;
      return auth === "Bearer new-access"
        ? jsonResponse({ ok: true })
        : jsonResponse({ error: "expired" }, 401);
    });

    await Promise.all([client.request("GET", "/jobs"), client.request("GET", "/connections")]);

    const refreshCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith("/auth/refresh")
    );
    expect(refreshCalls).toHaveLength(1);
    expect(JSON.parse(String(refreshCalls[0]?.[1]?.body))).toEqual({
      refreshToken: "rotated-by-other-tab"
    });
  });

  describe("identity changes between the request and its retry", () => {
    const jwt = (payload: Record<string, string>) =>
      `h.${btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}.s`;
    const teamA = jwt({ sub: "u1", teamId: "team-a" });
    const teamB = jwt({ sub: "u1", teamId: "team-b" });

    async function loadClientAs(token: string) {
      vi.resetModules();
      localStorage.setItem("accessToken", token);
      localStorage.setItem("refreshToken", "refresh-a");
      return import("@easytestdata/shared/api-client");
    }

    /** The other tab already rotated the refresh token (into team B) when ours is rejected. */
    function otherTabRotatedInto(token: string, accepted: (auth: string | undefined) => boolean) {
      vi.mocked(fetch).mockImplementation(async (url, init) => {
        if (String(url).endsWith("/auth/refresh")) {
          localStorage.setItem("accessToken", token);
          localStorage.setItem("refreshToken", "refresh-b");
          return jsonResponse({ error: "Invalid or expired refresh token" }, 401);
        }
        const auth = (init?.headers as Record<string, string>)?.Authorization;
        return accepted(auth)
          ? jsonResponse({ ok: true })
          : jsonResponse({ error: "expired" }, 401);
      });
    }

    it("announces adopted tokens through TOKENS_CHANGED_EVENT like a refresh does", async () => {
      const client = await loadClientAs(teamA);
      client.setErrorHandler(() => {});
      const changed = vi.fn();
      window.addEventListener(client.TOKENS_CHANGED_EVENT, changed);
      otherTabRotatedInto(teamB, (auth) => auth === `Bearer ${teamB}`);

      await expect(client.request("GET", "/jobs")).resolves.toEqual({ ok: true });

      expect(changed).toHaveBeenCalledTimes(1);
      expect(client.getAccessToken()).toBe(teamB);
      window.removeEventListener(client.TOKENS_CHANGED_EVENT, changed);
    });

    it("does not replay a write under a token for another team; reads may retry", async () => {
      const client = await loadClientAs(teamA);
      client.setErrorHandler(() => {});
      otherTabRotatedInto(teamB, (auth) => auth === `Bearer ${teamB}`);

      await expect(
        client.request("POST", "/jobs", { type: "generate", templateId: "saas", config: {} })
      ).rejects.toMatchObject({
        status: 409,
        body: { code: "SESSION_CHANGED" }
      });
      const fetchMock = vi.mocked(fetch);
      expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/jobs"))).toHaveLength(1); // no retry
      // The adopted tokens stay (the other tab's session is the live one).
      expect(client.getAccessToken()).toBe(teamB);

      await expect(client.request("GET", "/connections")).resolves.toEqual({ ok: true });
    });

    it("also refuses a write when the server's refresh lands in another team", async () => {
      const client = await loadClientAs(teamA);
      client.setErrorHandler(() => {});
      vi.mocked(fetch).mockImplementation(async (url, init) => {
        if (String(url).endsWith("/auth/refresh")) {
          return jsonResponse({ accessToken: teamB, refreshToken: "refresh-b" });
        }
        const auth = (init?.headers as Record<string, string>)?.Authorization;
        return auth === `Bearer ${teamB}`
          ? jsonResponse({ ok: true })
          : jsonResponse({ error: "expired" }, 401);
      });

      await expect(client.request("DELETE", "/connections/c1")).rejects.toMatchObject({
        status: 409,
        body: { code: "SESSION_CHANGED" }
      });
    });

    it("retries a write normally when the refreshed token is for the same user and team", async () => {
      const client = await loadClientAs(teamA);
      client.setErrorHandler(() => {});
      const teamAAgain = jwt({ sub: "u1", teamId: "team-a", iat: "2" });
      vi.mocked(fetch).mockImplementation(async (url, init) => {
        if (String(url).endsWith("/auth/refresh")) {
          return jsonResponse({ accessToken: teamAAgain, refreshToken: "refresh-a2" });
        }
        const auth = (init?.headers as Record<string, string>)?.Authorization;
        return auth === `Bearer ${teamAAgain}`
          ? jsonResponse({ ok: true })
          : jsonResponse({ error: "expired" }, 401);
      });

      await expect(client.request("POST", "/jobs", {})).resolves.toEqual({ ok: true });
    });
  });

  it("stores refreshed tokens and retries the original request", async () => {
    const client = await loadClientWithTokens();
    client.setErrorHandler(() => {});
    const fetchMock = vi.mocked(fetch);

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: "Access token expired" }, 401))
      .mockResolvedValueOnce(
        jsonResponse({ accessToken: "new-access-token", refreshToken: "new-refresh-token" })
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await expect(client.request("GET", "/jobs")).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.headers).toMatchObject({
      Authorization: "Bearer old-access-token"
    });
    expect((fetchMock.mock.calls[2]?.[1] as RequestInit | undefined)?.headers).toMatchObject({
      Authorization: "Bearer new-access-token"
    });
    expect(localStorage.getItem("accessToken")).toBe("new-access-token");
    expect(localStorage.getItem("refreshToken")).toBe("new-refresh-token");
  });
});

describe("shared API client local-mode header", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  // Local mode refuses every state-changing request without it (cross-site request guard).
  it("sends X-EasyTestData: 1 on every request, refresh and retry included", async () => {
    const client = await loadClientWithTokens();
    client.setErrorHandler(() => {});
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: "Access token expired" }, 401))
      .mockResolvedValueOnce(jsonResponse({ accessToken: "new-a", refreshToken: "new-r" }))
      .mockResolvedValueOnce(jsonResponse({ id: "j1" }, 201))
      .mockResolvedValueOnce(jsonResponse({ id: "j2" }, 201));

    await client.request("POST", "/jobs", { type: "generate" });
    await client.request("DELETE", "/connections/c1");

    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const [, init] of fetchMock.mock.calls) {
      expect((init?.headers as Record<string, string>)["X-EasyTestData"]).toBe("1");
    }
  });

  it("sends it on downloads too", async () => {
    vi.resetModules();
    const client = await import("@easytestdata/shared/api-client");
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    await client.authenticatedDownload("/jobs/j1/download", "j1.json").catch(() => {});
    const init = fetchMock.mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string>)["X-EasyTestData"]).toBe("1");
  });
});
