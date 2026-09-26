// Industry template definitions, maintained by hand: edit this file to add or change a template
// (see docs/contributing-templates.md). `description` is shown by `easytestdata templates`, the
// web app, and the README tables, so keep those in sync.
export const INDUSTRY_TEMPLATES = {
  "professional-services": {
    name: "Professional Services",
    description:
      "Consulting firms, agencies, law practices. 92% invoiced, 8% cash. Default template.",
    ratios: {
      invoicedRevenueShare: 0.92,
      cashSalesShare: 0.08
    },
    serviceItems: [
      {
        suffix: "Strategy-Consulting",
        name: "Strategy Consulting Income",
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
        suffix: "Training",
        name: "Training Income",
        accountType: "Income",
        subType: "OtherPrimaryIncome",
        weight: 0.12
      },
      {
        suffix: "Advisory",
        name: "Advisory Services Income",
        accountType: "Income",
        subType: "ServiceFeeIncome",
        weight: 0.18
      },
      {
        suffix: "Support",
        name: "Support Services Income",
        accountType: "Income",
        subType: "ServiceFeeIncome",
        weight: 0.1
      }
    ],
    expenseCategories: [
      {
        name: "Office Rent",
        accountType: "Expense",
        subType: "RentOrLeaseOfBuildings",
        weight: 0.2
      },
      {
        name: "Software Subscriptions",
        accountType: "Expense",
        subType: "DuesSubscriptions",
        weight: 0.18
      },
      {
        name: "Travel",
        accountType: "Expense",
        subType: "Travel",
        weight: 0.12
      },
      {
        name: "Professional Development",
        accountType: "Expense",
        subType: "OtherMiscellaneousServiceCost",
        weight: 0.08
      },
      {
        name: "Insurance",
        accountType: "Expense",
        subType: "Insurance",
        weight: 0.1
      },
      {
        name: "Marketing",
        accountType: "Expense",
        subType: "AdvertisingPromotional",
        weight: 0.1
      },
      {
        name: "Subcontractors",
        accountType: "Expense",
        subType: "LegalProfessionalFees",
        weight: 0.14
      },
      {
        name: "Office Supplies",
        accountType: "Expense",
        subType: "OfficeGeneralAdministrativeExpenses",
        weight: 0.08
      }
    ]
  },
  saas: {
    name: "SaaS / Software",
    description: "Software-as-a-service companies. Subscription and usage revenue, 95% invoiced.",
    ratios: {
      invoicedRevenueShare: 0.95,
      cashSalesShare: 0.05,
      formalBillShare: 0.75,
      directExpenseShare: 0.25,
      payrollShare: 0.65,
      invoicePaymentRate: 0.92,
      paymentDelayMinDays: 10,
      paymentDelayMaxDays: 30,
      creditMemoRate: 0.02,
      refundReceiptRate: 0.03,
      estimateRate: 0.05,
      purchaseOrderRate: 0.02
    },
    serviceItems: [
      {
        suffix: "SaaS-Subscription",
        name: "SaaS Subscription Income",
        accountType: "Income",
        subType: "ServiceFeeIncome",
        weight: 0.55
      },
      {
        suffix: "Setup-Fee",
        name: "Setup Fee Income",
        accountType: "Income",
        subType: "ServiceFeeIncome",
        weight: 0.15
      },
      {
        suffix: "Support-Plan",
        name: "Support Plan Income",
        accountType: "Income",
        subType: "ServiceFeeIncome",
        weight: 0.15
      },
      {
        suffix: "API-Usage",
        name: "API Usage Income",
        accountType: "Income",
        subType: "OtherPrimaryIncome",
        weight: 0.1
      },
      {
        suffix: "Training",
        name: "Training Income",
        accountType: "Income",
        subType: "OtherPrimaryIncome",
        weight: 0.05
      }
    ],
    expenseCategories: [
      {
        name: "Cloud Hosting",
        accountType: "Expense",
        subType: "OtherMiscellaneousServiceCost",
        weight: 0.3
      },
      {
        name: "Software Licenses",
        accountType: "Expense",
        subType: "DuesSubscriptions",
        weight: 0.15
      },
      {
        name: "Office & Rent",
        accountType: "Expense",
        subType: "RentOrLeaseOfBuildings",
        weight: 0.12
      },
      {
        name: "Marketing",
        accountType: "Expense",
        subType: "AdvertisingPromotional",
        weight: 0.15
      },
      {
        name: "Professional Services",
        accountType: "Expense",
        subType: "LegalProfessionalFees",
        weight: 0.08
      },
      {
        name: "Travel",
        accountType: "Expense",
        subType: "Travel",
        weight: 0.05
      },
      {
        name: "Equipment",
        accountType: "Expense",
        subType: "EquipmentRental",
        weight: 0.08
      },
      {
        name: "Insurance",
        accountType: "Expense",
        subType: "Insurance",
        weight: 0.07
      }
    ]
  },
  restaurant: {
    name: "Restaurant / Food Service",
    description:
      "Restaurants and food service. 85% cash sales, 32% of spend on food and ingredients.",
    ratios: {
      invoicedRevenueShare: 0.15,
      cashSalesShare: 0.85,
      formalBillShare: 0.9,
      directExpenseShare: 0.1,
      payrollShare: 0.35,
      invoicePaymentRate: 0.95,
      paymentDelayMinDays: 5,
      paymentDelayMaxDays: 15,
      billPaymentRate: 0.95,
      creditMemoRate: 0.01,
      refundReceiptRate: 0.02,
      estimateRate: 0,
      purchaseOrderRate: 0.3
    },
    serviceItems: [
      {
        suffix: "Dine-In",
        name: "Dine-In Sales",
        accountType: "Income",
        subType: "SalesOfProductIncome",
        weight: 0.45
      },
      {
        suffix: "Takeout",
        name: "Takeout Sales",
        accountType: "Income",
        subType: "SalesOfProductIncome",
        weight: 0.25
      },
      {
        suffix: "Delivery",
        name: "Delivery Sales",
        accountType: "Income",
        subType: "SalesOfProductIncome",
        weight: 0.15
      },
      {
        suffix: "Catering",
        name: "Catering Income",
        accountType: "Income",
        subType: "ServiceFeeIncome",
        weight: 0.1
      },
      {
        suffix: "Gift-Cards",
        name: "Gift Card Sales",
        accountType: "Income",
        subType: "OtherPrimaryIncome",
        weight: 0.05
      }
    ],
    expenseCategories: [
      {
        name: "Food & Ingredients",
        accountType: "Expense",
        subType: "SuppliesMaterials",
        weight: 0.32
      },
      {
        name: "Beverages",
        accountType: "Expense",
        subType: "SuppliesMaterials",
        weight: 0.1
      },
      {
        name: "Rent",
        accountType: "Expense",
        subType: "RentOrLeaseOfBuildings",
        weight: 0.15
      },
      {
        name: "Utilities",
        accountType: "Expense",
        subType: "Utilities",
        weight: 0.08
      },
      {
        name: "Kitchen Equipment",
        accountType: "Expense",
        subType: "EquipmentRental",
        weight: 0.1
      },
      {
        name: "Cleaning Supplies",
        accountType: "Expense",
        subType: "OfficeGeneralAdministrativeExpenses",
        weight: 0.05
      },
      {
        name: "Insurance",
        accountType: "Expense",
        subType: "Insurance",
        weight: 0.08
      },
      {
        name: "Marketing",
        accountType: "Expense",
        subType: "AdvertisingPromotional",
        weight: 0.12
      }
    ]
  },
  construction: {
    name: "Construction / Contractor",
    description:
      "General contractors. Estimates on 80% of jobs, purchase orders, 30-90 day collections.",
    ratios: {
      invoicedRevenueShare: 0.95,
      cashSalesShare: 0.05,
      formalBillShare: 0.85,
      directExpenseShare: 0.15,
      payrollShare: 0.4,
      invoicePaymentRate: 0.75,
      paymentDelayMinDays: 30,
      paymentDelayMaxDays: 90,
      billPaymentRate: 0.85,
      billPaymentDelayMinDays: 15,
      billPaymentDelayMaxDays: 45,
      creditMemoRate: 0.03,
      estimateRate: 0.8,
      purchaseOrderRate: 0.6,
      partialPaymentRate: 0.4,
      partialPaymentMin: 0.3,
      partialPaymentMax: 0.7
    },
    serviceItems: [
      {
        suffix: "General-Construction",
        name: "General Construction Income",
        accountType: "Income",
        subType: "ServiceFeeIncome",
        weight: 0.35
      },
      {
        suffix: "Remodeling",
        name: "Remodeling Income",
        accountType: "Income",
        subType: "ServiceFeeIncome",
        weight: 0.25
      },
      {
        suffix: "Electrical",
        name: "Electrical Services Income",
        accountType: "Income",
        subType: "ServiceFeeIncome",
        weight: 0.15
      },
      {
        suffix: "Plumbing",
        name: "Plumbing Services Income",
        accountType: "Income",
        subType: "ServiceFeeIncome",
        weight: 0.15
      },
      {
        suffix: "Design-Consulting",
        name: "Design Consulting Income",
        accountType: "Income",
        subType: "ServiceFeeIncome",
        weight: 0.1
      }
    ],
    expenseCategories: [
      {
        name: "Building Materials",
        accountType: "Expense",
        subType: "SuppliesMaterials",
        weight: 0.3
      },
      {
        name: "Subcontractors",
        accountType: "Expense",
        subType: "LegalProfessionalFees",
        weight: 0.2
      },
      {
        name: "Equipment Rental",
        accountType: "Expense",
        subType: "EquipmentRental",
        weight: 0.15
      },
      {
        name: "Permits & Fees",
        accountType: "Expense",
        subType: "TaxesPaid",
        weight: 0.08
      },
      {
        name: "Vehicle Expenses",
        accountType: "Expense",
        subType: "Auto",
        weight: 0.1
      },
      {
        name: "Insurance",
        accountType: "Expense",
        subType: "Insurance",
        weight: 0.1
      },
      {
        name: "Tools & Supplies",
        accountType: "Expense",
        subType: "SuppliesMaterials",
        weight: 0.05
      },
      {
        name: "Safety Equipment",
        accountType: "Expense",
        subType: "OfficeGeneralAdministrativeExpenses",
        weight: 0.02
      }
    ]
  },
  retail: {
    name: "Retail / eCommerce",
    description: "Brick-and-mortar and e-commerce stores. 80% cash sales, 45% cost of goods.",
    ratios: {
      invoicedRevenueShare: 0.2,
      cashSalesShare: 0.8,
      formalBillShare: 0.88,
      directExpenseShare: 0.12,
      payrollShare: 0.25,
      invoicePaymentRate: 0.9,
      paymentDelayMinDays: 5,
      paymentDelayMaxDays: 20,
      billPaymentRate: 0.92,
      creditMemoRate: 0.02,
      refundReceiptRate: 0.05,
      estimateRate: 0,
      purchaseOrderRate: 0.4
    },
    serviceItems: [
      {
        suffix: "Product-Sales",
        name: "Product Sales",
        accountType: "Income",
        subType: "SalesOfProductIncome",
        weight: 0.6
      },
      {
        suffix: "Online-Sales",
        name: "Online Sales",
        accountType: "Income",
        subType: "SalesOfProductIncome",
        weight: 0.2
      },
      {
        suffix: "Wholesale",
        name: "Wholesale Sales",
        accountType: "Income",
        subType: "SalesOfProductIncome",
        weight: 0.1
      },
      {
        suffix: "Gift-Cards",
        name: "Gift Card Sales",
        accountType: "Income",
        subType: "OtherPrimaryIncome",
        weight: 0.05
      },
      {
        suffix: "Shipping-Revenue",
        name: "Shipping Revenue",
        accountType: "Income",
        subType: "OtherPrimaryIncome",
        weight: 0.05
      }
    ],
    expenseCategories: [
      {
        name: "Cost of Goods",
        accountType: "Expense",
        subType: "SuppliesMaterials",
        weight: 0.45
      },
      {
        name: "Rent",
        accountType: "Expense",
        subType: "RentOrLeaseOfBuildings",
        weight: 0.12
      },
      {
        name: "Shipping & Fulfillment",
        accountType: "Expense",
        subType: "ShippingFreightDelivery",
        weight: 0.1
      },
      {
        name: "Marketing & Ads",
        accountType: "Expense",
        subType: "AdvertisingPromotional",
        weight: 0.1
      },
      {
        name: "Utilities",
        accountType: "Expense",
        subType: "Utilities",
        weight: 0.06
      },
      {
        name: "Insurance",
        accountType: "Expense",
        subType: "Insurance",
        weight: 0.05
      },
      {
        name: "Store Supplies",
        accountType: "Expense",
        subType: "OfficeGeneralAdministrativeExpenses",
        weight: 0.05
      },
      {
        name: "Software & POS",
        accountType: "Expense",
        subType: "DuesSubscriptions",
        weight: 0.07
      }
    ]
  },
  healthcare: {
    name: "Healthcare / Medical",
    description:
      "Medical practices and clinics. Patient and lab services, 30-90 day payment delays.",
    ratios: {
      invoicedRevenueShare: 0.9,
      cashSalesShare: 0.1,
      formalBillShare: 0.8,
      directExpenseShare: 0.2,
      payrollShare: 0.5,
      invoicePaymentRate: 0.85,
      paymentDelayMinDays: 30,
      paymentDelayMaxDays: 90,
      billPaymentRate: 0.9,
      creditMemoRate: 0.05,
      refundReceiptRate: 0.02,
      estimateRate: 0.1,
      purchaseOrderRate: 0.15,
      partialPaymentRate: 0.3,
      partialPaymentMin: 0.6,
      partialPaymentMax: 0.9
    },
    serviceItems: [
      {
        suffix: "Patient-Services",
        name: "Patient Services Income",
        accountType: "Income",
        subType: "ServiceFeeIncome",
        weight: 0.4
      },
      {
        suffix: "Lab-Services",
        name: "Lab Services Income",
        accountType: "Income",
        subType: "ServiceFeeIncome",
        weight: 0.2
      },
      {
        suffix: "Consultation",
        name: "Consultation Income",
        accountType: "Income",
        subType: "ServiceFeeIncome",
        weight: 0.2
      },
      {
        suffix: "Procedures",
        name: "Procedures Income",
        accountType: "Income",
        subType: "ServiceFeeIncome",
        weight: 0.15
      },
      {
        suffix: "Pharmacy",
        name: "Pharmacy Sales",
        accountType: "Income",
        subType: "SalesOfProductIncome",
        weight: 0.05
      }
    ],
    expenseCategories: [
      {
        name: "Medical Supplies",
        accountType: "Expense",
        subType: "SuppliesMaterials",
        weight: 0.25
      },
      {
        name: "Lab Equipment",
        accountType: "Expense",
        subType: "EquipmentRental",
        weight: 0.12
      },
      {
        name: "Rent",
        accountType: "Expense",
        subType: "RentOrLeaseOfBuildings",
        weight: 0.15
      },
      {
        name: "Insurance & Malpractice",
        accountType: "Expense",
        subType: "Insurance",
        weight: 0.15
      },
      {
        name: "Utilities",
        accountType: "Expense",
        subType: "Utilities",
        weight: 0.06
      },
      {
        name: "Professional Fees",
        accountType: "Expense",
        subType: "LegalProfessionalFees",
        weight: 0.1
      },
      {
        name: "Software & EHR",
        accountType: "Expense",
        subType: "DuesSubscriptions",
        weight: 0.1
      },
      {
        name: "Training & CME",
        accountType: "Expense",
        subType: "OtherMiscellaneousServiceCost",
        weight: 0.07
      }
    ]
  },
  nonprofit: {
    name: "Nonprofit",
    description: "Charitable organizations. Donations, grants, program fees, and program expenses.",
    ratios: {
      invoicedRevenueShare: 0.3,
      cashSalesShare: 0.7,
      formalBillShare: 0.85,
      directExpenseShare: 0.15,
      payrollShare: 0.5,
      invoicePaymentRate: 0.9,
      paymentDelayMinDays: 10,
      paymentDelayMaxDays: 60,
      creditMemoRate: 0.01,
      refundReceiptRate: 0.005,
      estimateRate: 0.2,
      purchaseOrderRate: 0.05
    },
    serviceItems: [
      {
        suffix: "Donations",
        name: "Donation Income",
        accountType: "Income",
        subType: "OtherPrimaryIncome",
        weight: 0.35
      },
      {
        suffix: "Grants",
        name: "Grant Income",
        accountType: "Income",
        subType: "OtherPrimaryIncome",
        weight: 0.3
      },
      {
        suffix: "Program-Fees",
        name: "Program Fees",
        accountType: "Income",
        subType: "ServiceFeeIncome",
        weight: 0.15
      },
      {
        suffix: "Membership",
        name: "Membership Dues",
        accountType: "Income",
        subType: "ServiceFeeIncome",
        weight: 0.1
      },
      {
        suffix: "Fundraising-Events",
        name: "Fundraising Events",
        accountType: "Income",
        subType: "OtherPrimaryIncome",
        weight: 0.1
      }
    ],
    expenseCategories: [
      {
        name: "Program Expenses",
        accountType: "Expense",
        subType: "OtherMiscellaneousServiceCost",
        weight: 0.35
      },
      {
        name: "Rent & Facilities",
        accountType: "Expense",
        subType: "RentOrLeaseOfBuildings",
        weight: 0.15
      },
      {
        name: "Office & Admin",
        accountType: "Expense",
        subType: "OfficeGeneralAdministrativeExpenses",
        weight: 0.1
      },
      {
        name: "Travel & Outreach",
        accountType: "Expense",
        subType: "Travel",
        weight: 0.1
      },
      {
        name: "Professional Fees",
        accountType: "Expense",
        subType: "LegalProfessionalFees",
        weight: 0.08
      },
      {
        name: "Insurance",
        accountType: "Expense",
        subType: "Insurance",
        weight: 0.07
      },
      {
        name: "Marketing & Fundraising",
        accountType: "Expense",
        subType: "AdvertisingPromotional",
        weight: 0.1
      },
      {
        name: "Utilities",
        accountType: "Expense",
        subType: "Utilities",
        weight: 0.05
      }
    ]
  },
  "real-estate": {
    name: "Real Estate / Property Management",
    description: "Property management. Rent, management fees, and late fees; 85% invoiced.",
    ratios: {
      invoicedRevenueShare: 0.85,
      cashSalesShare: 0.15,
      formalBillShare: 0.8,
      directExpenseShare: 0.2,
      payrollShare: 0.2,
      invoicePaymentRate: 0.92,
      paymentDelayMinDays: 5,
      paymentDelayMaxDays: 15,
      billPaymentRate: 0.9,
      creditMemoRate: 0.02,
      refundReceiptRate: 0.01,
      estimateRate: 0.3,
      purchaseOrderRate: 0.25
    },
    serviceItems: [
      {
        suffix: "Rental-Income",
        name: "Rental Income",
        accountType: "Income",
        subType: "ServiceFeeIncome",
        weight: 0.5
      },
      {
        suffix: "Management-Fees",
        name: "Management Fees",
        accountType: "Income",
        subType: "ServiceFeeIncome",
        weight: 0.2
      },
      {
        suffix: "Maintenance-Income",
        name: "Maintenance Income",
        accountType: "Income",
        subType: "ServiceFeeIncome",
        weight: 0.1
      },
      {
        suffix: "Commission",
        name: "Commission Income",
        accountType: "Income",
        subType: "ServiceFeeIncome",
        weight: 0.15
      },
      {
        suffix: "Late-Fees",
        name: "Late Fee Income",
        accountType: "Income",
        subType: "OtherPrimaryIncome",
        weight: 0.05
      }
    ],
    expenseCategories: [
      {
        name: "Property Maintenance",
        accountType: "Expense",
        subType: "RepairMaintenance",
        weight: 0.25
      },
      {
        name: "Mortgage & Loan Interest",
        accountType: "Expense",
        subType: "InterestPaid",
        weight: 0.2
      },
      {
        name: "Property Insurance",
        accountType: "Expense",
        subType: "Insurance",
        weight: 0.12
      },
      {
        name: "Property Taxes",
        accountType: "Expense",
        subType: "TaxesPaid",
        weight: 0.15
      },
      {
        name: "Utilities",
        accountType: "Expense",
        subType: "Utilities",
        weight: 0.1
      },
      {
        name: "Management Software",
        accountType: "Expense",
        subType: "DuesSubscriptions",
        weight: 0.05
      },
      {
        name: "Legal Fees",
        accountType: "Expense",
        subType: "LegalProfessionalFees",
        weight: 0.08
      },
      {
        name: "Marketing",
        accountType: "Expense",
        subType: "AdvertisingPromotional",
        weight: 0.05
      }
    ]
  }
};
