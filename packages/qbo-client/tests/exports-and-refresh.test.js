import { beforeEach, describe, expect, it, vi } from "vitest";
import axios from "axios";
import * as qboClientExports from "../src/index.js";
import { QboClient } from "../src/qbo-client.js";

const TEST_QBO_HTTP_TIMEOUT_MS = 30_000;

vi.mock("axios", () => ({
  default: {
    post: vi.fn(),
    request: vi.fn()
  }
}));

describe("qbo-client exports", () => {
  it("exposes key public APIs", () => {
    expect(typeof qboClientExports.QboClient).toBe("function");
    expect(typeof qboClientExports.loadPlanIntoQbo).toBe("function");
    expect(typeof qboClientExports.purgeTransactions).toBe("function");
    expect(typeof qboClientExports.batchCreate).toBe("function");
  });
});

describe("QboClient token refresh callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates tokens and invokes onTokenRefresh on refresh token rotation", async () => {
    axios.post.mockResolvedValue({
      data: {
        access_token: "new-access-token",
        refresh_token: "new-refresh-token"
      }
    });

    const onTokenRefresh = vi.fn();
    const client = new QboClient({
      qboClientId: "client-id",
      qboClientSecret: "client-secret",
      qboRefreshToken: "seed-refresh-token",
      qboRealmId: "123456",
      qboBaseUrl: "https://sandbox-quickbooks.api.intuit.com",
      qboMinorVersion: "65",
      onTokenRefresh
    });

    client.refreshToken = "old-refresh-token";
    await client.refreshAccessToken();

    expect(client.accessToken).toBe("new-access-token");
    expect(client.refreshToken).toBe("new-refresh-token");
    expect(onTokenRefresh).toHaveBeenCalledWith({
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token"
    });
    expect(axios.post).toHaveBeenCalledWith(
      "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
      expect.any(String),
      expect.objectContaining({ timeout: TEST_QBO_HTTP_TIMEOUT_MS })
    );
  });

  it("uses onWarning when onTokenRefresh callback throws", async () => {
    axios.post.mockResolvedValue({
      data: {
        access_token: "new-access-token",
        refresh_token: "new-refresh-token"
      }
    });

    const onWarning = vi.fn();
    const onTokenRefresh = vi.fn(async () => {
      throw new Error("persist failed");
    });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const client = new QboClient({
      qboClientId: "client-id",
      qboClientSecret: "client-secret",
      qboRefreshToken: "seed-refresh-token",
      qboRealmId: "123456",
      qboBaseUrl: "https://sandbox-quickbooks.api.intuit.com",
      qboMinorVersion: "65",
      onTokenRefresh,
      onWarning
    });

    client.refreshToken = "old-refresh-token";
    await client.refreshAccessToken();

    expect(onWarning).toHaveBeenCalledWith(
      expect.stringContaining("onTokenRefresh callback failed"),
      expect.any(Error)
    );
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it("passes a timeout to QBO API requests", async () => {
    axios.request.mockResolvedValue({ data: { QueryResponse: {} } });

    const client = new QboClient({
      qboClientId: "client-id",
      qboClientSecret: "client-secret",
      qboAccessToken: "access-token",
      qboRefreshToken: "refresh-token",
      qboRealmId: "123456",
      qboBaseUrl: "https://sandbox-quickbooks.api.intuit.com",
      qboMinorVersion: "65"
    });

    await client.request("GET", "/query", {
      params: { query: "select * from CompanyInfo" }
    });

    expect(axios.request).toHaveBeenCalledWith(
      expect.objectContaining({ timeout: TEST_QBO_HTTP_TIMEOUT_MS })
    );
  });
});
