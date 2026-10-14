---
"@easytestdata/server": patch
---

Keep Sentry 11 from collecting more than Sentry 10 did: request bodies, cookies, user details and database query data stay out of reports, and transactions go through the URL scrubber again, so tokens in query strings are never sent.
