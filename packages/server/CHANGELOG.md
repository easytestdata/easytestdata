# @easytestdata/server

## 0.1.1

### Patch Changes

- f802eb6: Keep credentials in URLs out of Sentry. Sentry 11 collects no more than Sentry 10 did (no request bodies, cookies, user details or database query data), transactions go through the URL scrubber again, URL-bearing headers such as Referer and Location are not collected, and query strings and fragments are removed from every URL Sentry reports, so OAuth codes and invite tokens are never sent.
- @easytestdata/core@0.1.1
  - @easytestdata/qbo-client@0.1.1
  - @easytestdata/shared@0.1.1

## 0.1.0

First public release.
