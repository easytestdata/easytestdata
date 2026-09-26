import { GENERATION_VERSION, MAX_EMPLOYEES, MAX_PERIOD_MONTHS } from "./constants.js";
import { generateParties } from "./parties.js";

// ---------------------------------------------------------------------------
// Seedable PRNG (mulberry32)
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let state = seed | 0;
  return function () {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function parseDate(value, fieldName) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value;
  const text = String(value ?? "");
  const parsed = new Date(text);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || toIsoDateSafe(parsed) !== text) {
    throw new Error(`${fieldName} is not a valid date (expected YYYY-MM-DD, got "${text}").`);
  }
  return parsed;
}

function toIsoDateSafe(date) {
  return Number.isNaN(date.valueOf()) ? null : date.toISOString().slice(0, 10);
}

function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function randomBetween(rng, min, max) {
  return min + rng() * (max - min);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthStart(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function monthEnd(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
}

function enumerateMonths(startDate, endDate) {
  const months = [];
  let cursor = monthStart(startDate);
  const lastMonth = monthStart(endDate);
  while (cursor <= lastMonth) {
    months.push(new Date(cursor));
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }
  return months;
}

function pickDateInMonth(rng, monthDate, startDate, endDate) {
  const monthFirst = monthStart(monthDate);
  const monthLast = monthEnd(monthDate);
  const lowerBound = startDate > monthFirst ? startDate : monthFirst;
  const upperBound = endDate < monthLast ? endDate : monthLast;
  const lowerTs = lowerBound.getTime();
  const upperTs = upperBound.getTime();
  const chosen = new Date(Math.round(randomBetween(rng, lowerTs, upperTs)));
  return toIsoDate(chosen);
}

function positiveRandomWeights(rng, count) {
  return Array.from({ length: count }, () => randomBetween(rng, 0.25, 1.25));
}

function normalizeWeights(weights, total = 1) {
  const sum = weights.reduce((acc, value) => acc + value, 0);
  if (sum === 0) return weights.map(() => 0);
  return weights.map((value) => (value / sum) * total);
}

function allocateCents(totalAmount, weights) {
  const totalCents = Math.max(0, Math.round(totalAmount * 100));
  const normalized = normalizeWeights(weights, totalCents);
  const floored = normalized.map((value) => Math.floor(value));
  let remaining = totalCents - floored.reduce((acc, value) => acc + value, 0);

  const fractional = normalized
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction);

  let cursor = 0;
  while (remaining > 0 && fractional.length > 0) {
    floored[fractional[cursor % fractional.length].index] += 1;
    remaining -= 1;
    cursor += 1;
  }

  return floored.map((cents) => cents / 100);
}

function buildCustomerWeights(rng, customerCount, topCustomerCount, topCustomerShare) {
  const safeCustomerCount = Math.max(1, Math.floor(customerCount));
  const safeTopCount = clamp(Math.floor(topCustomerCount), 1, safeCustomerCount);
  const safeTopShare = clamp(topCustomerShare, 0.05, 0.95);

  const topWeightsRaw = positiveRandomWeights(rng, safeTopCount);
  const tailWeightsRaw = positiveRandomWeights(rng, safeCustomerCount - safeTopCount);
  const topWeights = normalizeWeights(topWeightsRaw, safeTopShare);
  const tailWeights = normalizeWeights(tailWeightsRaw, 1 - safeTopShare);

  const combined = [...topWeights, ...tailWeights].sort((a, b) => b - a);
  return {
    weights: combined,
    topCustomerCount: safeTopCount
  };
}

function parseNumeric(value, fieldName) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`${fieldName} must be numeric.`);
  }
  return number;
}

// ---------------------------------------------------------------------------
// Weighted random pick from an array of { ..., weight } objects
// ---------------------------------------------------------------------------

function weightedPick(rng, items) {
  if (items.length === 0) {
    throw new Error("weightedPick called with empty array");
  }
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  let roll = rng() * totalWeight;
  for (const item of items) {
    roll -= item.weight;
    if (roll <= 0) return item;
  }
  return items[items.length - 1];
}

// ---------------------------------------------------------------------------
// Date arithmetic
// ---------------------------------------------------------------------------

function addDays(isoDate, days) {
  const d = new Date(isoDate);
  d.setUTCDate(d.getUTCDate() + days);
  return toIsoDate(d);
}

function quarterKey(isoDate) {
  const d = new Date(isoDate);
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `${d.getUTCFullYear()}-Q${q}`;
}

// ---------------------------------------------------------------------------
// Multi-line helpers
// ---------------------------------------------------------------------------

