import type { Breadcrumb, Event } from "@sentry/react";

// Query strings and fragments can hold one-time OAuth codes and invite credentials.
function stripQueryAndFragment(url: string): string {
  return url.split(/[?#]/, 1)[0] ?? "";
}

export function scrubSentryBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  if (!breadcrumb.data) return breadcrumb;
  const data = { ...breadcrumb.data };
  for (const key of ["url", "from", "to"]) {
    if (typeof data[key] === "string") data[key] = stripQueryAndFragment(data[key]);
  }
  return { ...breadcrumb, data };
}

/** Runs after HttpContext has attached the current page URL and Referer. */
export function scrubSentryEvent<T extends Event>(event: T): T {
  const scrubbed = { ...event };
  if (event.request) {
    const request = { ...event.request };
    if (request.url) request.url = stripQueryAndFragment(request.url);
    delete request.query_string;
    if (request.headers) {
      request.headers = { ...request.headers };
      for (const [key, value] of Object.entries(request.headers)) {
        if (/^referer$/i.test(key)) request.headers[key] = stripQueryAndFragment(value);
      }
    }
    scrubbed.request = request;
  }
  // GlobalHandlers can use location.href as a source-less error's frame filename.
  if (event.exception?.values) {
    scrubbed.exception = {
      ...event.exception,
      values: event.exception.values.map((exception) => {
        if (!exception.stacktrace?.frames) return exception;
        return {
          ...exception,
          stacktrace: {
            ...exception.stacktrace,
            frames: exception.stacktrace.frames.map((frame) => {
              const scrubbedFrame = { ...frame };
              for (const key of ["filename", "abs_path"] as const) {
                const url = frame[key];
                if (typeof url === "string") scrubbedFrame[key] = stripQueryAndFragment(url);
              }
              return scrubbedFrame;
            })
          }
        };
      })
    };
  }
  // Also handle breadcrumbs supplied on the event rather than through addBreadcrumb.
  if (event.breadcrumbs) scrubbed.breadcrumbs = event.breadcrumbs.map(scrubSentryBreadcrumb);
  return scrubbed;
}
