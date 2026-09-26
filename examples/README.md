# Examples

Runnable examples. The library and fixture examples run in CI, so they stay in sync with the code.

| Example                                                                      | What it shows                                                                  |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [`library/quickstart.mjs`](library/quickstart.mjs)                           | Generate a year of books and write one CSV per table                           |
| [`library/custom-scenario.mjs`](library/custom-scenario.mjs)                 | Combine a template, a scenario, and explicit overrides                         |
| [`fixtures/invoices.test.js`](fixtures/invoices.test.js)                     | Deterministic test fixtures with a fixed seed                                  |
| [`github-actions/seed-qbo-sandbox.yml`](github-actions/seed-qbo-sandbox.yml) | Seed a QBO sandbox in CI, run tests, purge, and save the rotated refresh token |

From a clone of this repo, after `pnpm install`:

```bash
node examples/library/quickstart.mjs
pnpm --filter @easytestdata/examples test
```

In your own project, install the package instead: `npm install @easytestdata/core`.