function generateInvoiceLines(rng, amount, tag, serviceItems) {
  if (amount <= 0) {
    if (serviceItems.length === 0) return [{ serviceItemName: `${tag}-Default`, amount: 0 }];
    return [{ serviceItemName: `${tag}-${serviceItems[0].suffix}`, amount: 0 }];
  }
  const lineCount = rng() < 0.4 ? 1 : rng() < 0.7 ? 2 : 3;
  const picks = [];
  const seen = new Set();
  for (let i = 0; i < lineCount; i++) {
    const item = weightedPick(rng, serviceItems);
    if (!seen.has(item.suffix)) {
      seen.add(item.suffix);
      picks.push(item);
    }
  }
  const weights = picks.map((i) => i.weight);
  const amounts = allocateCents(amount, weights);
  return picks.map((item, i) => ({
    serviceItemName: `${tag}-${item.suffix}`,
    amount: amounts[i]
  }));
}

function generateBillLines(rng, amount, tag, expenseCategories) {
  if (amount <= 0) {
    if (expenseCategories.length === 0) return [{ expenseCategory: `${tag} Default`, amount: 0 }];
    return [{ expenseCategory: `${tag} ${expenseCategories[0].name}`, amount: 0 }];
  }
  const lineCount = rng() < 0.4 ? 1 : rng() < 0.7 ? 2 : 3;
  const picks = [];
  const seen = new Set();
  for (let i = 0; i < lineCount; i++) {
    const cat = weightedPick(rng, expenseCategories);
    if (!seen.has(cat.name)) {
      seen.add(cat.name);
      picks.push(cat);
    }
  }
  const weights = picks.map((c) => c.weight);
  const amounts = allocateCents(amount, weights);
  return picks.map((cat, i) => ({
    expenseCategory: `${tag} ${cat.name}`,
    amount: amounts[i]
  }));
}

function pickPaymentTermDays(rng, paymentTerms) {
  const term = weightedPick(rng, paymentTerms);
  return term.days;
}

// ---------------------------------------------------------------------------
// normalizeRequest -- with topCustomerCount validation
// ---------------------------------------------------------------------------

export function normalizeRequest(requestBody, defaultTag = "EZTD") {
  const startDate = parseDate(requestBody.startDate, "startDate");
  const endDate = parseDate(requestBody.endDate, "endDate");
  if (endDate < startDate) {
    throw new Error("endDate must be on or after startDate.");
  }

  const totalRevenue = parseNumeric(requestBody.totalRevenue, "totalRevenue");
  if (totalRevenue <= 0) {
    throw new Error("totalRevenue must be greater than zero.");
  }

  const targetEbitda = parseNumeric(requestBody.targetEbitda, "targetEbitda");
  if (targetEbitda > totalRevenue) {
    throw new Error("targetEbitda cannot exceed totalRevenue with the current generation model.");
  }

  const customerCount = Math.max(
    1,
    Math.floor(parseNumeric(requestBody.customerCount, "customerCount"))
  );
  if (customerCount > 300) {
    throw new Error("customerCount is capped at 300 to keep API load practical.");
  }

  const topCustomerCount = Math.max(
    1,
    Math.floor(parseNumeric(requestBody.topCustomerCount ?? 3, "topCustomerCount"))
  );

  if (topCustomerCount > customerCount) {
    throw new Error("topCustomerCount cannot exceed customerCount.");
  }

  const concentrationPercent = parseNumeric(
    requestBody.clientConcentrationPercent,
    "clientConcentrationPercent"
  );
  const topCustomerShare = clamp(concentrationPercent / 100, 0.01, 0.99);

  const employeeCount = clamp(
    Math.floor(parseNumeric(requestBody.employeeCount ?? 5, "employeeCount")),
    0,
    MAX_EMPLOYEES
  );

  const includeBenefits =
    requestBody.includeBenefits === true || requestBody.includeBenefits === "true";

  const tag = String(requestBody.tag || defaultTag)
    .trim()
    .toUpperCase();
  if (!tag) {
    throw new Error("tag cannot be empty.");
  }

  const VALID_COUNTRIES = ["US", "GB", "AU", "CA"];
  const country = String(requestBody.country || "US").toUpperCase();
  if (!VALID_COUNTRIES.includes(country)) {
    throw new Error(`country must be one of: ${VALID_COUNTRIES.join(", ")}`);
  }

  return {
    startDate,
    endDate,
    totalRevenue,
    targetEbitda,
    customerCount,
    topCustomerCount,
    topCustomerShare,
    employeeCount,
    includeBenefits,
    tag,
    country
  };
}

