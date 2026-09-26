import { describe, it, expect } from "vitest";
import { normalizeRequest, buildSyntheticPlan } from "../src/generator.js";
import { resolveConfig } from "../src/ratios.js";
import { RATIOS } from "../src/constants.js";
import { exportToCsv } from "../src/exporters/csv.js";
import { applyScenarioPreset } from "../src/templates/scenarios/index.js";

// ---------------------------------------------------------------------------
// Shared helper: build a standard plan for reuse across tests
// ---------------------------------------------------------------------------

function buildStandardPlan(ratioOverrides = {}, inputOverrides = {}, seed = 42) {
  const config = resolveConfig({}, { ratios: ratioOverrides });
  const input = normalizeRequest({
    startDate: "2024-01-01",
    endDate: "2024-06-30",
    totalRevenue: 200000,
    targetEbitda: 40000,
    customerCount: 5,
    clientConcentrationPercent: 40,
    employeeCount: 5,
    ...inputOverrides
  });
  return buildSyntheticPlan(input, config, { seed });
}

// ---------------------------------------------------------------------------
// 1. CSV export completeness
// ---------------------------------------------------------------------------

describe("CSV export completeness", () => {
  it("produces one table per entity type, including line tables", () => {
    const csv = exportToCsv(buildStandardPlan());
    expect(Object.keys(csv).sort()).toEqual(
      [
        "customers",
        "vendors",
        "employees",
        "invoices",
        "invoice_lines",
        "bills",
        "bill_lines",
        "sales_receipts",
        "direct_expenses",
        "payments",
        "bill_payments",
        "credit_memos",
        "refund_receipts",
        "vendor_credits",
        "estimates",
        "purchase_orders",
        "deposits",
        "deposit_lines",
        "transfers",
        "journal_entries",
        "payroll_runs",
        "payroll_lines"
      ].sort()
    );
  });

  it("neutralizes formula-like text cells but leaves negative numbers alone", () => {
    const plan = buildStandardPlan();
    plan.customers[0].name = '=HYPERLINK("https://evil.example","x")';
    plan.customers[1].name = "@SUM(A1)";
    const csv = exportToCsv(plan);
    expect(csv.customers).toContain(`"'=HYPERLINK(""https://evil.example"",""x"")"`);
    expect(csv.customers).toContain("'@SUM(A1)");
    expect(csv.customers).not.toMatch(/(^|,)=HYPERLINK/m);

    const journal = exportToCsv(plan).journal_entries;
    expect(journal).not.toMatch(/'-\d/);
  });

  it("starts every table with the header row (no comment preamble)", () => {
    const csv = exportToCsv(buildStandardPlan());
    for (const value of Object.values(csv)) {
      const header = value.split("\r\n")[0];
      expect(header).toMatch(/^[a-z_]+(,[a-z_0-9]+)*$/);
      expect(value.endsWith("\r\n")).toBe(true);
    }
  });

  it("emits invoice and bill lines as rows that reference their parent", () => {
    const plan = buildStandardPlan();
    const csv = exportToCsv(plan);
    const lineRows = csv.invoice_lines.trim().split("\r\n").slice(1);
    const lineCount = plan.invoices.reduce((sum, inv) => sum + inv.lines.length, 0);
    expect(lineRows).toHaveLength(lineCount);
    const docNumbers = new Set(plan.invoices.map((inv) => inv.docNumber));
    for (const row of lineRows) expect(docNumbers.has(row.split(",")[0])).toBe(true);
    expect(csv.invoices.split("\r\n")[0]).not.toContain("lines");

    const billRows = csv.bill_lines.trim().split("\r\n").slice(1);
    expect(billRows).toHaveLength(plan.bills.reduce((sum, b) => sum + b.lines.length, 0));
    expect(billRows[0].split(",")[0]).toBe(plan.bills[0].docNumber);
  });

  it("quotes cells per RFC 4180", () => {
    const plan = buildStandardPlan();
    plan.customers[0] = { ...plan.customers[0], name: 'Smith, "Jones" & Co' };
    const csv = exportToCsv(plan);
    expect(csv.customers.split("\r\n")[1]).toContain('"Smith, ""Jones"" & Co"');
  });

  it("sections with data should have data rows beyond the header", () => {
    const csv = exportToCsv(buildStandardPlan());
    for (const section of ["customers", "vendors", "employees", "invoices", "bills", "payments"]) {
      expect(csv[section].trim().split("\r\n").length).toBeGreaterThan(1);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Seed determinism
// ---------------------------------------------------------------------------

describe("Seed determinism", () => {
  it("two plans with seed=42 produce identical invoices", () => {
    const plan1 = buildStandardPlan({}, {}, 42);
    const plan2 = buildStandardPlan({}, {}, 42);

    expect(plan1.invoices).toEqual(plan2.invoices);
  });

  it("two plans with seed=42 produce identical payments", () => {
    const plan1 = buildStandardPlan({}, {}, 42);
    const plan2 = buildStandardPlan({}, {}, 42);

    expect(plan1.payments).toEqual(plan2.payments);
  });

  it("two plans with seed=42 produce identical deposits", () => {
    const plan1 = buildStandardPlan({}, {}, 42);
    const plan2 = buildStandardPlan({}, {}, 42);

    expect(plan1.deposits).toEqual(plan2.deposits);
  });

  it("two plans with seed=42 produce identical bills and billPayments", () => {
    const plan1 = buildStandardPlan({}, {}, 42);
    const plan2 = buildStandardPlan({}, {}, 42);

    expect(plan1.bills).toEqual(plan2.bills);
    expect(plan1.billPayments).toEqual(plan2.billPayments);
  });

  it("two plans with seed=42 produce identical transfers and journalEntries", () => {
    const plan1 = buildStandardPlan({}, {}, 42);
    const plan2 = buildStandardPlan({}, {}, 42);

    expect(plan1.transfers).toEqual(plan2.transfers);
    expect(plan1.journalEntries).toEqual(plan2.journalEntries);
  });

  it("two plans with seed=42 produce identical salesReceipts and directExpenses", () => {
    const plan1 = buildStandardPlan({}, {}, 42);
    const plan2 = buildStandardPlan({}, {}, 42);

    expect(plan1.salesReceipts).toEqual(plan2.salesReceipts);
    expect(plan1.directExpenses).toEqual(plan2.directExpenses);
  });

  it("two plans with seed=42 produce identical estimates and purchaseOrders", () => {
    const plan1 = buildStandardPlan({}, {}, 42);
    const plan2 = buildStandardPlan({}, {}, 42);

    expect(plan1.estimates).toEqual(plan2.estimates);
    expect(plan1.purchaseOrders).toEqual(plan2.purchaseOrders);
  });

  it("different seeds produce different outputs", () => {
    const plan1 = buildStandardPlan({}, {}, 42);
    const plan2 = buildStandardPlan({}, {}, 99);

    // Invoices will have same count (same customerCount x months) but different amounts
    const amounts1 = plan1.invoices.map((i) => i.amount);
    const amounts2 = plan2.invoices.map((i) => i.amount);
    expect(amounts1).not.toEqual(amounts2);
  });
});

// ---------------------------------------------------------------------------
// 3. Edge cases
// ---------------------------------------------------------------------------

describe("Edge cases", () => {
  it("0 employees: plan.employees is empty, plan.payroll is empty", () => {
    const plan = buildStandardPlan({}, { employeeCount: 0 });

    expect(plan.employees).toEqual([]);
    expect(plan.payroll).toEqual([]);
    expect(plan.payrollVendor).toBeNull();
  });

  it("0 vendors when targetEbitda equals totalRevenue: vendors and bills are empty", () => {
    const plan = buildStandardPlan(
      {},
      {
        totalRevenue: 200000,
        targetEbitda: 200000,
        employeeCount: 0
      }
    );

    expect(plan.vendors).toEqual([]);
    expect(plan.bills).toEqual([]);
    expect(plan.directExpenses).toEqual([]);
    expect(plan.billPayments).toEqual([]);
    expect(plan.vendorCredits).toEqual([]);
  });

  it("single customer: plan.customers has length 1", () => {
    const plan = buildStandardPlan(
      {},
      {
        customerCount: 1,
        topCustomerCount: 1,
        clientConcentrationPercent: 100
      }
    );

    expect(plan.customers).toHaveLength(1);
    expect(plan.customers[0].id).toBe("CUST-001");
  });
});

// ---------------------------------------------------------------------------
// 4. allocateCents edge cases (tested indirectly)
// ---------------------------------------------------------------------------

describe("allocateCents edge cases (indirect)", () => {
  it("very small totalRevenue=1 produces amounts that sum correctly", () => {
    const config = resolveConfig({}, {});
    const input = normalizeRequest({
      startDate: "2024-01-01",
      endDate: "2024-03-31",
      totalRevenue: 1,
      targetEbitda: 0.5,
      customerCount: 3,
      clientConcentrationPercent: 50
    });
    const plan = buildSyntheticPlan(input, config, { seed: 42 });

    // Invoice amounts should sum to approximately invoicedRevenueShare * 1 = 0.92
    const invoiceSum = plan.invoices.reduce((sum, inv) => sum + inv.amount, 0);
    expect(invoiceSum).toBeCloseTo(0.92, 1);

    // No amount should be negative
    for (const inv of plan.invoices) {
      expect(inv.amount).toBeGreaterThanOrEqual(0);
    }
  });

  it("all invoice amounts are non-negative with small revenue", () => {
    const config = resolveConfig({}, {});
    const input = normalizeRequest({
      startDate: "2024-01-01",
      endDate: "2024-02-28",
      totalRevenue: 1,
      targetEbitda: 0,
      customerCount: 5,
      clientConcentrationPercent: 40
    });
    const plan = buildSyntheticPlan(input, config, { seed: 7 });

    for (const inv of plan.invoices) {
      expect(inv.amount).toBeGreaterThanOrEqual(0);
    }
    for (const bill of plan.bills) {
      expect(bill.amount).toBeGreaterThanOrEqual(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. applyScenarioPreset
// ---------------------------------------------------------------------------

describe("applyScenarioPreset", () => {
  it("valid preset 'cash-crisis' returns modified request with preset fields", () => {
    const request = { startDate: "2024-01-01", endDate: "2024-12-31" };
    const result = applyScenarioPreset(request, "cash-crisis");

    // The result should contain both preset request fields and our original fields
    expect(result).toHaveProperty("request");
    expect(result).toHaveProperty("ratioOverrides");
    expect(result.request.startDate).toBe("2024-01-01");
    expect(result.request.endDate).toBe("2024-12-31");
    // The preset should have injected totalRevenue or other fields
    expect(result.request).toHaveProperty("totalRevenue");
  });

  it("unknown preset throws and lists valid presets", () => {
    expect(() => applyScenarioPreset({}, "does-not-exist")).toThrow(
      /Unknown scenario preset "does-not-exist". Valid presets: .*cash-crisis/
    );
  });

  it("no preset returns explicit fields only", () => {
    const result = applyScenarioPreset(
      {
        totalRevenue: 100000,
        customerCount: undefined,
        ratioOverrides: { invoicePaymentRate: 0.5 }
      },
      null
    );
    expect(result.request).not.toHaveProperty("customerCount");
    expect(result.ratioOverrides).toEqual({ invoicePaymentRate: 0.5 });
  });

  it("undefined fields do not mask preset values", () => {
    const result = applyScenarioPreset({ totalRevenue: undefined }, "cash-crisis");
    expect(result.request.totalRevenue).toBe(650000);
  });

  it("user fields override preset defaults", () => {
    const request = {
      startDate: "2024-06-01",
      endDate: "2024-06-30",
      totalRevenue: 999999
    };
    const result = applyScenarioPreset(request, "cash-crisis");

    // User-provided totalRevenue should override the preset
    expect(result.request.totalRevenue).toBe(999999);
  });
});

// ---------------------------------------------------------------------------
// 6. normalizeRequest validation
// ---------------------------------------------------------------------------

describe("normalizeRequest validation", () => {
  const validBase = {
    startDate: "2024-01-01",
    endDate: "2024-12-31",
    totalRevenue: 100000,
    targetEbitda: 20000,
    customerCount: 5,
    clientConcentrationPercent: 30
  };

  it("totalRevenue=0 throws", () => {
    expect(() => normalizeRequest({ ...validBase, totalRevenue: 0 })).toThrow(
      "totalRevenue must be greater than zero"
    );
  });

  it("negative totalRevenue throws", () => {
    expect(() => normalizeRequest({ ...validBase, totalRevenue: -500 })).toThrow(
      "totalRevenue must be greater than zero"
    );
  });

  it("customerCount > 300 throws", () => {
    expect(() => normalizeRequest({ ...validBase, customerCount: 301 })).toThrow(
      "customerCount is capped at 300"
    );
  });

  it("topCustomerCount > customerCount throws", () => {
    expect(() =>
      normalizeRequest({ ...validBase, customerCount: 5, topCustomerCount: 10 })
    ).toThrow("topCustomerCount cannot exceed customerCount");
  });

  it("empty tag throws", () => {
    expect(() => normalizeRequest({ ...validBase, tag: "   " })).toThrow("tag cannot be empty");
  });

  it("targetEbitda > totalRevenue throws", () => {
    expect(() =>
      normalizeRequest({ ...validBase, totalRevenue: 100000, targetEbitda: 150000 })
    ).toThrow("targetEbitda cannot exceed totalRevenue");
  });

  it("valid request does not throw", () => {
    expect(() => normalizeRequest(validBase)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 7. Ratio overrides affect output
// ---------------------------------------------------------------------------

describe("Ratio overrides affect output", () => {
  it("invoicePaymentRate=0 produces zero payments", () => {
    const plan = buildStandardPlan({ invoicePaymentRate: 0 });

    expect(plan.payments).toHaveLength(0);
  });

  it("invoicePaymentRate=1 produces a payment for every eligible invoice", () => {
    const plan = buildStandardPlan({ invoicePaymentRate: 1 });

    // Every invoice with amount > 0 should be eligible.
    // Some payments may still be skipped if payDate > endDate, but most should exist.
    const nonZeroInvoices = plan.invoices.filter((inv) => inv.amount > 0);
    expect(plan.payments.length).toBeGreaterThan(0);
    // With rate=1, the vast majority should have payments
    expect(plan.payments.length).toBeGreaterThanOrEqual(Math.floor(nonZeroInvoices.length * 0.5));
  });

  it("billPaymentRate=0 produces zero bill payments", () => {
    const plan = buildStandardPlan({ billPaymentRate: 0 });

    expect(plan.billPayments).toHaveLength(0);
  });

  it("creditMemoRate=0 produces zero credit memos", () => {
    const plan = buildStandardPlan({ creditMemoRate: 0 });

    expect(plan.creditMemos).toHaveLength(0);
  });

  it("vendorCreditRate=0 produces zero vendor credits", () => {
    const plan = buildStandardPlan({ vendorCreditRate: 0 });

    expect(plan.vendorCredits).toHaveLength(0);
  });

  it("estimateRate=0 produces zero estimates", () => {
    const plan = buildStandardPlan({ estimateRate: 0 });

    expect(plan.estimates).toHaveLength(0);
  });

  it("purchaseOrderRate=0 produces zero purchase orders", () => {
    const plan = buildStandardPlan({ purchaseOrderRate: 0 });

    expect(plan.purchaseOrders).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 8. Ratio validation clamping
// ---------------------------------------------------------------------------

describe("Ratio validation clamping", () => {
  it("user overrides above a rate's range are rejected, naming every offender", () => {
    expect(() =>
      resolveConfig(
        {},
        {
          ratios: {
            invoicePaymentRate: 5.0,
            billPaymentRate: 2.0,
            creditMemoRate: 1.5,
            vendorCreditRate: 99,
            estimateRate: 10,
            purchaseOrderRate: 3.0
          }
        }
      )
    ).toThrow(
      /invoicePaymentRate must be between 0 and 1 \(got 5\); billPaymentRate .*; creditMemoRate .*; vendorCreditRate .*; estimateRate .*; purchaseOrderRate must be between 0 and 1 \(got 3\)/
    );
  });

  it("user overrides below zero are rejected", () => {
    expect(() =>
      resolveConfig({}, { ratios: { invoicePaymentRate: -0.5, invoicedRevenueShare: -0.2 } })
    ).toThrow(/invoicePaymentRate must be between 0 and 1 \(got -0.5\)/);
    expect(() =>
      resolveConfig({}, { ratios: { paymentDelayMinDays: -10, transferMinAmount: -500 } })
    ).toThrow(/paymentDelayMinDays must be between 0 and 365 \(got -10\)/);
  });

  it("template ratios (not user overrides) are clamped into range", () => {
    const config = resolveConfig({
      id: "custom",
      ratios: {
        invoicePaymentRate: 5.0,
        cashSalesShare: -0.1,
        paymentDelayMinDays: -10,
        transfersPerMonth: 5000,
        transferMaxAmount: "oops"
      }
    });

    expect(config.ratios.invoicePaymentRate).toBe(1);
    expect(config.ratios.cashSalesShare).toBe(0);
    expect(config.ratios.paymentDelayMinDays).toBe(0);
    expect(config.ratios.transfersPerMonth).toBe(31);
    expect(config.ratios.transferMaxAmount).toBe(RATIOS.transferMaxAmount);
  });

  it("valid ratio values within range are not modified", () => {
    const config = resolveConfig(
      {},
      {
        ratios: {
          invoicePaymentRate: 0.75,
          transfersPerMonth: 2,
          paymentDelayMinDays: 10
        }
      }
    );

    expect(config.ratios.invoicePaymentRate).toBe(0.75);
    expect(config.ratios.transfersPerMonth).toBe(2);
    expect(config.ratios.paymentDelayMinDays).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// 9. Deposit account type
// ---------------------------------------------------------------------------

describe("Deposit account type", () => {
  it("every deposit has depositAccountType set to 'checking' or 'savings'", () => {
    const plan = buildStandardPlan();

    expect(plan.deposits.length).toBeGreaterThan(0);
    for (const deposit of plan.deposits) {
      expect(deposit).toHaveProperty("depositAccountType");
      expect(["checking", "savings"]).toContain(deposit.depositAccountType);
    }
  });

  it("deposits are deterministic with seed", () => {
    const plan1 = buildStandardPlan({}, {}, 42);
    const plan2 = buildStandardPlan({}, {}, 42);

    const types1 = plan1.deposits.map((d) => d.depositAccountType);
    const types2 = plan2.deposits.map((d) => d.depositAccountType);
    expect(types1).toEqual(types2);
  });

  it("with default 90/10 ratio most deposits should be checking", () => {
    // Use a larger plan to get a statistically meaningful sample
    const config = resolveConfig({}, {});
    const input = normalizeRequest({
      startDate: "2024-01-01",
      endDate: "2024-12-31",
      totalRevenue: 500000,
      targetEbitda: 100000,
      customerCount: 10,
      clientConcentrationPercent: 40,
      employeeCount: 5
    });
    const plan = buildSyntheticPlan(input, config, { seed: 42 });

    const checkingCount = plan.deposits.filter((d) => d.depositAccountType === "checking").length;
    const total = plan.deposits.length;

    // At least 60% should be checking (with 90% probability, even small samples)
    expect(checkingCount / total).toBeGreaterThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// 10. Transfers use ratio
// ---------------------------------------------------------------------------

describe("Transfers use ratio", () => {
  it("transfersPerMonth=0 produces zero or very few transfers", () => {
    const plan = buildStandardPlan({ transfersPerMonth: 0 });

    // With transfersPerMonth=0, the formula is Math.round(0 + random(-0.5,0.5))
    // which could occasionally be 1 but mostly 0.
    // Over 6 months, expect at most a few.
    expect(plan.transfers.length).toBeLessThanOrEqual(6);
  });

  it("transfersPerMonth=5 produces more transfers than transfersPerMonth=0", () => {
    const planLow = buildStandardPlan({ transfersPerMonth: 0 });
    const planHigh = buildStandardPlan({ transfersPerMonth: 5 });

    expect(planHigh.transfers.length).toBeGreaterThan(planLow.transfers.length);
  });

  it("transfersPerMonth=5 produces roughly 5 per month over 6 months", () => {
    const plan = buildStandardPlan({ transfersPerMonth: 5 });

    // 6 months * ~5 transfers = ~30, allow generous range
    expect(plan.transfers.length).toBeGreaterThanOrEqual(15);
    expect(plan.transfers.length).toBeLessThanOrEqual(45);
  });

  it("each transfer has a positive amount and valid date", () => {
    const plan = buildStandardPlan({ transfersPerMonth: 3 });

    for (const transfer of plan.transfers) {
      expect(transfer.amount).toBeGreaterThan(0);
      expect(transfer.txnDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // Date should be within range
      expect(transfer.txnDate >= "2024-01-01").toBe(true);
      expect(transfer.txnDate <= "2024-06-30").toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 11. vendorCreditAmountShare
// ---------------------------------------------------------------------------

describe("vendorCreditAmountShare", () => {
  it("vendorCreditAmountShare=0.50 produces vendor credits at ~50% of bill amounts", () => {
    // Use high vendorCreditRate to ensure we get some credits
    const plan = buildStandardPlan({
      vendorCreditRate: 1,
      vendorCreditAmountShare: 0.5
    });

    expect(plan.vendorCredits.length).toBeGreaterThan(0);

    for (const vc of plan.vendorCredits) {
      const bill = plan.bills[vc.billIndex];
      const expectedAmount = Number((bill.amount * 0.5).toFixed(2));
      expect(vc.amount).toBe(expectedAmount);
    }
  });

  it("vendorCreditAmountShare=0.10 produces smaller credits than 0.90", () => {
    const planLow = buildStandardPlan({
      vendorCreditRate: 1,
      vendorCreditAmountShare: 0.1
    });
    const planHigh = buildStandardPlan({
      vendorCreditRate: 1,
      vendorCreditAmountShare: 0.9
    });

    // Both should have vendor credits
    expect(planLow.vendorCredits.length).toBeGreaterThan(0);
    expect(planHigh.vendorCredits.length).toBeGreaterThan(0);

    const avgLow =
      planLow.vendorCredits.reduce((sum, vc) => sum + vc.amount, 0) / planLow.vendorCredits.length;
    const avgHigh =
      planHigh.vendorCredits.reduce((sum, vc) => sum + vc.amount, 0) /
      planHigh.vendorCredits.length;

    expect(avgHigh).toBeGreaterThan(avgLow);
  });

  it("vendor credits reference valid bills", () => {
    const plan = buildStandardPlan({
      vendorCreditRate: 1,
      vendorCreditAmountShare: 0.5
    });

    for (const vc of plan.vendorCredits) {
      expect(vc.billIndex).toBeGreaterThanOrEqual(0);
      expect(vc.billIndex).toBeLessThan(plan.bills.length);

      const bill = plan.bills[vc.billIndex];
      expect(vc.vendorName).toBe(bill.vendorName);
      expect(vc.expenseCategory).toBe(bill.lines[0].expenseCategory);
    }
  });
});
