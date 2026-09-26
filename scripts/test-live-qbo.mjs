#!/usr/bin/env node

// Loads a tiny generated company into a real QuickBooks Online sandbox, rolls it back and purges
// what is left, through the same code the app and the CLI use. It uses the connection
// `npx easytestdata auth` saved in .easytestdata.json in the current directory (or the QBO_*
// environment variables the CLI also reads), and saves a refreshed token back the same way.
//
// Usage: pnpm run test:qbo-live [-- --connection <name>]
import { generate } from "../packages/core/src/index.js";
import {
  QboClient,
  loadPlanIntoQbo,
  purgeTransactions,
  rollbackLoad
} from "../packages/qbo-client/src/index.js";
import {
  loadConfig,
  persistRefreshToken,
  requireConnection
} from "../packages/cli/src/config-loader.js";

const log = (message) => console.log(`[test:qbo-live] ${message}`);
const connectionFlag = process.argv.indexOf("--connection");
const connectionName = connectionFlag === -1 ? undefined : process.argv[connectionFlag + 1];

const fileConfig = loadConfig();
const client = new QboClient({
  ...requireConnection(fileConfig, connectionName),
  onTokenRefresh: (tokens) => persistRefreshToken(fileConfig, connectionName, tokens),
  onWarning: (message) => log(`warning: ${message}`)
});

await client.ensureAccessToken();
log("token is valid");

// One fixed tag for every run: purge touches only this check's records, and the tag-named accounts
// a load creates (QuickBooks accounts are never deleted) are reused instead of piling up.
const tag = "EZTDLIVE";
const plan = generate({
  template: "professional-services",
  startDate: "2025-01-01",
  endDate: "2025-01-15",
  totalRevenue: 4000,
  targetEbitda: 500,
  customerCount: 2,
  employeeCount: 1,
  seed: 42,
  tag
});

/** Throws when QuickBooks refused some records, so a partial success never reads as passing. */
function requireNoFailures(step, report) {
  const failures = report?.failures ?? [];
  if (failures.length > 0) {
    throw new Error(
      `${step}: QuickBooks refused ${failures.length} record(s): ${JSON.stringify(failures.slice(0, 3))}`
    );
  }
}

try {
  // Clear anything an earlier interrupted run left under this tag.
  requireNoFailures(
    "purge before load",
    await purgeTransactions(client, { mode: "generated", tag }, () => {})
  );

  const result = await loadPlanIntoQbo(client, plan, null, () => {});
  requireNoFailures("load", result);
  log(`loaded ${Object.values(result.counts).reduce((sum, n) => sum + n, 0)} records (tag ${tag})`);

  const rollback = await rollbackLoad(client, result.ledger, () => {});
  requireNoFailures("rollback", rollback);
  log(`rolled back ${rollback.totalDeleted} deleted, ${rollback.totalInactivated} made inactive`);

  requireNoFailures("purge", await purgeTransactions(client, { mode: "generated", tag }, () => {}));
  log("purged what was left");
} finally {
  // Leave the sandbox as it was even when a step failed partway, a partial load included.
  await purgeTransactions(client, { mode: "generated", tag }, () => {}).catch((err) =>
    log(`cleanup purge failed: ${err.message}`)
  );
}
log("all checks passed");