// ---------------------------------------------------------------------------
// Sub-generators
// ---------------------------------------------------------------------------

function generateServiceItemNames(tag, serviceItems) {
  return serviceItems.map((item) => `${tag}-${item.suffix}`);
}

function generateExpenseCategoryNames(tag, expenseCategories) {
  return expenseCategories.map((cat) => `${tag} ${cat.name}`);
}

function assignServiceItem(rng, tag, serviceItems) {
  const picked = weightedPick(rng, serviceItems);
  return `${tag}-${picked.suffix}`;
}

function assignExpenseCategory(rng, tag, expenseCategories) {
  const picked = weightedPick(rng, expenseCategories);
  return `${tag} ${picked.name}`;
}

// --- Invoices: multi-line, DueDate, DocNumber ---

function generateInvoices(rng, invoiceSlots, invoiceAmounts, tag, config) {
  const { serviceItems, paymentTerms } = config;
  return invoiceSlots.map((slot, index) => ({
    customerName: slot.customerName,
    txnDate: slot.txnDate,
    dueDate: addDays(slot.txnDate, pickPaymentTermDays(rng, paymentTerms)),
    docNumber: `${tag}-INV-${String(index + 1).padStart(4, "0")}`,
    amount: invoiceAmounts[index],
    lines: generateInvoiceLines(rng, invoiceAmounts[index], tag, serviceItems)
  }));
}

// --- Bills: multi-line, DocNumber ---

function generateBills(rng, billSlots, billAmounts, tag, expenseCategories) {
  return billSlots.map((slot, index) => ({
    vendorName: slot.vendorName,
    txnDate: slot.txnDate,
    docNumber: `${tag}-BILL-${String(index + 1).padStart(4, "0")}`,
    amount: billAmounts[index],
    lines: generateBillLines(rng, billAmounts[index], tag, expenseCategories)
  }));
}

function generateSalesReceipts(
  rng,
  cashSalesTotal,
  months,
  customerNames,
  startDate,
  endDate,
  tag,
  serviceItems
) {
  if (cashSalesTotal <= 0) return [];

  const slots = [];
  const customersForCash = customerNames.slice(
    0,
    Math.max(1, Math.ceil(customerNames.length * 0.3))
  );

  for (const monthDate of months) {
    const countThisMonth = Math.max(1, Math.ceil(customersForCash.length * 0.4));
    for (let i = 0; i < countThisMonth; i++) {
      const customer = customersForCash[Math.floor(rng() * customersForCash.length)];
      slots.push({
        customerName: customer,
        txnDate: pickDateInMonth(rng, monthDate, startDate, endDate)
      });
    }
  }

  if (slots.length === 0) return [];

  const weights = slots.map(() => randomBetween(rng, 0.5, 1.5));
  const amounts = allocateCents(cashSalesTotal, weights);

  return slots.map((slot, i) => ({
    customerName: slot.customerName,
    txnDate: slot.txnDate,
    amount: amounts[i],
    serviceItemName: assignServiceItem(rng, tag, serviceItems)
  }));
}

function generateDirectExpenses(
  rng,
  directTotal,
  months,
  vendorNames,
  startDate,
  endDate,
  tag,
  expenseCategories
) {
  if (directTotal <= 0 || vendorNames.length === 0) return [];

  const slots = [];
  for (const monthDate of months) {
    const countThisMonth = Math.max(1, Math.round(randomBetween(rng, 2, 5)));
    for (let i = 0; i < countThisMonth; i++) {
      slots.push({
        vendorName: vendorNames[Math.floor(rng() * vendorNames.length)],
        txnDate: pickDateInMonth(rng, monthDate, startDate, endDate),
        paymentType: rng() < 0.6 ? "CreditCard" : "Check"
      });
    }
  }

  if (slots.length === 0) return [];

  const weights = slots.map(() => randomBetween(rng, 0.5, 1.5));
  const amounts = allocateCents(directTotal, weights);

  return slots.map((slot, i) => ({
    vendorName: slot.vendorName,
    txnDate: slot.txnDate,
    amount: amounts[i],
    paymentType: slot.paymentType,
    expenseCategory: assignExpenseCategory(rng, tag, expenseCategories)
  }));
}

// --- Payments: with partial payment support ---

