# Contributing to EasyTestData

Thank you for your interest in contributing to EasyTestData! This guide will help you get started.

## Development Setup

### Prerequisites

- Node.js 24 (`.nvmrc`; CI and EasyTestData Cloud run on 24). The published packages also
  support Node 22.13+, which CI checks.
- pnpm 9.15.4+ (`corepack enable && corepack prepare pnpm@9.15.4 --activate`)

No database server or Docker: the server's local mode uses an embedded Postgres (PGlite).

### Getting Started

```bash
git clone https://github.com/easytestdata/easytestdata.git
cd easytestdata
pnpm install
pnpm run build
pnpm run test
```

### Running the web app locally

```bash
pnpm run dev   # the server in local mode on :28080 and the web app (Vite) on :5173, in watch mode
```

Open http://localhost:5173. The server runs in local mode (no sign-in) with its data in
`~/.easytestdata`, and migrations run automatically when it starts. No `.env` is needed; to
connect a sandbox, enter your Intuit developer app's keys on the setup screen and register the
redirect URI it shows (`http://localhost:5173/api/v1/connections/callback` in development).
`pnpm --filter @easytestdata/marketing run dev` rebuilds the marketing site on changes.

To work on Cloud mode (sign-in, teams, admin), run the server against a real Postgres: put
`DEPLOYMENT=cloud`, `DATABASE_URL`, `PORT` (for example `28000`), `APP_URL`
(`http://localhost:28000`), `JWT_SECRET` and `TOKEN_ENCRYPTION_KEY` (`openssl rand -hex 32` for
both) and at least one sign-in provider's keys in `.env`, then
`pnpm run build && pnpm run start`. See [docs/deploy-cloudpanel.md](docs/deploy-cloudpanel.md)
for every setting.

## Architecture Overview

EasyTestData is a pnpm + Turborepo monorepo. The dependency graph:

```
@easytestdata/core          (pure generation engine, no external deps)
       |
@easytestdata/qbo-client    (QBO API client, depends on core)
       |
@easytestdata/server         (depends on core + qbo-client + shared)
easytestdata (CLI)           (depends on core + qbo-client; `ui` loads the server)
@easytestdata/ui             (shared React components)
@easytestdata/web            (React SPA for Cloud and local mode, depends on shared + ui)
@easytestdata/marketing      (static site; bundles core for the browser playground)
```

### Package Responsibilities

Every package is Apache-2.0. See [docs/architecture.md](docs/architecture.md) for how Cloud and local mode use them.

| Package               | Description                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| `packages/core`       | Synthetic financial data generation engine. Templates, scenarios, config resolver, plan builder, exporters.  |
| `packages/qbo-client` | QBO API client with OAuth, rate limiting, batch operations, load/purge/rollback orchestration.               |
| `packages/cli`        | Commander-based CLI (`easytestdata`). Commands: generate, plan, templates, scenarios, auth, load, purge, ui. |
| `packages/shared`     | Zod validation schemas, constants and the API client shared by the backend and the web frontend.             |
| `packages/server`     | Express API with an in-process job runner; Postgres in Cloud, embedded PGlite in local mode.                 |
| `packages/ui`         | Shared React components (shadcn/ui primitives + business components) used by the web frontend.               |
| `packages/web`        | Web frontend (React + Vite + Tailwind) for Cloud and local mode.                                             |
| `packages/marketing`  | Static marketing site (custom Node.js builder + Tailwind).                                                   |

### Key Data Flow

1. **User starts a job** with a template, a scenario and config overrides
2. **`resolveConfig()`** merges: defaults -> industry template -> user overrides
3. **`buildSyntheticPlan()`** generates a complete plan (customers, vendors, invoices, bills, payments, etc.)
4. **`loadPlanIntoQbo()`** orchestrates 11 phases to create all records in the QBO sandbox
5. All generated records are **tagged** (default prefix: `EZTD`) so purge can find them later

## Your First PR

Industry templates and scenarios are the best first contributions: they are plain data, the
tests read the registry, and the marketing site computes its counts from core.

