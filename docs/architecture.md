# How EasyTestData fits together

Everything in this monorepo is open source under [Apache-2.0](../LICENSE), including the server,
web app, and marketing site behind EasyTestData Cloud. EasyTestData Cloud and
`npx easytestdata ui` on your own computer run the same code.

## Packages

| Package               | Published to npm             | Description                                                                                                         |
| --------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `packages/core`       | Yes                          | Deterministic synthetic financial data generation engine. No external dependencies.                                 |
| `packages/qbo-client` | Yes                          | QuickBooks Online (QBO) API client with OAuth, rate limiting, batch ops, and the load/purge/rollback orchestrators. |
| `packages/cli`        | Yes (`easytestdata`)         | Commander-based CLI: `generate`, `plan`, `templates`, `scenarios`, `auth`, `load`, `purge`, `ui`.                   |
| `packages/shared`     | Yes                          | Zod schemas, constants and the typed API client and hooks shared by the server and the web app.                     |
| `packages/server`     | Yes                          | Express API with an in-process job runner. Ships the built web app, so `easytestdata ui` can serve it.              |
| `packages/ui`         | No                           | Internal React component library (shadcn/ui primitives + business components). Workspace-only.                      |
| `packages/web`        | No (bundled into the server) | The web app (React + Vite), for Cloud and local mode.                                                               |
| `packages/marketing`  | No                           | Static site for easytestdata.com (custom Node.js builder + Tailwind), including the in-browser playground.          |

Dependency direction: `core` has no internal dependencies; `qbo-client` depends on `core`; the
server depends on `core`, `qbo-client`, and `shared`; the CLI depends on `core`, `qbo-client`
and the server (loaded only by `ui`); the web app depends on `shared` and `ui` and talks to the
server only over HTTP.

## Where it runs

|          | EasyTestData Cloud                                 | Local (`npx easytestdata ui`)                      | Website                                 |
| -------- | -------------------------------------------------- | -------------------------------------------------- | --------------------------------------- |
| Process  | One Node process behind nginx, Cloudflare in front | One Node process on `127.0.0.1:28080`              | Static files on Cloudflare Pages        |
| Database | Postgres                                           | PGlite (embedded Postgres) in `~/.easytestdata/db` | none                                    |
| Sign-in  | Google, GitHub or Intuit                           | none: one built-in user and team                   | n/a                                     |
| Limits   | Per team (see below)                               | none                                               | n/a                                     |
| Contents | Web app, REST API, job runner                      | The same                                           | Marketing pages, docs, blog, playground |

`DEPLOYMENT=cloud|local` picks the mode (unset: `cloud` when `DATABASE_URL` is set, else
`local`). Guides: [run-locally.md](run-locally.md), [deploy-cloudpanel.md](deploy-cloudpanel.md),
[cloudflare-pages.md](cloudflare-pages.md).

- **EasyTestData Cloud** applies per-team abuse limits (3 connections, 10 loads/month, 5,000
  records/job, 5 members; see `packages/shared/src/constants.js`) and signs users in with
  Google, GitHub or Intuit only. There are no passwords, and nothing sends email: team invites
  are links to copy. It is free.
- **Local mode** has no sign-in, so it listens on loopback only and refuses requests that could
  come from another website or a proxy (wrong `Host`, a foreign `Origin`, no `X-EasyTestData: 1`
  header on a change, or forwarding headers). Teams, invites and the admin area are hidden. The
  user brings their own Intuit developer app, entered on a first-run setup screen.

## Request flows

**CLI (no server involved).**

```text
easytestdata generate/plan      core.generate()  ->  plan  ->  JSON / CSV files or a summary
easytestdata load               core.generate()  ->  plan  ->  qbo-client.loadPlanIntoQbo()  ->  QBO sandbox API
easytestdata purge              qbo-client.purgeTransactions()  ->  QBO sandbox API
easytestdata auth               browser OAuth (Intuit)  ->  tokens saved to .easytestdata.json
easytestdata ui                 starts the server in local mode and opens the web app
```