function generatePayments(rng, invoices, endDate, ratios) {
  const payments = [];
  for (let i = 0; i < invoices.length; i++) {
    const inv = invoices[i];
    if (inv.amount <= 0) continue;
    if (rng() > ratios.invoicePaymentRate) continue;

    const delayDays = Math.round(
      randomBetween(rng, ratios.paymentDelayMinDays, ratios.paymentDelayMaxDays)
    );
    const payDate = addDays(inv.txnDate, delayDays);
    if (payDate > toIsoDate(endDate)) continue;

    const isPartial = rng() < ratios.partialPaymentRate;
    const payAmount = isPartial
      ? Number(
          (
            inv.amount * randomBetween(rng, ratios.partialPaymentMin, ratios.partialPaymentMax)
          ).toFixed(2)
        )
      : inv.amount;

    payments.push({
      invoiceIndex: i,
      customerName: inv.customerName,
      txnDate: payDate,
      amount: payAmount
    });
  }
  return payments;
}

function generateBillPayments(rng, bills, endDate, ratios) {
  const billPayments = [];
  for (let i = 0; i < bills.length; i++) {
    const bill = bills[i];
    if (bill.amount <= 0) continue;
    if (rng() > ratios.billPaymentRate) continue;

    const delayDays = Math.round(
      randomBetween(rng, ratios.billPaymentDelayMinDays, ratios.billPaymentDelayMaxDays)
    );
    const payDate = addDays(bill.txnDate, delayDays);
    if (payDate > toIsoDate(endDate)) continue;

    billPayments.push({
      billIndex: i,
      vendorName: bill.vendorName,
      txnDate: payDate,
      amount: bill.amount
    });
  }
  return billPayments;
}

// --- Credit memos: references first line of multi-line invoice ---

function generateCreditMemos(rng, invoices, tag, ratios) {
  const creditMemos = [];
  for (let i = 0; i < invoices.length; i++) {
    const inv = invoices[i];
    if (inv.amount <= 0) continue;
    if (rng() > ratios.creditMemoRate) continue;

    const creditAmount = Number((inv.amount * ratios.creditMemoAmountShare).toFixed(2));
    if (creditAmount <= 0) continue;

    creditMemos.push({
      invoiceIndex: i,
      customerName: inv.customerName,
      txnDate: addDays(inv.txnDate, Math.round(randomBetween(rng, 5, 30))),
      amount: creditAmount,
      serviceItemName: inv.lines[0].serviceItemName
    });
  }
  return creditMemos;
}

function generateRefundReceipts(
  rng,
  totalRevenue,
  months,
  customerNames,
  startDate,
  endDate,
  tag,
  ratios,
  serviceItems
) {
  const refundTotal = totalRevenue * ratios.refundReceiptRate;
  if (refundTotal <= 0) return [];

  const count = Math.max(1, Math.round(months.length * 0.3));
  const slots = [];
  for (let i = 0; i < count; i++) {
    slots.push({
      customerName: customerNames[Math.floor(rng() * customerNames.length)],
      txnDate: pickDateInMonth(rng, months[Math.floor(rng() * months.length)], startDate, endDate)
    });
  }

  const weights = slots.map(() => randomBetween(rng, 0.5, 1.5));
  const amounts = allocateCents(refundTotal, weights);

  return slots.map((slot, i) => ({
    customerName: slot.customerName,
    txnDate: slot.txnDate,
    amount: amounts[i],
    serviceItemName: assignServiceItem(rng, tag, serviceItems)
  }));
}

// --- Vendor credits: ratio-driven amount ---

function generateVendorCredits(rng, bills, tag, ratios) {
  const vendorCredits = [];
  for (let i = 0; i < bills.length; i++) {
    const bill = bills[i];
    if (bill.amount <= 0) continue;
    if (rng() > ratios.vendorCreditRate) continue;

    const creditAmount = Number((bill.amount * ratios.vendorCreditAmountShare).toFixed(2));
    if (creditAmount <= 0) continue;

    vendorCredits.push({
      billIndex: i,
      vendorName: bill.vendorName,
      txnDate: addDays(bill.txnDate, Math.round(randomBetween(rng, 5, 20))),
      amount: creditAmount,
      expenseCategory: bill.lines[0].expenseCategory
    });
  }
  return vendorCredits;
}

// --- Deposits: with deterministic account assignment ---

