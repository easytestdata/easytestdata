import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SentryProvider } from "./SentryContext";

const init = vi.hoisted(() => vi.fn());
vi.mock("@sentry/react", () => ({ init }));
vi.mock("./AppConfigContext", () => ({
  useAppConfig: () => ({ loading: false, sentryDsn: "https://key@sentry.example/1" })
}));
afterEach(() => cleanup());

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