The playground on easytestdata.com runs `core` in the browser in the same way.

**Web app and REST API.**

```text
web app
   |  HTTPS (Cloud: JWT) or http://localhost (local: no sign-in)
   v
server (Express)  -- validates with shared Zod schemas, checks team membership and limits
   |  POST /jobs takes a template + config and snapshots it (with a seed) into jobs.config,
   |  as a `pending` row
   v
job runner        -- in the same process: polls pending rows, claims one with
   |                 UPDATE ... WHERE status = 'pending'; QBO jobs (load, purge, rollback) up to
   |                 QBO_WORKER_CONCURRENCY at once (default 6, one active per team), file jobs
   |                 (generate, export) up to 5
   v
job               -- core.buildSyntheticPlan()
   |                   generate/export: write JSON + CSV files for download
   |                   load/purge: take the in-process per-connection lock, decrypt tokens,
   |                   qbo-client.loadPlanIntoQbo() / purgeTransactions()  ->  QBO sandbox API
   v
progress          -- emit(step, totalSteps, message)  ->  jobs.progress  ->  web app polls every 2 s
```

Long operations accept an `AbortSignal`, so cancelling a job, the job timeout or a server
shutdown stops the load or purge between batches. A load records a ledger of what it created, so
a failed load can be rolled back. When the server starts, jobs a previous process left `running`
are marked failed ("Interrupted by a server restart", with a hint to use Remove test data), jobs left
`cancelling` are marked cancelled with the same hint, and queued jobs run as normal.

## Data model

Postgres (PGlite in local mode) holds all durable state; the schema is one baseline migration in
`packages/server/src/db/migrations`. Short-lived state (OAuth state and exchange codes, rate
limit counters, connection locks) lives in process memory: there is one server process.

| Table             | What it stores                                                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `teams`           | The tenant. Everything below except `users` and `app_settings` belongs to a team.                                      |
| `users`           | Accounts: email (lower-cased, verified by the sign-in provider), OAuth identity, active team, `is_admin`.              |
| `team_members`    | Which users belong to which team, with a role (`owner`, `admin`, `member`).                                            |
| `team_invites`    | Pending invitations: email, role, and a single-use token.                                                              |
| `jobs`            | Generate, export, load, purge, and rollback runs: config snapshot, status, progress, result. Also the job queue.       |
| `qbo_connections` | Connected sandbox companies: realm ID, AES-256-GCM encrypted access and refresh tokens (per-row IV), sandbox base URL. |
| `refresh_tokens`  | Hashed session refresh tokens (Cloud), for the session flows described in `AGENTS.md`.                                 |
| `app_settings`    | Local mode only: the Intuit app keys entered on the setup screen, encrypted.                                           |

## Security model highlights

- **Sandbox only.** `QboClient` only talks to `https://sandbox-quickbooks.api.intuit.com` and
  refuses any other API host, so neither the CLI nor the server can write to a production
  QuickBooks company.
- **Tag-based purge.** Every generated record carries the tag (default `EZTD`) in a tag field,
  document number, or memo. `purge --mode generated` deletes only tagged transactions and makes
  tagged customers, vendors, employees and items inactive (QBO does not allow deleting them);
  accounts stay. Names are never used to decide what to delete. `--mode all` exists for wiping a
  sandbox and needs the owner or admin role in the web app.
- **Per-team isolation.** Every query filters by the caller's team. Team membership and role are
  read from the database on every request, so removing a member revokes access at once.
- **Secrets at rest.** QBO tokens (and, in local mode, the saved Intuit app keys) are encrypted
  with `TOKEN_ENCRYPTION_KEY`, which local mode generates into `~/.easytestdata/secret.key`;
  session refresh tokens are stored hashed; one-time tokens are consumed atomically.
- **Local mode is loopback only.** It binds `127.0.0.1`, has no option to bind elsewhere, and
  must never be put behind a reverse proxy.

See [SECURITY.md](../SECURITY.md) to report a vulnerability.