function generateDeposits(rng, payments, salesReceipts, ratios) {
  const items = [
    ...payments.map((p, i) => ({
      type: "payment",
      index: i,
      txnDate: p.txnDate,
      amount: p.amount
    })),
    ...salesReceipts.map((sr, i) => ({
      type: "salesReceipt",
      index: i,
      txnDate: sr.txnDate,
      amount: sr.amount
    }))
  ].filter((item) => item.amount > 0);

  items.sort((a, b) => a.txnDate.localeCompare(b.txnDate));

  const deposits = [];
  let currentGroup = [];
  let groupStartDate = null;

  for (const item of items) {
    if (groupStartDate === null) {
      groupStartDate = item.txnDate;
      currentGroup.push(item);
      continue;
    }

    const daysDiff = Math.round(
      (new Date(item.txnDate) - new Date(groupStartDate)) / (1000 * 60 * 60 * 24)
    );
    if (daysDiff <= ratios.depositWindowDays) {
      currentGroup.push(item);
    } else {
      if (currentGroup.length > 0) {
        const totalAmount = currentGroup.reduce((sum, g) => sum + g.amount, 0);
        deposits.push({
          txnDate: currentGroup[currentGroup.length - 1].txnDate,
          amount: Number(totalAmount.toFixed(2)),
          lineItems: currentGroup.map((g) => ({ type: g.type, index: g.index, amount: g.amount })),
          depositAccountType: rng() < 0.9 ? "checking" : "savings"
        });
      }
      currentGroup = [item];
      groupStartDate = item.txnDate;
    }
  }

  if (currentGroup.length > 0) {
    const totalAmount = currentGroup.reduce((sum, g) => sum + g.amount, 0);
    deposits.push({
      txnDate: currentGroup[currentGroup.length - 1].txnDate,
      amount: Number(totalAmount.toFixed(2)),
      lineItems: currentGroup.map((g) => ({ type: g.type, index: g.index, amount: g.amount })),
      depositAccountType: rng() < 0.9 ? "checking" : "savings"
    });
  }

  return deposits;
}

// --- Transfers: ratio-driven count ---

function generateTransfers(rng, months, startDate, endDate, ratios) {
  const transfers = [];
  for (const monthDate of months) {
    const count = Math.round(ratios.transfersPerMonth + randomBetween(rng, -0.5, 0.5));
    const actualCount = Math.max(0, count);
    for (let i = 0; i < actualCount; i++) {
      const amount = Number(
        randomBetween(rng, ratios.transferMinAmount, ratios.transferMaxAmount).toFixed(2)
      );
      transfers.push({
        txnDate: pickDateInMonth(rng, monthDate, startDate, endDate),
        amount
      });
    }
  }
  return transfers;
}

function generateJournalEntries(months, totalRevenue, startDate, endDate, tag, ratios) {
  const entries = [];
  const monthlyRevenue = totalRevenue / Math.max(1, months.length);

  for (const monthDate of months) {
    const amount = Number((monthlyRevenue * ratios.monthlyDepreciationShare).toFixed(2));
    if (amount <= 0) continue;
    const lastDay = monthEnd(monthDate);
    const txnDate = toIsoDate(lastDay > endDate ? endDate : lastDay);
    entries.push({
      txnDate,
      amount,
      memo: `${tag} Monthly depreciation`,
      type: "depreciation"
    });
  }

  const quarters = new Map();
  for (const monthDate of months) {
    const qk = quarterKey(toIsoDate(monthDate));
    if (!quarters.has(qk)) {
      quarters.set(qk, monthDate);
    }
  }
  const quarterlyRevenue = totalRevenue / Math.max(1, quarters.size);
  for (const [, monthDate] of quarters) {
    const amount = Number((quarterlyRevenue * ratios.quarterlyAccrualShare).toFixed(2));
    if (amount <= 0) continue;
    const lastDay = monthEnd(monthDate);
    const txnDate = toIsoDate(lastDay > endDate ? endDate : lastDay);
    entries.push({
      txnDate,
      amount,
      memo: `${tag} Quarterly accrual`,
      type: "accrual"
    });
  }

  return entries;
}