### Add a Scenario

A scenario (the CLI's `--scenario`) sets the size and shape of the company.

1. Open `packages/core/src/templates/scenarios/data.js`
2. Add a new entry with realistic business parameters (copy an existing one for the shape; see
   [docs/contributing-templates.md](docs/contributing-templates.md)). Give it a plain-English
   name that says what the books look like ("Cash-flow crunch: slow-paying customers"), and
   remember the profit target is before credits, refunds and adjustments
3. Run: `pnpm --filter @easytestdata/core run test` (tests read the registry, so no counts to update)
4. Try it: `node packages/cli/bin/easytestdata.js plan --scenario your-scenario --seed 1`
5. Add a row to the scenarios table in `README.md` and bump the scenario count in `README.md`,
   `packages/core/README.md`, `packages/cli/README.md` and `docs/brand.md`
   (`grep -rn "8 scenarios" .` finds them)

### Add an Industry Template

See [docs/contributing-templates.md](docs/contributing-templates.md), or open an
[industry template proposal](https://github.com/easytestdata/easytestdata/issues/new?template=industry_template.yml)
first if you'd like feedback on the numbers.

## Making Changes

1. Fork the repository and create your branch from `main`
2. Write code in the relevant package under `packages/`
3. Add tests for any new functionality
4. Run `pnpm run check`: the same lint, formatting, build, packed-install, test and audit steps CI
   runs (`pnpm run format` fixes formatting)
5. If you changed a published package (`core`, `qbo-client`, `shared`, `server` or the CLI) in a way users
   will notice, add a changeset: `pnpm changeset` (see [.changeset/README.md](.changeset/README.md))
6. Commit your changes with a clear message

### Testing against a real sandbox

The tests mock QuickBooks. If you change how data is loaded, rolled back or purged
(`packages/qbo-client`), also run the real-sandbox check, which loads a tiny company into a
QuickBooks Online sandbox, rolls it back and purges what is left:

1. Connect a sandbox once from the repository root: `node packages/cli/bin/easytestdata.js auth`
   (it needs an Intuit developer app's development keys; see [docs/run-locally.md](docs/run-locally.md)).
   The connection is saved in `.easytestdata.json`, which git ignores.
2. Run `pnpm run test:qbo-live` (add `-- --connection <name>` for a named connection).

Everything it creates carries the tag `EZTDLIVE`; it purges that tag before and after each run,
even when a step fails, and fails if QuickBooks refuses to delete or deactivate any record.

## Pull Request Guidelines

- Keep PRs focused — one feature or fix per PR
- Include tests for new functionality
- Update relevant documentation if behavior changes
- Reference any related issues in the PR description
- PR title should be descriptive (e.g., "Add veterinary clinic template" not "Update data.js")

## Commit Messages

Conventional-style prefixes are welcome but not required:

```
feat: add veterinary clinic template
fix: correct invoice date calculation for seasonal presets
docs: expand template contribution guide
test: add edge case tests for negative revenue
```

## Reporting Issues

- Use [GitHub Issues](https://github.com/easytestdata/easytestdata/issues/new/choose) for bugs and
  feature requests, and [Discussions](https://github.com/easytestdata/easytestdata/discussions) for
  questions and ideas (see [SUPPORT.md](SUPPORT.md))
- Include reproduction steps; a `--seed` and `--start-date` make generation reproducible
- Specify your Node.js version and operating system
- Never post QBO credentials, tokens, or realm IDs; report security issues as described in
  [SECURITY.md](SECURITY.md)

## Code Style

- **Prettier**: double quotes, semicolons, no trailing commas, 100 char line width
- **ESLint**: `no-unused-vars` warns (prefix unused args with `_`)
- **ES Modules**: `import`/`export` everywhere (no CommonJS)
- **Testing**: vitest for all packages
- **Validation**: Zod schemas in `packages/shared`
- Run `pnpm run lint` and `pnpm run format` before committing

## License

By contributing, you agree that your contributions will be licensed under Apache-2.0. See [LICENSE](LICENSE) for details. This applies to every package in the repository.
