import type { Event } from "@sentry/react";
import { describe, expect, it } from "vitest";
import { scrubSentryBreadcrumb, scrubSentryEvent } from "./sentry-scrub";

describe("Sentry URL scrubbing", () => {
  it.each(["Referer", "referer", "REFERER"])("scrubs %s and preserves request paths", (header) => {
    const event: Event = {
      message: "Error still reported",
      request: {
        url: "https://app.example/login?auth_code=secret#secret",
        query_string: "invite_token=secret",
        headers: { [header]: "https://app.example/invite?token=secret#secret", Accept: "*/*" }
      },
      breadcrumbs: [{ category: "fetch", data: { url: "/callback?code=secret#secret" } }]
    };
    const original = JSON.stringify(event);
    const scrubbed = scrubSentryEvent(event);
    expect(scrubbed.message).toBe("Error still reported");
    expect(scrubbed.request).toEqual({
      url: "https://app.example/login",
      headers: { [header]: "https://app.example/invite", Accept: "*/*" }
    });
    expect(scrubbed.breadcrumbs?.[0]?.data?.url).toBe("/callback");
    expect(JSON.stringify(scrubbed)).not.toContain("secret");
    expect(JSON.stringify(event)).toBe(original);
  });

  it("strips fragments without queries, preserving breadcrumb fields and the input", () => {
    const breadcrumb = {
      category: "navigation",
      data: { from: "/invite#secret", to: "/login?state=secret#secret", status_code: 200 }
    };
    const original = JSON.stringify(breadcrumb);
    expect(scrubSentryBreadcrumb(breadcrumb)).toEqual({
      category: "navigation",
      data: { from: "/invite", to: "/login", status_code: 200 }
    });
    expect(JSON.stringify(breadcrumb)).toBe(original);
  });

  it("preserves events and breadcrumbs without URL data", () => {
    expect(scrubSentryEvent({ message: "Error" })).toEqual({ message: "Error" });
    expect(scrubSentryEvent({ request: { url: "/home" } }).request?.url).toBe("/home");
    expect(scrubSentryBreadcrumb({ message: "Action" })).toEqual({ message: "Action" });
    expect(scrubSentryBreadcrumb({ data: { url: 42, from: null } })).toEqual({
      data: { url: 42, from: null }
    });
  });
});