function generatePayroll(payrollBudget, months, startDate, endDate, tag, includeBenefits, ratios) {
  if (payrollBudget <= 0 || months.length === 0) return [];

  const slots = [];
  for (const monthDate of months) {
    const year = monthDate.getUTCFullYear();
    const month = monthDate.getUTCMonth();
    const lastDay = monthEnd(monthDate);

    const run1 = new Date(Date.UTC(year, month, 1));
    if (run1 >= startDate && run1 <= endDate) {
      slots.push(toIsoDate(run1));
    } else if (run1 < startDate && lastDay >= startDate) {
      slots.push(toIsoDate(startDate));
    }

    const run2 = new Date(Date.UTC(year, month, 15));
    if (run2 >= startDate && run2 <= endDate) {
      slots.push(toIsoDate(run2));
    }
  }

  if (slots.length === 0) return [];

  const weights = slots.map(() => 1);
  const amounts = allocateCents(payrollBudget, weights);

  const salaryShare = includeBenefits
    ? ratios.salaryShareWithBenefits
    : ratios.salaryShareNoBenefits;
  const taxShare = includeBenefits
    ? ratios.payrollTaxShareWithBenefits
    : ratios.payrollTaxShareNoBenefits;

  return slots.map((txnDate, i) => {
    const total = amounts[i];
    const lineWeights = includeBenefits
      ? [salaryShare, taxShare, ratios.healthInsuranceShare, ratios.dentalInsuranceShare]
      : [salaryShare, taxShare];
    const lineAmounts = allocateCents(total, lineWeights);

    const lines = [
      { accountName: `${tag} Salaries & Wages`, amount: lineAmounts[0] },
      { accountName: `${tag} Payroll Taxes`, amount: lineAmounts[1] }
    ];
    if (includeBenefits) {
      lines.push({ accountName: `${tag} Health Insurance`, amount: lineAmounts[2] });
      lines.push({ accountName: `${tag} Dental Insurance`, amount: lineAmounts[3] });
    }

    return { txnDate, totalAmount: total, lines };
  });
}

// --- Estimates: precede ~15% of invoices ---

function generateEstimates(rng, invoices, startDate, tag, ratios) {
  const estimates = [];
  let seq = 0;
  for (const inv of invoices) {
    if (inv.amount <= 0) continue;
    if (rng() > ratios.estimateRate) continue;
    const estimateDate = addDays(inv.txnDate, -Math.round(randomBetween(rng, 5, 30)));
    if (estimateDate < toIsoDate(startDate)) continue;
    seq++;
    estimates.push({
      customerName: inv.customerName,
      txnDate: estimateDate,
      docNumber: `${tag}-EST-${String(seq).padStart(4, "0")}`,
      amount: inv.amount,
      serviceItemName: inv.lines[0].serviceItemName
    });
  }
  return estimates;
}

// --- Purchase orders: precede ~10% of bills ---

function generatePurchaseOrders(rng, bills, startDate, tag, ratios) {
  const pos = [];
  let seq = 0;
  for (const bill of bills) {
    if (bill.amount <= 0) continue;
    if (rng() > ratios.purchaseOrderRate) continue;
    const poDate = addDays(bill.txnDate, -Math.round(randomBetween(rng, 5, 20)));
    if (poDate < toIsoDate(startDate)) continue;
    seq++;
    pos.push({
      vendorName: bill.vendorName,
      txnDate: poDate,
      docNumber: `${tag}-PO-${String(seq).padStart(4, "0")}`,
      amount: bill.amount,
      expenseCategory: bill.lines[0].expenseCategory
    });
  }
  return pos;
}

// ---------------------------------------------------------------------------
// allocateBudgets -- financial budget allocation for a plan
// ---------------------------------------------------------------------------

function allocateBudgets(totalRevenue, targetEbitda, customerCount, employeeCount, ratios) {
  const totalExpensesBudget = Math.max(0, totalRevenue - targetEbitda);
  const vendorCount = totalExpensesBudget > 0 ? clamp(Math.round(customerCount / 5), 1, 10) : 0;

  const invoicedRevenue = totalRevenue * ratios.invoicedRevenueShare;
  const cashSalesRevenue = totalRevenue * ratios.cashSalesShare;

  const payrollBudget = employeeCount > 0 ? totalExpensesBudget * ratios.payrollShare : 0;
  const remainingExpenses = totalExpensesBudget - payrollBudget;

  const formalBillExpenses = remainingExpenses * ratios.formalBillShare;
  const directExpenseTotal = remainingExpenses * ratios.directExpenseShare;

  return {
    vendorCount,
    invoicedRevenue,
    cashSalesRevenue,
    formalBillExpenses,
    directExpenseTotal,
    payrollBudget
  };
}

// ---------------------------------------------------------------------------
// buildSyntheticPlan -- every transaction type
// ---------------------------------------------------------------------------

