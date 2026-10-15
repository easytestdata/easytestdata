---
"@easytestdata/server": minor
---

Add a server extension contract with routers, extension-owned migrations and lifecycle hooks.
Publish the exact shared bindings at `@easytestdata/server/extension` and startup/migration helpers
at `@easytestdata/server/start`. Both subpaths can be imported without listening, running migrations
or opening the database; packed-install verification now checks them alongside the CLI smoke test.
