/**
 * Validates an industry template object against the structure expected by the
 * config resolver and generation engine.
 *
 * Returns { valid: true, template } on success or { valid: false, errors: [...] } on failure.
 */

const VALID_INCOME_SUBTYPES = [
  "ServiceFeeIncome",
  "SalesOfProductIncome",
  "OtherPrimaryIncome",
  "NonProfitIncome",
  "RentalIncome"
];

const VALID_EXPENSE_SUBTYPES = [
  "RentOrLeaseOfBuildings",
  "Utilities",
  "Insurance",
  "OfficeGeneralAdministrativeExpenses",
  "LegalProfessionalFees",
  "Travel",
  "DuesSubscriptions",
  "EntertainmentMeals",
  "SuppliesMaterials",
  "RepairMaintenance",
  "EquipmentRental",
  "Auto",
  "CostOfLaborCos",
  "OtherMiscServiceCost",
  "Advertising",
  "TravelMeals",
  "Shipping",
  "Stationery"
];

const VALID_RATIO_KEYS = [
  "invoicedRevenueShare",
  "cashSalesShare",
  "formalBillShare",
  "directExpenseShare",
  "invoicePaymentRate",
  "billPaymentRate",
  "creditMemoRate",
  "creditMemoAmountShare",
  "refundReceiptRate",
  "vendorCreditRate",
  "vendorCreditAmountShare",
  "partialPaymentRate",
  "partialPaymentMin",
  "partialPaymentMax",
  "payrollShare",
  "estimateRate",
  "purchaseOrderRate",
  "paymentDelayMinDays",
  "paymentDelayMaxDays",
  "billPaymentDelayMinDays",
  "billPaymentDelayMaxDays",
  "depositWindowDays",
  "transfersPerMonth",
  "transferMinAmount",
  "transferMaxAmount",
  "monthlyDepreciationShare",
  "quarterlyAccrualShare"
];

function validateServiceItem(item, index) {
  const errors = [];
  const prefix = `serviceItems[${index}]`;

  if (!item || typeof item !== "object") {
    return [`${prefix}: must be an object`];
  }
  if (typeof item.suffix !== "string" || item.suffix.length === 0) {
    errors.push(`${prefix}.suffix: must be a non-empty string`);
  }
  if (typeof item.name !== "string" || item.name.length === 0) {
    errors.push(`${prefix}.name: must be a non-empty string`);
  }
  if (item.accountType !== "Income") {
    errors.push(`${prefix}.accountType: must be "Income"`);
  }
  if (!VALID_INCOME_SUBTYPES.includes(item.subType)) {
    errors.push(`${prefix}.subType: must be one of ${VALID_INCOME_SUBTYPES.join(", ")}`);
  }
  if (typeof item.weight !== "number" || item.weight <= 0 || item.weight > 1) {
    errors.push(`${prefix}.weight: must be a number between 0 (exclusive) and 1`);
  }

  return errors;
}

function validateExpenseCategory(cat, index) {
  const errors = [];
  const prefix = `expenseCategories[${index}]`;

  if (!cat || typeof cat !== "object") {
    return [`${prefix}: must be an object`];
  }
  if (typeof cat.name !== "string" || cat.name.length === 0) {
    errors.push(`${prefix}.name: must be a non-empty string`);
  }
  if (cat.accountType !== "Expense") {
    errors.push(`${prefix}.accountType: must be "Expense"`);
  }
  if (!VALID_EXPENSE_SUBTYPES.includes(cat.subType)) {
    errors.push(`${prefix}.subType: must be one of ${VALID_EXPENSE_SUBTYPES.join(", ")}`);
  }
  if (typeof cat.weight !== "number" || cat.weight <= 0 || cat.weight > 1) {
    errors.push(`${prefix}.weight: must be a number between 0 (exclusive) and 1`);
  }

  return errors;
}

export function validateTemplate(data) {
  const errors = [];

  if (!data || typeof data !== "object") {
    return { valid: false, errors: ["Template must be an object"] };
  }

  // Name and description
  if (typeof data.name !== "string" || data.name.trim().length === 0) {
    errors.push("name: must be a non-empty string");
  } else if (data.name.length > 100) {
    errors.push("name: must be 100 characters or fewer");
  }

  if (typeof data.description !== "string" || data.description.trim().length === 0) {
    errors.push("description: must be a non-empty string");
  } else if (data.description.length > 500) {
    errors.push("description: must be 500 characters or fewer");
  }

  // Ratios (optional partial overrides)
  if (data.ratios !== undefined) {
    if (typeof data.ratios !== "object" || Array.isArray(data.ratios)) {
      errors.push("ratios: must be an object");
    } else {
      for (const key of Object.keys(data.ratios)) {
        if (!VALID_RATIO_KEYS.includes(key)) {
          errors.push(`ratios.${key}: unknown ratio key`);
        } else if (typeof data.ratios[key] !== "number") {
          errors.push(`ratios.${key}: must be a number`);
        }
      }
    }
  }

  // Service items (required, 1-10)
  if (!Array.isArray(data.serviceItems)) {
    errors.push("serviceItems: must be an array");
  } else if (data.serviceItems.length === 0 || data.serviceItems.length > 10) {
    errors.push("serviceItems: must have between 1 and 10 items");
  } else {
    const suffixes = new Set();
    for (let i = 0; i < data.serviceItems.length; i++) {
      errors.push(...validateServiceItem(data.serviceItems[i], i));
      if (data.serviceItems[i]?.suffix) {
        if (suffixes.has(data.serviceItems[i].suffix)) {
          errors.push(
            `serviceItems[${i}].suffix: duplicate suffix "${data.serviceItems[i].suffix}"`
          );
        }
        suffixes.add(data.serviceItems[i].suffix);
      }
    }
  }

  // Expense categories (required, 1-15)
  if (!Array.isArray(data.expenseCategories)) {
    errors.push("expenseCategories: must be an array");
  } else if (data.expenseCategories.length === 0 || data.expenseCategories.length > 15) {
    errors.push("expenseCategories: must have between 1 and 15 items");
  } else {
    const names = new Set();
    for (let i = 0; i < data.expenseCategories.length; i++) {
      errors.push(...validateExpenseCategory(data.expenseCategories[i], i));
      if (data.expenseCategories[i]?.name) {
        if (names.has(data.expenseCategories[i].name)) {
          errors.push(
            `expenseCategories[${i}].name: duplicate name "${data.expenseCategories[i].name}"`
          );
        }
        names.add(data.expenseCategories[i].name);
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, template: data };
}
