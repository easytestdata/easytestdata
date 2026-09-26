export const SCENARIO_PRESETS = {
  "healthy-small": {
    id: "healthy-small",
    name: "Healthy small business",
    description: "Steady margins, customers who pay on time and no single client that dominates.",
    request: {
      totalRevenue: 500000,
      targetEbitda: 120000,
      customerCount: 20,
      topCustomerCount: 3,
      clientConcentrationPercent: 35,
      employeeCount: 5,
      includeBenefits: true
    },
    ratioOverrides: {}
  },
  "cash-crisis": {
    id: "cash-crisis",
    name: "Cash-flow crunch: slow-paying customers",
    description:
      "Thin profit, late and partial payments, and a big share of revenue from a few clients.",
    request: {
      totalRevenue: 650000,
      targetEbitda: 15000,
      customerCount: 28,
      topCustomerCount: 4,
      clientConcentrationPercent: 52,
      employeeCount: 8,
      includeBenefits: false
    },
    ratioOverrides: {
      invoicePaymentRate: 0.62,
      paymentDelayMinDays: 35,
      paymentDelayMaxDays: 90,
      billPaymentRate: 0.75,
      partialPaymentRate: 0.42
    }
  },
  "rapid-growth": {
    id: "rapid-growth",
    name: "Fast-growing company",
    description: "High volume, aggressive hiring and reinvestment, lots of estimates in flight.",
    request: {
      totalRevenue: 2000000,
      targetEbitda: 120000,
      customerCount: 90,
      topCustomerCount: 6,
      clientConcentrationPercent: 28,
      employeeCount: 30,
      includeBenefits: true
    },
    ratioOverrides: {
      payrollShare: 0.68,
      creditMemoRate: 0.05,
      estimateRate: 0.22
    }
  },
  seasonal: {
    id: "seasonal",
    name: "Seasonal business",
    description: "Busy and quiet months with larger quarter-end movements.",
    request: {
      totalRevenue: 900000,
      targetEbitda: 100000,
      customerCount: 35,
      topCustomerCount: 5,
      clientConcentrationPercent: 40,
      employeeCount: 12,
      includeBenefits: false
    },
    ratioOverrides: {
      transferMaxAmount: 45000,
      estimateRate: 0.3,
      purchaseOrderRate: 0.35
    }
  },
  "mature-stable": {
    id: "mature-stable",
    name: "Steady, established company",
    description: "Predictable operations, high collection rates and steady expenses.",
    request: {
      totalRevenue: 1500000,
      targetEbitda: 320000,
      customerCount: 45,
      topCustomerCount: 6,
      clientConcentrationPercent: 30,
      employeeCount: 18,
      includeBenefits: true
    },
    ratioOverrides: {
      invoicePaymentRate: 0.95,
      paymentDelayMinDays: 7,
      paymentDelayMaxDays: 21,
      billPaymentRate: 0.96,
      creditMemoRate: 0.015
    }
  },
  "audit-nightmare": {
    id: "audit-nightmare",
    name: "Messy books: credits, refunds and adjustments",
    description: "Many credit memos, refunds and vendor credits, with slow, partial payments.",
    request: {
      totalRevenue: 1200000,
      targetEbitda: 60000,
      customerCount: 55,
      topCustomerCount: 8,
      clientConcentrationPercent: 48,
      employeeCount: 16,
      includeBenefits: false
    },
    ratioOverrides: {
      creditMemoRate: 0.1,
      vendorCreditRate: 0.08,
      refundReceiptRate: 0.06,
      invoicePaymentRate: 0.68,
      partialPaymentRate: 0.5
    }
  },
  "new-company": {
    id: "new-company",
    name: "Brand-new company",
    description: "Early-stage company with low volume and only a few vendors.",
    request: {
      totalRevenue: 200000,
      targetEbitda: 20000,
      customerCount: 10,
      topCustomerCount: 2,
      clientConcentrationPercent: 55,
      employeeCount: 3,
      includeBenefits: false
    },
    ratioOverrides: {
      estimateRate: 0.08,
      purchaseOrderRate: 0.05,
      invoicePaymentRate: 0.82
    }
  },
  // Keep this last: the CLI lists presets in registry order and expects healthy-small first.
  "quick-demo": {
    id: "quick-demo",
    name: "Quick demo (3 months, small)",
    description: "A tiny three-month company that loads into a sandbox in about a minute.",
    // generate() uses this length unless the caller passes months or both dates.
    months: 3,
    request: {
      totalRevenue: 60000,
      targetEbitda: 9000,
      customerCount: 5,
      topCustomerCount: 2,
      clientConcentrationPercent: 50,
      employeeCount: 2,
      includeBenefits: false
    },
    ratioOverrides: {
      estimateRate: 0,
      purchaseOrderRate: 0,
      transfersPerMonth: 1
    }
  }
};
