import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import { readTeamIdFromAccessToken, shouldClearSessionAfterProfileError } from "./AuthContext";

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeToken(payload: Record<string, unknown>): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "none", typ: "JWT" }));
  return `${header}.${base64UrlEncode(JSON.stringify(payload))}.signature`;
}

describe("readTeamIdFromAccessToken", () => {
  it("reads teamId from a base64url JWT payload without padding", () => {
    expect(readTeamIdFromAccessToken(makeToken({ teamId: "team-1", name: "Jos\u00e9" }))).toBe(
      "team-1"
    );
  });

  it("returns null when the token is missing or malformed", () => {
    expect(readTeamIdFromAccessToken(null)).toBeNull();
    expect(readTeamIdFromAccessToken("not-a-jwt")).toBeNull();
    expect(readTeamIdFromAccessToken("header.invalid-payload.signature")).toBeNull();
  });

  it("returns null when teamId is absent or not a string", () => {
    expect(readTeamIdFromAccessToken(makeToken({}))).toBeNull();
    expect(readTeamIdFromAccessToken(makeToken({ teamId: 123 }))).toBeNull();
    expect(readTeamIdFromAccessToken(makeToken({ teamId: "" }))).toBeNull();
  });
});

describe("shouldClearSessionAfterProfileError", () => {
  it("clears sessions only when the profile response proves credentials are invalid", () => {
    expect(shouldClearSessionAfterProfileError(new ApiError("Invalid token", 401, {}))).toBe(true);
    expect(shouldClearSessionAfterProfileError(new ApiError("Account is suspended", 403, {}))).toBe(
      true
    );
    expect(shouldClearSessionAfterProfileError(new ApiError("User not found", 404, {}))).toBe(true);
  });

  it("preserves sessions when profile loading fails because the service is unavailable", () => {
    expect(
      shouldClearSessionAfterProfileError(
        new ApiError("Authentication service unavailable", 503, {})
      )
    ).toBe(false);
    expect(shouldClearSessionAfterProfileError(new Error("Network failure"))).toBe(false);
  });
});
