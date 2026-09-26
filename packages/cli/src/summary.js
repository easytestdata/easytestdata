import chalk from "chalk";
import { getLocaleConfig } from "@easytestdata/core";

const COUNT_ROWS = [
  ["Customers", (p) => p.customers.length],
  ["Vendors", (p) => p.vendors.length],
  ["Employees", (p) => p.employees.length],
  ["Invoices", (p) => p.metrics.invoiceCount],
  ["Payments", (p) => p.metrics.paymentCount],
  ["Sales receipts", (p) => p.metrics.salesReceiptCount],
  ["Credit memos", (p) => p.metrics.creditMemoCount],
  ["Refund receipts", (p) => p.metrics.refundReceiptCount],
  ["Estimates", (p) => p.metrics.estimateCount],
  ["Bills", (p) => p.metrics.billCount],
  ["Bill payments", (p) => p.metrics.billPaymentCount],
  ["Vendor credits", (p) => p.metrics.vendorCreditCount],
  ["Purchase orders", (p) => p.metrics.purchaseOrderCount],
  ["Expenses", (p) => p.metrics.directExpenseCount],
  ["Payroll runs", (p) => p.metrics.payrollRunCount],
  ["Deposits", (p) => p.metrics.depositCount],
  ["Transfers", (p) => p.metrics.transferCount],
  ["Journal entries", (p) => p.metrics.journalEntryCount]
];

/**
 * Concise, human-readable summary of a plan (counts + revenue/expenses/net income).
 * With `seedGiven: false` (the run drew a random seed) it also prints how to reproduce the run.
 */
export function formatPlanSummary(plan, { seedGiven = true } = {}) {
  const { currency } = getLocaleConfig(plan.country);
  const money = new Intl.NumberFormat("en-US", { style: "currency", currency });
  const meta = plan.meta || {};
  const heading = [
    `${meta.industry || "custom"} template`,
    meta.preset ? `${meta.preset} scenario` : null,
    `seed ${meta.seed}`,
    plan.country,
    `tag ${plan.tag}`
  ]
    .filter(Boolean)
    .join(" · ");

  const cells = COUNT_ROWS.map(([label, count]) => {
    const value = count(plan).toLocaleString("en-US");
    return `${label.padEnd(16)}${value.padStart(6)}`;
  });
  const half = Math.ceil(cells.length / 2);
  const rows = [];
  for (let i = 0; i < half; i++) {
    rows.push(`  ${cells[i]}      ${cells[i + half] || ""}`.trimEnd());
  }

  const m = plan.metrics;
  const totals = [
    ["Total revenue", m.totalRevenueGenerated],
    ["Total expenses", m.totalExpensesGenerated],
    ["Target profit", m.ebitdaGenerated]
  ];
  const width = Math.max(...totals.map(([, v]) => money.format(v).length));
  const totalLines = totals.map(
    ([label, v]) => `  ${label.padEnd(16)}${money.format(v).padStart(width)}`
  );

  return [
    chalk.bold(`EasyTestData plan: ${heading}`),
    chalk.dim(`Period ${meta.startDate} to ${meta.endDate} (${m.monthCount} months)`),
    "",
    ...rows,
    "",
    ...totalLines.map((line, i) => (i === 2 ? chalk.bold(line) : line)),
    chalk.dim(
      "  Target profit is before credits, refunds and adjustments; QuickBooks' P&L will differ."
    ),
    ...(seedGiven
      ? []
      : [
          "",
          chalk.dim(
            `  Random seed. Re-run with --seed ${meta.seed} --start-date ${meta.startDate} to get the same data.`
          )
        ])
  ].join("\n");
}
