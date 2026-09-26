# @easytestdata/core

Realistic test data for QuickBooks Online sandboxes.

The EasyTestData generation engine: deterministic, financially coherent synthetic accounting
data (customers, vendors, employees, invoices, bills, payments, payroll, deposits, journal
entries and more) for QuickBooks Online (QBO) sandboxes and anywhere else you need a believable
set of books. Zero runtime dependencies. Use [`easytestdata`](https://www.npmjs.com/package/easytestdata)
for the CLI or [`@easytestdata/qbo-client`](https://www.npmjs.com/package/@easytestdata/qbo-client)
to load a plan into a QBO sandbox.

[![npm](https://img.shields.io/npm/v/@easytestdata/core)](https://www.npmjs.com/package/@easytestdata/core)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

## Install

```bash
npm install @easytestdata/core
```

Requires Node.js 22.13 or later.

## Quick start

```js
import { generate, exportToCsv } from "@easytestdata/core";

const plan = generate({ template: "saas", preset: "rapid-growth", months: 12, seed: 42 });

console.log(plan.metrics.totalRevenueGenerated, plan.customers[0].name, plan.invoices.length);
const csvTables = exportToCsv(plan); // { customers, invoices, invoice_lines, ... }
```

`generate()` accepts:

| Option                                        | Default                   | Notes                                                                                                                              |
| --------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `template`                                    | `"professional-services"` | One of the 8 industry templates below. Unknown ids throw.                                                                          |
| `preset`                                      | none                      | One of the 8 scenarios below. Unknown ids throw.                                                                                   |
| `startDate`, `endDate`                        | see `months`              | `YYYY-MM-DD`.                                                                                                                      |
| `months`                                      | `12`                      | Without dates: the full calendar months before today.                                                                              |
| `seed`                                        | random                    | Same seed + same explicit dates = byte-identical output.                                                                           |
| `totalRevenue`, `targetEbitda`                | 500000, 100000            | Numbers or strings like `"1.5M"`, `"500k"`, `"-50k"`. `targetEbitda` is the target profit before credits, refunds and adjustments. |
| `customerCount`, `topCustomerCount`           | 15, 3                     |                                                                                                                                    |
| `clientConcentrationPercent`, `employeeCount` | 40, 5                     |                                                                                                                                    |
| `includeBenefits`, `country`, `tag`, `ratios` | false, `"US"`, `"EZTD"`   | `country`: US, GB, AU, CA. `ratios`: e.g. `{ invoicePaymentRate: 0.7 }`                                                            |

Precedence is: explicit option > preset > default. The default period is relative to today, so
pass `startDate` (or `startDate` + `endDate`) for fully reproducible fixtures. Every ratio must
fall within `RATIO_BOUNDS` and a period may span at most `MAX_MONTHS` (120) calendar months;
unknown or out-of-range values throw.

## Industry templates

8 industry templates with their own service items, expense categories and financial ratios:

- `professional-services`: Consulting firms, agencies, law practices. 92% invoiced, 8% cash.
  Default template.
- `saas`: Software-as-a-service companies. Subscription and usage revenue, 95% invoiced.
- `restaurant`: Restaurants and food service. 85% cash sales, 32% of spend on food and
  ingredients.
- `construction`: General contractors. Estimates on 80% of jobs, purchase orders, 30-90 day
  collections.
- `retail`: Brick-and-mortar and e-commerce stores. 80% cash sales, 45% cost of goods.
- `healthcare`: Medical practices and clinics. Patient and lab services, 30-90 day payment
  delays.
- `nonprofit`: Charitable organizations. Donations, grants, program fees, and program expenses.
- `real-estate`: Property management. Rent, management fees, and late fees; 85% invoiced.

## Scenarios

8 scenarios (the `preset` option) that bundle realistic parameter sets and ratio tweaks:

- `quick-demo`: small company over 3 months, for a fast first load
- `healthy-small`: healthy small business, steady margins
- `cash-crisis`: cash-flow crunch, slow-paying customers
- `rapid-growth`: fast-growing company, aggressive hiring
- `seasonal`: seasonal business, larger quarter-end swings
- `mature-stable`: steady, established company
- `audit-nightmare`: messy books: credits, refunds and adjustments
- `new-company`: brand-new company, low volume

## Plan shape

Customers, vendors and employees are realistic, locale-aware and unique across the plan (QBO
requires unique display names), for example
`{ id: "CUST-001", name: "Reyes Architects", email, phone, address }`. Transactions reference
parties by `name`. Generated records are marked with the `tag` (default `EZTD`) in document
numbers, memos and a per-entity tag field so they can be purged safely. Names never carry the
tag.

## Lower-level API

- `resolveRequest(options)` → `{ request, ratioOverrides }` after applying preset and defaults
- `resolvePeriod({ startDate, endDate, months, today })` → `{ startDate, endDate }`; `today` is
  a `Date` (default `new Date()`) and only matters when no dates are given
- `normalizeRequest(request)` validates a fully specified request
- `resolveConfig(templateIdOrObject, { ratios }, country)` merges defaults, template and overrides
- `buildSyntheticPlan(input, config, { seed })` builds the plan
- `exportToJson(plan)` / `exportToCsv(plan)` format a plan for download
- `listIndustryTemplates()`, `listScenarioPresets()`, `getIndustryTemplate(id)`,
  `getScenarioPreset(id)`, `parseAmount(value)`

## License

[Apache-2.0](LICENSE)

QuickBooks is a registered trademark of Intuit Inc. EasyTestData is not affiliated with or
endorsed by Intuit.
