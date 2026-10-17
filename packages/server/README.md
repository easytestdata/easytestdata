# @easytestdata/server

Realistic test data for QuickBooks Online sandboxes.

The server behind EasyTestData: the API, the job runner that loads and removes data in a
QuickBooks Online sandbox, and the built web app. It powers both EasyTestData Cloud and local
mode.

[![npm](https://img.shields.io/npm/v/@easytestdata/server)](https://www.npmjs.com/package/@easytestdata/server)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

You normally don't install this package yourself. To run the app on your own computer, use the
CLI, which starts this server for you:

```bash
npx easytestdata ui
```

See [running it locally](https://github.com/easytestdata/easytestdata/blob/main/docs/run-locally.md)
for the options, and the [repository](https://github.com/easytestdata/easytestdata) for how it
fits together.

> **Sandbox only by design.** EasyTestData only talks to
> `https://sandbox-quickbooks.api.intuit.com` and never connects to a production QuickBooks
> company.

Requires Node.js 22.13 or later. Licensed under [Apache-2.0](LICENSE).

## Server extensions

`@easytestdata/server` exports `createApp({ extensions = [], webDistDir } = {})` for constructing
an Express app. `@easytestdata/server/start` exports `bootstrap`, `handleShutdownSignals`,
`runMigrations` and `runMigrationCommand`. Importing `/start` or `/extension` never listens, runs
migrations or opens the database. These are JavaScript entry points; this package does not promise
declaration files. Existing zero-argument calls remain valid.

An extension descriptor is a plain object with a required unique `name` matching
`/^[a-z][a-z0-9-]{1,30}$/`. The names `auth`, `connections`, `jobs`, `templates`, `teams`, `admin`,
`setup`, `config` and `health` are reserved. All other fields are optional:

| Field                            | Contract                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------- |
| `router`                         | Express router mounted at `/api/v1/<name>`                                                  |
| `migrationsDir`                  | Non-empty path to extension-owned SQL migrations; prefer an absolute path                   |
| `onStart({ config, logger })`    | Awaited during startup, in descriptor order                                                 |
| `onStopping({ config, logger })` | Signals cancellation and refuses new work before HTTP drain; must not await operation drain |
| `onStop({ config, logger })`     | Awaits operation drain and persistence before database closure                              |
| `jobs`                           | `{ [kind]: { run(ctx), needsSandbox, timeoutMinutes? } }`, run by the shared job runner     |

Descriptors are validated before startup side effects. Routers mount in descriptor order after
built-in API routes and before the SPA and error handler. Global middleware still applies,
including local request guards, JSON parsing, request IDs and Cloud rate limits. Each router must
explicitly install `authenticate` and its role and tenant checks; mounting does not authenticate
it. An absolute `webDistDir` selects a different built web app; omitting it preserves the default
workspace-then-packed lookup.

For example, an entry point in a consumer package can start the server or run only its migrations:

```js
import express from "express";
import { fileURLToPath } from "node:url";
import { authenticate } from "@easytestdata/server/extension";
import { bootstrap, handleShutdownSignals, runMigrationCommand } from "@easytestdata/server/start";

const router = express.Router();
router.use(authenticate);
router.get("/ping", (req, res) => res.json({ teamId: req.user.teamId }));

const extensions = [
  {
    name: "demo-ext",
    router,
    migrationsDir: fileURLToPath(new URL("./migrations", import.meta.url))
  }
];

if (process.argv.includes("--migrate")) {
  await runMigrationCommand({ extensions });
} else {
  const { close } = await bootstrap({ extensions });
  handleShutdownSignals(close);
}
```

### Shared extension API

`@easytestdata/server/extension` exports exactly the bindings below. Each is the same object or
function used internally, sharing one config, logger, database adapter and connection-lock map per
process:

| Source                    | Exports                                                                |
| ------------------------- | ---------------------------------------------------------------------- |
| Database                  | `query`, `transaction`, `rollback`                                     |
| Token encryption          | `encryptTokenPair`, `decryptTokenPair`, `encryptValue`, `decryptValue` |
| Browser-bound OAuth state | `beginOAuthState`, `consumeOAuthState`, `OAuthStateError`              |
| Authentication            | `authenticate`, `requireRole`, `requireTeamManager`                    |
| Connection locking        | `withConnectionLock`, `ConnectionLockBusyError`                        |
| Team row locking          | `lockTeam`                                                             |
| Errors                    | `AppError`                                                             |
| Logging                   | `logger`                                                               |
| Configuration             | `config`                                                               |
| Extension jobs            | `enqueueExtensionJob`, `getExtensionJob`, `cancelExtensionJob`         |

An extension job is a `jobs` row of type `extension` (`config = { extension, kind, payload }`),
queued with `enqueueExtensionJob` under the same guards as every job and run in the QuickBooks lane.
A `needsSandbox` handler receives `ctx.target`, a frozen object over a locked, sandbox-only client
(minor version 75): the only way an extension writes to QuickBooks. `AGENTS.md` ("Extension jobs")
has the full contract and outcome rules.

The API does not export `QboClient`, `buildLockedQboClient` or a general raw company HTTP helper.
`withConnectionLock(connectionId, fn)` fails immediately with `ConnectionLockBusyError` when the
server or another extension holds that connection's lock; it does not wait or queue. The caller
chooses how to handle contention (for example, HTTP 409). The lock releases in `finally`, including
when `fn` throws. Inside `transaction(fn)`, use only the supplied client's `query`; return
`rollback(value)` to roll back while returning a value. Pass that client to `lockTeam(client,
teamId)` and preserve the server's row-lock order: team before connection before membership.
Scope tenant data to the authenticated `req.user.teamId`.

### Lifecycle ordering

`bootstrap({ listen = true, exit = ..., extensions = [], webDistDir } = {})` runs startup checks,
local secrets and the single-server lock before core and extension migrations (`closePool: false`),
local identity and the credentials warning. It then awaits extension starts in descriptor order,
starts the job runner, constructs `createApp({ extensions, webDistDir })` and listens.

A descriptor is registered as startup traverses it, after its `onStart` resolves when present;
descriptors without `onStart` are registered too. A throwing `onStart` must clean up its own partial
resources. Only registered extensions receive shutdown hooks, all with `{ config, logger }`:

- Normal `close()`: reverse `onStopping` hooks → HTTP close → runner stop → reverse `onStop` hooks
  → database close → single-server lock release in `finally`.
- Failed startup: reverse `onStopping` hooks → runner stop → HTTP close → reverse `onStop` hooks
  → database close → lock release. The original startup error is rethrown.

`onStopping` runs before HTTP close because active responses must be able to finish after
cancellation; await operation drain and persistence in `onStop` while the database is still open.
Each hook is a separate cleanup step, so one failure cannot skip siblings or HTTP, runner and
database cleanup. Normal shutdown rethrows the first cleanup error and logs later ones. `close()`
is idempotent and shares its promise; each registered hook runs at most once per shutdown.

### Extension migrations

`runMigrationCommand({ extensions = [] } = {})` validates descriptors and runs migrations without
HTTP, a job runner or lifecycle hooks. The direct migrate CLI uses it too. In local mode it creates
the private data directory and takes the existing data-folder lock before opening PGlite, refusing
a held lock without database work and always releasing it afterwards. In Cloud it keeps the
migration advisory lock without taking the running-server lock. The lower-level
`runMigrations({ closePool = true, extensions = [] } = {})` closes the database by default;
bootstrap passes `closePool: false` to keep it open.

Core migrations run first, then extension directories in descriptor order. Filenames must match
`/^\d{3}_[a-z0-9_]+\.sql$/`, with unique contiguous numeric prefixes; files apply in lexical order,
each atomically with its tracking row. Core owns `_migrations`; an extension owns
`_migrations_<name with hyphens replaced by underscores>`. A recorded migration without a file on
disk is refused. Applied files are immutable: add new migrations instead of editing, renaming or
removing applied files. Tracking records filenames, not content hashes. Extensions own their
schema; they must preserve core tables, job types and the sandbox-only assertions.
