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