export function buildSyntheticPlan(input, config, options = {}) {
  const rng = options.seed != null ? mulberry32(options.seed) : Math.random;

  const {
    startDate,
    endDate,
    totalRevenue,
    targetEbitda,
    customerCount,
    topCustomerCount,
    topCustomerShare,
    employeeCount,
    includeBenefits,
    tag,
    country
  } = input;

  const { serviceItems, expenseCategories, ratios, paymentTerms } = config;

  const months = enumerateMonths(startDate, endDate);
  if (months.length > MAX_PERIOD_MONTHS) {
    throw new Error(
      `The period spans ${months.length} months; the maximum is ${MAX_PERIOD_MONTHS}.`
    );
  }
  if (months.length * customerCount > 5000) {
    throw new Error(
      "Scenario would create too many invoices (months x customers > 5000). Reduce date range or customer count."
    );
  }

  const budgets = allocateBudgets(totalRevenue, targetEbitda, customerCount, employeeCount, ratios);
  const {
    vendorCount,
    invoicedRevenue,
    cashSalesRevenue,
    formalBillExpenses,
    directExpenseTotal,
    payrollBudget
  } = budgets;

  // Customer & vendor names
  const customerProfile = buildCustomerWeights(
    rng,
    customerCount,
    topCustomerCount,
    topCustomerShare
  );
  // Names come from a separate stream so name-list changes never shift amounts.
  const nameRng = options.seed != null ? mulberry32(options.seed ^ 0x5eed) : Math.random;
  const parties = generateParties(nameRng, {
    country,
    industry: config.industry,
    customerCount: customerProfile.weights.length,
    vendorCount,
    employeeCount
  });
  const customerNames = parties.customers.map((c) => c.name);
  const vendorNames = parties.vendors.map((v) => v.name);

  // Service items & expense categories
  const serviceItemNames = generateServiceItemNames(tag, serviceItems);
  const expenseCategoryNames = generateExpenseCategoryNames(tag, expenseCategories);

  // --- Invoices (92% of revenue) ---
  const invoiceSlots = [];
  months.forEach((monthDate) => {
    customerNames.forEach((customerName, customerIndex) => {
      invoiceSlots.push({
        customerIndex,
        customerName,
        month: monthKey(monthDate),
        txnDate: pickDateInMonth(rng, monthDate, startDate, endDate)
      });
    });
  });

  const invoiceWeights = invoiceSlots.map((slot) => {
    const baseCustomerWeight = customerProfile.weights[slot.customerIndex];
    const seasonalFactor = randomBetween(rng, 0.85, 1.2);
    return baseCustomerWeight * seasonalFactor;
  });
  const invoiceAmounts = allocateCents(invoicedRevenue, invoiceWeights);
  const invoices = generateInvoices(rng, invoiceSlots, invoiceAmounts, tag, {
    serviceItems,
    paymentTerms
  });

  // --- Bills (82% of expenses) ---
  const billSlots = [];
  if (vendorCount > 0) {
    months.forEach((monthDate) => {
      vendorNames.forEach((vendorName) => {
        billSlots.push({
          vendorName,
          txnDate: pickDateInMonth(rng, monthDate, startDate, endDate)
        });
      });
    });
  }
  const billWeights = billSlots.map(() => randomBetween(rng, 0.75, 1.25));
  const billAmounts = allocateCents(formalBillExpenses, billWeights);
  const bills = generateBills(rng, billSlots, billAmounts, tag, expenseCategories);

  // --- Sales Receipts (8% of revenue) ---
  const salesReceipts = generateSalesReceipts(
    rng,
    cashSalesRevenue,
    months,
    customerNames,
    startDate,
    endDate,
    tag,
    serviceItems
  );

  // --- Direct Expenses (18% of expenses) ---
  const directExpenses = generateDirectExpenses(
    rng,
    directExpenseTotal,
    months,
    vendorNames,
    startDate,
    endDate,
    tag,
    expenseCategories
  );

  // --- Payments (settle ~80% of invoices, ~20% partial) ---
  const payments = generatePayments(rng, invoices, endDate, ratios);

  // --- Bill Payments (settle ~90% of bills) ---
  const billPayments = generateBillPayments(rng, bills, endDate, ratios);

  // --- Credit Memos (~4% of invoices) ---
  const creditMemos = generateCreditMemos(rng, invoices, tag, ratios);

  // --- Refund Receipts (~1.5% of revenue) ---
  const refundReceipts = generateRefundReceipts(
    rng,
    totalRevenue,
    months,
    customerNames,
    startDate,
    endDate,
    tag,
    ratios,
    serviceItems
  );

  // --- Vendor Credits (~2.5% of bills) ---
  const vendorCredits = generateVendorCredits(rng, bills, tag, ratios);

  // --- Deposits (group payments by date window) ---
  const deposits = generateDeposits(rng, payments, salesReceipts, ratios);

  // --- Transfers (ratio-driven per month) ---
  const transfers = generateTransfers(rng, months, startDate, endDate, ratios);

  // --- Journal Entries (depreciation + accruals) ---
  const journalEntries = generateJournalEntries(
    months,
    totalRevenue,
    startDate,
    endDate,
    tag,
    ratios
  );

  // --- Payroll ---
  const payroll = generatePayroll(
    payrollBudget,
    months,
    startDate,
    endDate,
    tag,
    includeBenefits,
    ratios
  );

  // --- Estimates ---
  const estimates = generateEstimates(rng, invoices, startDate, tag, ratios);

  // --- Purchase Orders ---
  const purchaseOrders = generatePurchaseOrders(rng, bills, startDate, tag, ratios);

  const plan = {
    meta: {
      generationVersion: GENERATION_VERSION,
      generatedBy: "EasyTestData (easytestdata.com)",
      industry: config.industry || null,
      startDate: toIsoDate(startDate),
      endDate: toIsoDate(endDate),
      seed: options.seed ?? null
    },
    tag,
    country,
    customers: parties.customers,
    vendors: parties.vendors,
    employees: parties.employees,
    includeBenefits,
    payroll,
    payrollVendor: parties.payrollVendor,
    serviceItemNames,
    expenseCategoryNames,
    invoices,
    bills,
    salesReceipts,
    directExpenses,
    payments,
    billPayments,
    creditMemos,
    refundReceipts,
    vendorCredits,
    deposits,
    transfers,
    journalEntries,
    estimates,
    purchaseOrders
  };

  plan.metrics = calculatePlanMetrics(plan, {
    totalRevenue,
    targetEbitda,
    topCustomerShare,
    topCustomerCount: customerProfile.topCustomerCount,
    monthCount: months.length
  });

  return plan;
}

