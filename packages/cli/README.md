# easytestdata

Realistic test data for QuickBooks Online sandboxes.

EasyTestData generates financially coherent synthetic accounting data (customers, vendors,
employees, invoices, bills, payments, payroll, deposits, journal entries and more) and loads it
into a QuickBooks Online (QBO) sandbox company. Revenue, expenses and the target profit add up;
customers, vendors and employees have realistic names and addresses.

Generating files needs no account. Loading into a sandbox needs a free Intuit developer account
and sandbox company; EasyTestData can only connect to sandbox companies.

## Run the web app on your computer

```bash
npx easytestdata ui
```

This starts the EasyTestData web app on `http://localhost:28080` and opens your browser: no
account, no sign-in, no limits, and nothing else to install (the database is built in). Your data
stays in `~/.easytestdata`. Options: `--port <n>`, `--data-dir <path>`, `--no-open`. The first
time you connect a sandbox, a setup screen asks for your Intuit developer app's keys and shows
the redirect URI to register (`http://localhost:28080/api/v1/connections/callback`). The app only
listens on your own computer; never put it behind a proxy or expose it to a network. More in the
[run-it-locally guide](https://github.com/easytestdata/easytestdata/blob/main/docs/run-locally.md).

## Try it offline (no account needed)

```bash
# Node.js 22.13+
npx easytestdata generate --template saas --scenario rapid-growth --seed 42 \
  --start-date 2025-09-01 --format csv --output ./sample-data
```

This writes one CSV per entity type to `./sample-data/` (`customers.csv`, `invoices.csv`,
`invoice_lines.csv`, `bills.csv`, `bill_lines.csv`, `payments.csv`, ...) and prints a summary:

```text
Wrote 22 CSV files to ./sample-data/

EasyTestData plan: saas template · rapid-growth scenario · seed 42 · US · tag EZTD
Period 2025-09-01 to 2026-08-31 (12 months)

  Customers           90      Bills              120
  Vendors             10      Bill payments      102
  Employees           30      Vendor credits       1
  Invoices         1,080      Purchase orders      4
  Payments           952      Expenses            48
  Sales receipts     132      Payroll runs        24
  Credit memos        58      Deposits            89
  Refund receipts      4      Transfers           18
  Estimates          205      Journal entries     17

  Total revenue   $2,000,000.00
  Total expenses  $1,880,000.00
  Target profit     $120,000.00
  Target profit is before credits, refunds and adjustments; QuickBooks' P&L will differ.
```

The same command writes the same files on any machine, on any day. `vendors.csv` also includes
the payroll provider as an extra vendor when the plan has employees.

More offline commands:

```bash
npx easytestdata plan --template restaurant --revenue 1.5M          # preview counts and totals
npx easytestdata generate --seed 1 --start-date 2025-01-01 | jq .metrics   # JSON to stdout
npx easytestdata templates                                          # 8 industry templates
npx easytestdata scenarios                                          # 8 scenarios
```

Requires Node.js 22.13 or later. Install globally with `npm install -g easytestdata` if you prefer
`easytestdata ...` over `npx easytestdata ...`.

## Load into a QBO sandbox

EasyTestData only works with QBO **sandbox** companies. `QboClient` refuses any API host other
than `sandbox-quickbooks.api.intuit.com`, and Intuit development keys can only authorize sandbox
companies. The only OAuth scope requested is `com.intuit.quickbooks.accounting`.

1. **Intuit developer account.** Sign up at [developer.intuit.com](https://developer.intuit.com).
   A sandbox company is created for you (Dashboard > Sandboxes; add one if you have none).
2. **Create an app.** Dashboard > Create an app > QuickBooks Online and Payments, with the
   `com.intuit.quickbooks.accounting` scope. Use the **Development** keys (client ID and secret).
3. **Add the redirect URI.** In the app: Keys & credentials > Development > Redirect URIs, add
   `http://localhost:8085/callback` (or the port you pass with `--port`).
4. **Connect.** Run `npx easytestdata auth --client-id <id> --client-secret <secret>`. Open the printed URL, sign
   in and pick your sandbox company. Tokens and the company (realm) ID are saved to
   `.easytestdata.json` in the current directory; keep that file out of version control.
5. **Load.**

   ```bash
   npx easytestdata load --template saas --scenario rapid-growth --start-date 2025-09-01 --dry-run   # preview only
   npx easytestdata load --template saas --scenario rapid-growth --start-date 2025-09-01
   ```

6. **Purge.** Clear what EasyTestData created (by tag, default `EZTD`):

   ```bash
   npx easytestdata purge
   ```

   Purge deletes the transactions it added, makes its customers, vendors, employees and items inactive (accounts stay), and never touches records you made by hand
   ([details](https://easytestdata.com/faq#purge)): generated records are recognized by a tag
   field, never by name. Datasets loaded with different `--tag` values are purged separately.
   `--mode all` deletes every transaction in the sandbox company. In scripts, pass `-y`: the CLI
   refuses to purge without confirmation in a non-interactive shell.

## Commands

| Command     | What it does                                                            |
| ----------- | ----------------------------------------------------------------------- |
| `generate`  | Write a dataset as JSON or CSV. No QBO connection needed.               |
| `plan`      | Print counts, revenue, expenses and target profit. No QBO connection.   |
| `templates` | List industry templates (`--inspect <name>` for details).               |
| `scenarios` | List scenarios (`--inspect <name>` for details). Alias: `presets`.       |
| `auth`      | Browser OAuth for a sandbox company; saves a named connection.          |
| `load`      | Generate and load into the sandbox (`--dry-run`, `--clear-first`).      |
| `purge`     | Delete generated data (`--mode generated` or `all`, `--tag`, `-y`).     |
| `ui`        | Run the web app on this computer (`--port`, `--data-dir`, `--no-open`). |

`easytestdata <command> --help` shows every flag.

## Generation flags (generate, plan, load)

```
-t, --template <name>      industry template (default: professional-services)
-p, --scenario <id>        scenario, e.g. quick-demo, rapid-growth, cash-crisis
-m, --months <n>           period length in full calendar months (default: 12)
-s, --start-date <date>    first day of the period (YYYY-MM-DD)
-e, --end-date <date>      last day of the period (YYYY-MM-DD)
-r, --revenue <amount>     total revenue for the period, e.g. 750000, 500k, 1.5M
    --profit <amount>      target profit for the period; may be negative, e.g. -50k
-c, --customers <n>        number of customers (1-300)
    --top-customers <n>    number of top customers
    --concentration <pct>  revenue share of the top customers (1-99)
    --employees <n>        number of employees (0-50)
    --benefits / --no-benefits
    --country <code>       US, GB, AU or CA (default: US)
    --tag <tag>            marker written on generated records for purge (default: EZTD)
    --seed <n>             same seed + same dates = byte-identical output (without it a
                           random seed is drawn and printed, so any run can be repeated)
    --ratio <key=value...> e.g. --ratio invoicePaymentRate=0.7
```

`generate` also takes `-f, --format json|csv` and `-o, --output <path>`. Without `--output`,
it writes to `./easytestdata-output/` in a terminal and streams JSON to stdout when piped.

**Period.** With no dates, the period is the 12 full calendar months before today (so the data
appears in QBO's "last 12 months" reports). `--months` with `--start-date` sets the end date.
Because the default is relative to today, pass `--start-date` for fully reproducible fixtures.

**Precedence.** Explicit flag > `--scenario` > `.easytestdata.json` `defaults` > built-in default.

## Industry templates and scenarios

Industry templates: `professional-services`, `saas`, `restaurant`, `construction`, `retail`,
`healthcare`, `nonprofit`, `real-estate`.

Scenarios (`--scenario`): `quick-demo`, `healthy-small`, `cash-crisis`, `rapid-growth`, `seasonal`,
`mature-stable`, `audit-nightmare`, `new-company`.

## Configuration file

`.easytestdata.json` (created by `auth`) holds named connections and optional defaults:

```json
{
  "defaultConnection": "default",
  "connections": {
    "default": { "clientId": "...", "clientSecret": "...", "realmId": "...", "refreshToken": "..." }
  },
  "defaults": { "template": "saas", "scenario": "rapid-growth", "revenue": "1M", "customers": 25 }
}
```

`defaults` takes the generation flags by name (`scenario`, `profit`, `revenue`, `customers`,
`seed`, `startDate`, ...). Use
`--connection <name>` to pick another connection. In CI you can skip the file and set
`QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_REFRESH_TOKEN` and `QBO_REALM_ID`. Intuit rotates
refresh tokens, and the CLI saves the new one to `.easytestdata.json`; the
[GitHub Actions example](https://github.com/easytestdata/easytestdata/blob/main/examples/github-actions/seed-qbo-sandbox.yml)
shows how to write it back to your CI secret.

## Related packages

- [`@easytestdata/core`](https://www.npmjs.com/package/@easytestdata/core): the generator as a
  library (`generate({ template, preset, months, seed })`).
- [`@easytestdata/qbo-client`](https://www.npmjs.com/package/@easytestdata/qbo-client): the
  sandbox-only QBO loader and purger.
- [EasyTestData Cloud](https://app.easytestdata.com): the web app without running anything.

## License

Apache-2.0

QuickBooks is a registered trademark of Intuit Inc. EasyTestData is not affiliated with or
endorsed by Intuit.
