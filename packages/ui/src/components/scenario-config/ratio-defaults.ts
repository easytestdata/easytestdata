export type RatioFieldType = "rate" | "integer" | "currency";

export type RatioTab =
  | "revenue"
  | "expenses"
  | "adjustments"
  | "banking"
  | "payroll";

export interface RatioFieldDef {
  key: string;
  label: string;
  default: number;
  type: RatioFieldType;
  tab: RatioTab;
  hint?: string;
}

export const RATIO_TAB_LABELS: Record<RatioTab, string> = {
  revenue: "Revenue & Collections",
  expenses: "Expenses & Payables",
  adjustments: "Adjustments",
  banking: "Banking & Journal",
  payroll: "Payroll"
};

export const RATIO_FIELDS: RatioFieldDef[] = [
  // Revenue & Collections
  {
    key: "invoicedRevenueShare",
    label: "Invoiced Revenue Share",
    default: 0.92,
    type: "rate",
    tab: "revenue",
    hint: "Fraction of total revenue generated via invoices vs cash sales"
  },
  {
    key: "cashSalesShare",
    label: "Cash Sales Share",
    default: 0.08,
    type: "rate",
    tab: "revenue",
    hint: "Fraction of total revenue recorded as direct cash sales receipts"
  },
  {
    key: "invoicePaymentRate",
    label: "Invoice Payment Rate",
    default: 0.8,
    type: "rate",
    tab: "revenue",
    hint: "Fraction of invoices that receive a payment within the date range"
  },
  {
    key: "paymentDelayMinDays",
    label: "Payment Delay Min (days)",
    default: 15,
    type: "integer",
    tab: "revenue",
    hint: "Minimum number of days between invoice date and payment date"
  },
  {
    key: "paymentDelayMaxDays",
    label: "Payment Delay Max (days)",
    default: 45,
    type: "integer",
    tab: "revenue",
    hint: "Maximum number of days between invoice date and payment date"
  },
  {
    key: "partialPaymentRate",
    label: "Partial Payment Rate",
    default: 0.2,
    type: "rate",
    tab: "revenue",
    hint: "Fraction of paid invoices that receive a partial rather than full payment"
  },
  {
    key: "partialPaymentMin",
    label: "Partial Payment Min Share",
    default: 0.5,
    type: "rate",
    tab: "revenue",
    hint: "Minimum fraction of invoice amount paid in a partial payment"
  },
  {
    key: "partialPaymentMax",
    label: "Partial Payment Max Share",
    default: 0.9,
    type: "rate",
    tab: "revenue",
    hint: "Maximum fraction of invoice amount paid in a partial payment"
  },
  {
    key: "estimateRate",
    label: "Estimate Rate",
    default: 0.15,
    type: "rate",
    tab: "revenue",
    hint: "Fraction of invoices that also generate a preceding estimate"
  },

  // Expenses & Payables
  {
    key: "formalBillShare",
    label: "Formal Bill Share",
    default: 0.82,
    type: "rate",
    tab: "expenses",
    hint: "Fraction of non-payroll expenses recorded as vendor bills"
  },
  {
    key: "directExpenseShare",
    label: "Direct Expense Share",
    default: 0.18,
    type: "rate",
    tab: "expenses",
    hint: "Fraction of non-payroll expenses recorded as direct purchases"
  },
  {
    key: "billPaymentRate",
    label: "Bill Payment Rate",
    default: 0.9,
    type: "rate",
    tab: "expenses",
    hint: "Fraction of vendor bills that receive a payment within the date range"
  },
  {
    key: "billPaymentDelayMinDays",
    label: "Bill Payment Delay Min (days)",
    default: 10,
    type: "integer",
    tab: "expenses",
    hint: "Minimum number of days between bill date and bill payment date"
  },
  {
    key: "billPaymentDelayMaxDays",
    label: "Bill Payment Delay Max (days)",
    default: 30,
    type: "integer",
    tab: "expenses",
    hint: "Maximum number of days between bill date and bill payment date"
  },
  {
    key: "purchaseOrderRate",
    label: "Purchase Order Rate",
    default: 0.1,
    type: "rate",
    tab: "expenses",
    hint: "Fraction of vendor bills that also generate a preceding purchase order"
  },

  // Adjustments
  {
    key: "creditMemoRate",
    label: "Credit Memo Rate",
    default: 0.04,
    type: "rate",
    tab: "adjustments",
    hint: "Fraction of invoices that generate a customer credit memo"
  },
  {
    key: "creditMemoAmountShare",
    label: "Credit Memo Amount Share",
    default: 0.25,
    type: "rate",
    tab: "adjustments",
    hint: "Fraction of the invoice amount used for the credit memo"
  },
  {
    key: "refundReceiptRate",
    label: "Refund Receipt Rate",
    default: 0.015,
    type: "rate",
    tab: "adjustments",
    hint: "Fraction of cash sales that generate a refund receipt"
  },
  {
    key: "vendorCreditRate",
    label: "Vendor Credit Rate",
    default: 0.025,
    type: "rate",
    tab: "adjustments",
    hint: "Fraction of vendor bills that generate a vendor credit"
  },
  {
    key: "vendorCreditAmountShare",
    label: "Vendor Credit Amount Share",
    default: 0.2,
    type: "rate",
    tab: "adjustments",
    hint: "Fraction of the bill amount used for the vendor credit"
  },

  // Banking & Journal
  {
    key: "depositWindowDays",
    label: "Deposit Window (days)",
    default: 3,
    type: "integer",
    tab: "banking",
    hint: "Number of days of payments grouped into a single bank deposit"
  },
  {
    key: "transfersPerMonth",
    label: "Transfers Per Month",
    default: 1.5,
    type: "rate",
    tab: "banking",
    hint: "Average number of inter-account bank transfers generated per month"
  },
  {
    key: "transferMinAmount",
    label: "Transfer Min Amount",
    default: 5000,
    type: "currency",
    tab: "banking",
    hint: "Minimum dollar amount for generated bank transfers"
  },
  {
    key: "transferMaxAmount",
    label: "Transfer Max Amount",
    default: 25000,
    type: "currency",
    tab: "banking",
    hint: "Maximum dollar amount for generated bank transfers"
  },
  {
    key: "monthlyDepreciationShare",
    label: "Monthly Depreciation Share",
    default: 0.005,
    type: "rate",
    tab: "banking",
    hint: "Fraction of total revenue booked as monthly depreciation journal entries"
  },
  {
    key: "quarterlyAccrualShare",
    label: "Quarterly Accrual Share",
    default: 0.01,
    type: "rate",
    tab: "banking",
    hint: "Fraction of total revenue booked as quarterly accrual journal entries"
  },

  // Payroll
  {
    key: "payrollShare",
    label: "Payroll Share of Revenue",
    default: 0.55,
    type: "rate",
    tab: "payroll",
    hint: "Total payroll cost as a fraction of annual revenue"
  },
  {
    key: "salaryShareWithBenefits",
    label: "Salary Share (w/ Benefits)",
    default: 0.72,
    type: "rate",
    tab: "payroll",
    hint: "Fraction of payroll allocated to base salary when benefits are included"
  },
  {
    key: "payrollTaxShareWithBenefits",
    label: "Payroll Tax Share (w/ Benefits)",
    default: 0.1,
    type: "rate",
    tab: "payroll",
    hint: "Fraction of payroll allocated to payroll taxes when benefits are included"
  },
  {
    key: "healthInsuranceShare",
    label: "Health Insurance Share",
    default: 0.14,
    type: "rate",
    tab: "payroll",
    hint: "Fraction of payroll allocated to employer health insurance contributions"
  },
  {
    key: "dentalInsuranceShare",
    label: "Dental Insurance Share",
    default: 0.04,
    type: "rate",
    tab: "payroll",
    hint: "Fraction of payroll allocated to employer dental insurance contributions"
  },
  {
    key: "salaryShareNoBenefits",
    label: "Salary Share (No Benefits)",
    default: 0.88,
    type: "rate",
    tab: "payroll",
    hint: "Fraction of payroll allocated to base salary when benefits are excluded"
  },
  {
    key: "payrollTaxShareNoBenefits",
    label: "Payroll Tax Share (No Benefits)",
    default: 0.12,
    type: "rate",
    tab: "payroll",
    hint: "Fraction of payroll allocated to payroll taxes when benefits are excluded"
  }
];

export function getFieldsByTab(tab: RatioTab): RatioFieldDef[] {
  return RATIO_FIELDS.filter((f) => f.tab === tab);
}
