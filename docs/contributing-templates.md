# Contributing Templates and Scenarios

This guide explains how to contribute new industry templates or scenarios to EasyTestData. Both
are plain data and the best first contributions.

## Industry Templates

Industry templates define the financial profile of a business type — service items, expense categories, and ratio overrides.

### Template Structure

```json
{
  "name": "Veterinary Clinic",
  "description": "Animal healthcare with exam fees, surgery, and medical supplies",
  "serviceItems": [
    {
      "suffix": "Exam",
      "name": "Examination Fees",
      "accountType": "Income",
      "subType": "ServiceFeeIncome",
      "weight": 0.4
    },
    {
      "suffix": "Surgery",
      "name": "Surgical Procedures",
      "accountType": "Income",
      "subType": "ServiceFeeIncome",
      "weight": 0.35
    },
    {
      "suffix": "Meds",
      "name": "Medications & Vaccines",
      "accountType": "Income",
      "subType": "SalesOfProductIncome",
      "weight": 0.25
    }
  ],
  "expenseCategories": [
    {
      "name": "Medical Supplies",
      "accountType": "Expense",
      "subType": "SuppliesMaterials",
      "weight": 0.3
    },
    {
      "name": "Rent",
      "accountType": "Expense",
      "subType": "RentOrLeaseOfBuildings",
      "weight": 0.2
    },
    {
      "name": "Staff Salaries",
      "accountType": "Expense",
      "subType": "CostOfLaborCos",
      "weight": 0.3
    },
    {
      "name": "Insurance",
      "accountType": "Expense",
      "subType": "Insurance",
      "weight": 0.1
    },
    {
      "name": "Equipment Maintenance",
      "accountType": "Expense",
      "subType": "RepairMaintenance",
      "weight": 0.1
    }
  ],
  "ratios": {
    "invoicedRevenueShare": 0.7,
    "cashSalesShare": 0.3
  }
}
```

### Field Reference

**Service Items** (1-10 items):

- `suffix` — Unique short identifier (appended to QBO item names)
- `name` — Human-readable service/product name
- `accountType` — Must be `"Income"`
- `subType` — One of: `ServiceFeeIncome`, `SalesOfProductIncome`, `OtherPrimaryIncome`, `NonProfitIncome`, `RentalIncome`
- `weight` — Revenue share (0-1). Weights don't need to sum to 1 (they're normalized).

**Expense Categories** (1-15 items):

- `name` — Unique category name
- `accountType` — Must be `"Expense"`
- `subType` — One of: `RentOrLeaseOfBuildings`, `Utilities`, `Insurance`, `OfficeGeneralAdministrativeExpenses`, `LegalProfessionalFees`, `Travel`, `DuesSubscriptions`, `EntertainmentMeals`, `SuppliesMaterials`, `RepairMaintenance`, `EquipmentRental`, `Auto`, `CostOfLaborCos`, `OtherMiscServiceCost`, `Advertising`, `TravelMeals`, `Shipping`, `Stationery`
- `weight` — Expense share (0-1). Weights don't need to sum to 1.

**Ratios** (optional overrides):

- Override any default financial ratio. See `packages/core/src/templates/schema.js` for the full list of valid ratio keys.

### Step-by-Step

1. **Fork** the repository and create a branch: `git checkout -b template/your-industry`
2. **Create** your template as a JSON file (use the structure above)
3. **Validate** it:
   ```bash
   node packages/core/src/templates/validate-cli.js your-template.json
   ```
4. **Add** the template at the end of `packages/core/src/templates/industries/data.js` (the key is
   the template id):
   ```js
   "your-industry": {
     name: "Your Industry",
     description: "...",
     serviceItems: [...],
     expenseCategories: [...],
     ratios: {...}
   }
   ```
5. **Try it**: `node packages/cli/bin/easytestdata.js plan --template your-industry --seed 1`
6. **Run tests**: `pnpm --filter @easytestdata/core run test` and
   `pnpm --filter easytestdata run test`. The tests read the registry, so you don't need to
   update any counts in them.
7. **Update the docs**: add a row to the templates table in the root `README.md` (use the same
   `description`), and bump the "8 industry templates" count where it appears (`README.md`,
   `packages/core/README.md`, `packages/cli/README.md`, `docs/brand.md`, and the page
   descriptions in `packages/marketing/src`; `grep -rn "8 industry" .` finds them). The site's
   page bodies compute the count from core at build time.
8. **Submit a PR** with a brief description of the industry and why it's useful

## Scenarios

Scenarios (the CLI's `--scenario` flag and the `preset` option in core) are pre-configured parameter
bundles that simulate real-world business conditions. In user-facing copy they are called
"scenarios", never "presets" or "profiles".

### Scenario Structure

Scenarios live in `packages/core/src/templates/scenarios/data.js`, keyed by id. Each entry repeats
its `id`, sets any of the `generate()` request fields in `request`, and can tweak the template's
ratios in `ratioOverrides` (valid keys are listed in `packages/core/src/templates/schema.js`):

```js
"late-payers": {
  id: "late-payers",
  name: "Late payers: healthy sales, slow collections",
  description: "Healthy revenue, but customers pay slowly and often in part.",
  request: {
    totalRevenue: 800000,
    targetEbitda: 90000,
    customerCount: 25,
    topCustomerCount: 4,
    clientConcentrationPercent: 45,
    employeeCount: 6,
    includeBenefits: false
  },
  ratioOverrides: {
    invoicePaymentRate: 0.7,
    paymentDelayMinDays: 30,
    paymentDelayMaxDays: 75,
    partialPaymentRate: 0.35
  }
}
```

`request` accepts `totalRevenue`, `targetEbitda` (the target profit before credits, refunds and
adjustments), `customerCount`, `topCustomerCount`, `clientConcentrationPercent`, `employeeCount`
and `includeBenefits`. Explicit options and CLI flags always win over the scenario. Name the
scenario for the outcome a user wants ("Cash-flow crunch: slow-paying customers"), not for the
mechanism.

### Contributing a Scenario

1. Fork and branch: `git checkout -b scenario/your-scenario`
2. Add the scenario at the end of `packages/core/src/templates/scenarios/data.js`
3. Try it: `node packages/cli/bin/easytestdata.js plan --scenario your-scenario --seed 1`
4. Run tests: `pnpm --filter @easytestdata/core run test` and `pnpm --filter easytestdata run test`.
   The tests read the registry, so you don't need to update any counts in them.
5. Add a row to the scenarios table in the root `README.md`, and bump the "8 scenarios" count
   where it appears (`README.md`, `packages/core/README.md`, `packages/cli/README.md`,
   `docs/brand.md`, and the page descriptions in
   `packages/marketing/src`; `grep -rn "8 scenarios" .` finds them). The site's page bodies
   compute the count from core at build time.
6. Submit a PR explaining the business scenario it simulates

## Validation

The template validator checks:

- Required fields (name, description, serviceItems, expenseCategories)
- Field types and value ranges (weights between 0-1, valid subtypes)
- No duplicate suffixes in service items
- No duplicate names in expense categories
- Valid ratio keys (if provided)
- Length limits (name: 100 chars, description: 500 chars)
