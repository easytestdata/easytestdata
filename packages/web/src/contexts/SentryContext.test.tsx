import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SentryProvider } from "./SentryContext";

const init = vi.hoisted(() => vi.fn());
vi.mock("@sentry/react", () => ({ init }));
vi.mock("./AppConfigContext", () => ({
  useAppConfig: () => ({ loading: false, sentryDsn: "https://key@sentry.example/1" })
}));
beforeEach(() => init.mockClear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/");
});

it("does not opt into Sentry 11's expanded automatic data collection", async () => {
  render(<SentryProvider>App</SentryProvider>);
  await waitFor(() => expect(init).toHaveBeenCalledTimes(1));
  expect(init.mock.calls[0]?.[0].dataCollection).toEqual({
    userInfo: false,
    cookies: false,
    httpHeaders: {
      request: { deny: ["forwarded", "-ip", "remote-", "via", "-user"] },
      response: { deny: ["forwarded", "-ip", "remote-", "via", "-user"] }
    },
    httpBodies: [],
    urlQueryParams: { deny: ["forwarded", "-ip", "remote-", "via", "-user"] },
    genAI: { inputs: false, outputs: false },
    databaseQueryData: false,
    queues: false,
    graphQL: { document: false, variables: false }
  });
});

it("scrubs fallback page URLs in the real GlobalHandlers error envelope", async () => {
  window.history.replaceState(
    {},
    "",
    "/login?auth_code=private-code&state=private-state#private-fragment"
  );
  render(<SentryProvider>App</SentryProvider>);
  await waitFor(() => expect(init).toHaveBeenCalledTimes(1));

  const Sentry = await vi.importActual<typeof import("@sentry/react")>("@sentry/react");
  const envelopes: unknown[] = [];
  Sentry.init({
    ...init.mock.calls[0]![0],
    transport: () => ({
      send: async (envelope) => {
        envelopes.push(envelope);
        return { statusCode: 200 };
      },
      flush: async () => true
    })
  });
  try {
    Sentry.getCurrentScope().clearBreadcrumbs();
    Sentry.getIsolationScope().clearBreadcrumbs();
    expect(Sentry.getClient()?.getIntegrationByName("GlobalHandlers")).toBeDefined();
    expect(window.onerror).toBeTypeOf("function");
    // No source filename or Error stack: GlobalHandlers falls back to location.href.
    window.onerror!("Sentry source-less browser regression", undefined, 17, 23);
    await Sentry.flush(2000);
    const events = envelopes.flatMap((envelope) => {
      const [, items] = envelope as [unknown, [{ type: string }, import("@sentry/react").Event][]];
      return items.filter(([header]) => header.type === "event").map(([, event]) => event);
    });
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.exception?.values).toHaveLength(1);
    expect(event.exception?.values?.[0]).toMatchObject({
      value: "Sentry source-less browser regression",
      mechanism: { type: "auto.browser.global_handlers.onerror", handled: false },
      stacktrace: {
        frames: [{ filename: `${window.location.origin}/login`, lineno: 17, colno: 23 }]
      }
    });
    expect(event.request?.url).toBe(`${window.location.origin}/login`);
    expect(JSON.stringify(envelopes)).not.toMatch(/private-/);
  } finally {
    await Sentry.close(2000);
  }
});

it.each([
  "/login?auth_code=private-auth-code&invite_token=private-invite-token&code=private-oauth-code&state=private-oauth-state&other=private-query-value#private-fragment",
  "/invite?token=private-invite-token#private-fragment"
])("keeps credentials out of the real SDK's outgoing error envelope on %s", async (page) => {
  window.history.replaceState({}, "", page);
  vi.spyOn(document, "referrer", "get").mockReturnValue(
    "https://app.example/invite?token=private-referrer-token#private-referrer-fragment"
  );
  render(<SentryProvider>App</SentryProvider>);
  await waitFor(() => expect(init).toHaveBeenCalledTimes(1));

  const Sentry = await vi.importActual<typeof import("@sentry/react")>("@sentry/react");
  const envelopes: unknown[] = [];
  Sentry.init({
    ...init.mock.calls[0]![0],
    transport: () => ({
      send: async (envelope) => {
        envelopes.push(envelope);
        return { statusCode: 200 };
      },
      flush: async () => true
    })
  });
  try {
    Sentry.getCurrentScope().clearBreadcrumbs();
    Sentry.getIsolationScope().clearBreadcrumbs();
    // The default BrowserApiErrors/Breadcrumbs integrations remain enabled, including history.
    window.history.pushState({}, "", "/invite?token=private-navigation-token#private-nav-fragment");
    window.history.pushState({}, "", page);
    for (const category of ["fetch", "xhr"]) {
      Sentry.addBreadcrumb({
        category,
        data: {
          url: "/api/v1/callback?code=private-fetch-code#private-fetch-fragment",
          method: "GET"
        }
      });
    }
    const breadcrumbs = [...Sentry.getIsolationScope().getScopeData().breadcrumbs];
    Sentry.captureException(new Error("Sentry browser regression"));
    await Sentry.flush(2000);
    // Read the event handed to the real transport, after all SDK integrations and hooks.
    const events = envelopes.flatMap((envelope) => {
      const [, items] = envelope as [unknown, [{ type: string }, import("@sentry/react").Event][]];
      return items.filter(([header]) => header.type === "event").map(([, event]) => event);
    });
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.exception?.values?.[0]?.value).toBe("Sentry browser regression");
    // Verify beforeBreadcrumb at collection time, independently of beforeSend's fallback.
    expect(breadcrumbs).toHaveLength(4);
    expect(JSON.stringify(breadcrumbs)).not.toMatch(/private-/);
    expect(event.request?.url).toBe(`${window.location.origin}${page.split("?")[0]}`);
    expect(event.request?.headers?.Referer).toBe("https://app.example/invite");
    expect(event.breadcrumbs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "navigation",
          data: expect.objectContaining({ to: "/invite" })
        }),
        ...["fetch", "xhr"].map((category) =>
          expect.objectContaining({
            category,
            data: { url: "/api/v1/callback", method: "GET" }
          })
        )
      ])
    );
    expect(JSON.stringify(envelopes)).not.toMatch(/private-/);
  } finally {
    await Sentry.close(2000);
  }
});
