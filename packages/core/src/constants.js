export const GENERATION_VERSION = "1.0";

// ---------------------------------------------------------------------------
// Heuristic ratios, service items, expense categories, and name pools
// ---------------------------------------------------------------------------

export const SERVICE_ITEMS = [
  {
    suffix: "Consulting",
    name: "Consulting Income",
    accountType: "Income",
    subType: "ServiceFeeIncome",
    weight: 0.35
  },
  {
    suffix: "Implementation",
    name: "Implementation Income",
    accountType: "Income",
    subType: "ServiceFeeIncome",
    weight: 0.25
  },
  {
    suffix: "Support",
    name: "Support Income",
    accountType: "Income",
    subType: "ServiceFeeIncome",
    weight: 0.15
  },
  {
    suffix: "Training",
    name: "Training Income",
    accountType: "Income",
    subType: "OtherPrimaryIncome",
    weight: 0.1
  },
  {
    suffix: "Licensing",
    name: "Licensing Income",
    accountType: "Income",
    subType: "SalesOfProductIncome",
    weight: 0.15
  }
];

export const EXPENSE_CATEGORIES = [
  {
    name: "Rent or Lease",
    accountType: "Expense",
    subType: "RentOrLeaseOfBuildings",
    weight: 0.22
  },
  { name: "Utilities", accountType: "Expense", subType: "Utilities", weight: 0.08 },
  { name: "Insurance", accountType: "Expense", subType: "Insurance", weight: 0.1 },
  {
    name: "Office Supplies",
    accountType: "Expense",
    subType: "OfficeGeneralAdministrativeExpenses",
    weight: 0.06
  },
  {
    name: "Professional Fees",
    accountType: "Expense",
    subType: "LegalProfessionalFees",
    weight: 0.12
  },
  { name: "Travel & Entertainment", accountType: "Expense", subType: "Travel", weight: 0.09 },
  {
    name: "Software & Subscriptions",
    accountType: "Expense",
    subType: "DuesSubscriptions",
    weight: 0.18
  },
  {
    name: "Meals & Entertainment",
    accountType: "Expense",
    subType: "EntertainmentMeals",
    weight: 0.15
  }
];

export const RATIOS = {
  // Revenue split
  invoicedRevenueShare: 0.92,
  cashSalesShare: 0.08,

  // Expense split
  formalBillShare: 0.82,
  directExpenseShare: 0.18,

  // A/R settlement
  invoicePaymentRate: 0.8,
  paymentDelayMinDays: 15,
  paymentDelayMaxDays: 45,

  // A/P settlement
  billPaymentRate: 0.9,
  billPaymentDelayMinDays: 10,
  billPaymentDelayMaxDays: 30,

  // Adjustments
  creditMemoRate: 0.04,
  creditMemoAmountShare: 0.25,
  refundReceiptRate: 0.015,
  vendorCreditRate: 0.025,
  vendorCreditAmountShare: 0.2,

  // Banking
  depositWindowDays: 3,
  transfersPerMonth: 1.5,
  transferMinAmount: 5000,
  transferMaxAmount: 25000,

  // Journal entries
  monthlyDepreciationShare: 0.005,
  quarterlyAccrualShare: 0.01,

  // Payroll
  payrollShare: 0.55,
  salaryShareWithBenefits: 0.72,
  payrollTaxShareWithBenefits: 0.1,
  healthInsuranceShare: 0.14,
  dentalInsuranceShare: 0.04,
  salaryShareNoBenefits: 0.88,
  payrollTaxShareNoBenefits: 0.12,

  // Estimates & purchase orders
  estimateRate: 0.15,
  purchaseOrderRate: 0.1,

  // Partial payments
  partialPaymentRate: 0.2,
  partialPaymentMin: 0.5,
  partialPaymentMax: 0.9
};

/**
 * Allowed range for every ratio. Overrides outside it are rejected by resolveConfig (a clear
 * error the CLI, playground and API all surface), and values templates supply are clamped to
 * it. Shares and rates are fractions; the rest are per-month counts, day windows or amounts.
 * Together with the customer/employee/period caps this bounds how large a plan can get.
 */
const SHARE = Object.freeze({ min: 0, max: 1 });
const DAYS = Object.freeze({ min: 0, max: 365 });
const AMOUNT = Object.freeze({ min: 0, max: 10_000_000 });
export const RATIO_BOUNDS = Object.freeze({
  invoicedRevenueShare: SHARE,
  cashSalesShare: SHARE,
  formalBillShare: SHARE,
  directExpenseShare: SHARE,
  invoicePaymentRate: SHARE,
  paymentDelayMinDays: DAYS,
  paymentDelayMaxDays: DAYS,
  billPaymentRate: SHARE,
  billPaymentDelayMinDays: DAYS,
  billPaymentDelayMaxDays: DAYS,
  creditMemoRate: SHARE,
  creditMemoAmountShare: SHARE,
  refundReceiptRate: SHARE,
  vendorCreditRate: SHARE,
  vendorCreditAmountShare: SHARE,
  depositWindowDays: Object.freeze({ min: 0, max: 90 }),
  transfersPerMonth: Object.freeze({ min: 0, max: 31 }),
  transferMinAmount: AMOUNT,
  transferMaxAmount: AMOUNT,
  monthlyDepreciationShare: SHARE,
  quarterlyAccrualShare: SHARE,
  payrollShare: SHARE,
  salaryShareWithBenefits: SHARE,
  payrollTaxShareWithBenefits: SHARE,
  healthInsuranceShare: SHARE,
  dentalInsuranceShare: SHARE,
  salaryShareNoBenefits: SHARE,
  payrollTaxShareNoBenefits: SHARE,
  estimateRate: SHARE,
  purchaseOrderRate: SHARE,
  partialPaymentRate: SHARE,
  partialPaymentMin: SHARE,
  partialPaymentMax: SHARE
});

/** Longest period a plan may cover, in calendar months (explicit dates included). */
export const MAX_PERIOD_MONTHS = 120;

/** The most employees a plan has; the generator clamps to it and the server refuses more. */
export const MAX_EMPLOYEES = 50;

export const PAYMENT_TERMS = [
  { days: 15, weight: 0.2 },
  { days: 30, weight: 0.5 },
  { days: 60, weight: 0.3 }
];
