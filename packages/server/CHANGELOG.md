# @easytestdata/server

## 0.2.0

### Minor Changes

- c7e68ea: Add a server extension contract with routers, extension-owned migrations and lifecycle hooks.
  Publish the exact shared bindings at `@easytestdata/server/extension` and startup/migration helpers
  at `@easytestdata/server/start`. Both subpaths can be imported without listening, running migrations
  or opening the database; packed-install verification now checks them alongside the CLI smoke test.

### Patch Changes

- @easytestdata/core@0.2.0
  - @easytestdata/qbo-client@0.2.0
  - @easytestdata/shared@0.2.0

## 0.1.1

### Patch Changes

- f802eb6: Keep credentials in URLs out of Sentry. Sentry 11 collects no more than Sentry 10 did (no request bodies, cookies, user details or database query data), transactions go through the URL scrubber again, URL-bearing headers such as Referer and Location are not collected, and query strings and fragments are removed from every URL Sentry reports, so OAuth codes and invite tokens are never sent.
- @easytestdata/core@0.1.1
  - @easytestdata/qbo-client@0.1.1
  - @easytestdata/shared@0.1.1

## 0.1.0

First public release.