// ---------------------------------------------------------------------------
// calculatePlanMetrics -- the metrics summarizing a plan
// ---------------------------------------------------------------------------

function calculatePlanMetrics(
  plan,
  { totalRevenue, targetEbitda, topCustomerShare, topCustomerCount, monthCount }
) {
  const nonZeroInvoices = plan.invoices.filter((i) => i.amount > 0);
  const customerRevenue = new Map();
  nonZeroInvoices.forEach((invoice) => {
    const current = customerRevenue.get(invoice.customerName) || 0;
    customerRevenue.set(invoice.customerName, current + invoice.amount);
  });
  const rankedRevenue = [...customerRevenue.entries()].sort((a, b) => b[1] - a[1]);
  const totalRevenueActual =
    plan.invoices.reduce((sum, entry) => sum + entry.amount, 0) +
    plan.salesReceipts.reduce((sum, entry) => sum + entry.amount, 0);
  const payrollTotal = plan.payroll.reduce((sum, entry) => sum + entry.totalAmount, 0);
  const totalExpensesActual =
    plan.bills.reduce((sum, entry) => sum + entry.amount, 0) +
    plan.directExpenses.reduce((sum, entry) => sum + entry.amount, 0) +
    payrollTotal;
  const topShareActual =
    totalRevenueActual === 0
      ? 0
      : rankedRevenue.slice(0, topCustomerCount).reduce((sum, [, value]) => sum + value, 0) /
        totalRevenueActual;

  return {
    totalRevenueRequested: totalRevenue,
    totalRevenueGenerated: Number(totalRevenueActual.toFixed(2)),
    targetEbitda,
    totalExpensesGenerated: Number(totalExpensesActual.toFixed(2)),
    ebitdaGenerated: Number((totalRevenueActual - totalExpensesActual).toFixed(2)),
    customerCount: plan.customers.length,
    vendorCount: plan.vendors.length,
    employeeCount: plan.employees.length,
    topCustomerCount,
    topCustomerShareRequested: Number((topCustomerShare * 100).toFixed(2)),
    topCustomerShareGenerated: Number((topShareActual * 100).toFixed(2)),
    invoiceCount: nonZeroInvoices.length,
    salesReceiptCount: plan.salesReceipts.filter((sr) => sr.amount > 0).length,
    billCount: plan.bills.filter((b) => b.amount > 0).length,
    directExpenseCount: plan.directExpenses.filter((de) => de.amount > 0).length,
    paymentCount: plan.payments.length,
    billPaymentCount: plan.billPayments.length,
    creditMemoCount: plan.creditMemos.length,
    refundReceiptCount: plan.refundReceipts.length,
    vendorCreditCount: plan.vendorCredits.length,
    depositCount: plan.deposits.length,
    transferCount: plan.transfers.length,
    journalEntryCount: plan.journalEntries.length,
    payrollRunCount: plan.payroll.length,
    payrollTotal: Number(payrollTotal.toFixed(2)),
    estimateCount: plan.estimates.length,
    purchaseOrderCount: plan.purchaseOrders.length,
    monthCount
  };
}
