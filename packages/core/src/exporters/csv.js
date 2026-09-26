// CSV export: one RFC 4180 table per entity type. No comment/preamble lines, one value per
// cell, and child rows (invoice_lines, bill_lines, ...) reference their parent by id.

// Text that starts with = + - @ tab or CR is evaluated as a formula by spreadsheet apps
// (CSV/formula injection). Names can come from user-defined templates, so such cells get a
// leading single quote; plain numbers (including negative amounts) are left untouched.
const FORMULA_PREFIX = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;

function toCsvCell(value) {
  let str = String(value ?? "");
  if (FORMULA_PREFIX.test(str) && !PLAIN_NUMBER.test(str)) str = `'${str}`;
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function table(header, rows) {
  return [header, ...rows].map((row) => row.map(toCsvCell).join(",")).join("\r\n") + "\r\n";
}

function seqId(prefix, index) {
  return `${prefix}-${String(index + 1).padStart(4, "0")}`;
}

const PARTY_HEADER = [
  "email",
  "phone",
  "address_line1",
  "city",
  "region",
  "postal_code",
  "country"
];

function partyCells(party) {
  const a = party.address || {};
  return [party.email, party.phone, a.line1, a.city, a.region, a.postalCode, a.country];
}

/**
 * Export a plan as CSV tables. Returns `{ [tableName]: csvText }`, where each table name is
 * suitable as a file name (e.g. `invoices` -> invoices.csv, `invoice_lines` -> invoice_lines.csv).
 */
export function exportToCsv(plan) {
  const invoiceDoc = (i) => plan.invoices[i]?.docNumber ?? "";
  const billDoc = (i) => plan.bills[i]?.docNumber ?? "";
  const vendors = plan.payrollVendor ? [...plan.vendors, plan.payrollVendor] : plan.vendors;

  return {
    customers: table(
      ["id", "name", ...PARTY_HEADER],
      plan.customers.map((c) => [c.id, c.name, ...partyCells(c)])
    ),
    vendors: table(
      ["id", "name", ...PARTY_HEADER],
      vendors.map((v) => [v.id, v.name, ...partyCells(v)])
    ),
    employees: table(
      ["id", "name", "given_name", "family_name", ...PARTY_HEADER],
      plan.employees.map((e) => [e.id, e.name, e.givenName, e.familyName, ...partyCells(e)])
    ),
    invoices: table(
      ["doc_number", "customer", "txn_date", "due_date", "amount"],
      plan.invoices.map((inv) => [
        inv.docNumber,
        inv.customerName,
        inv.txnDate,
        inv.dueDate,
        inv.amount
      ])
    ),
    invoice_lines: table(
      ["invoice_doc_number", "line_number", "service_item", "amount"],
      plan.invoices.flatMap((inv) =>
        inv.lines.map((l, n) => [inv.docNumber, n + 1, l.serviceItemName, l.amount])
      )
    ),
    bills: table(
      ["doc_number", "vendor", "txn_date", "amount"],
      plan.bills.map((b) => [b.docNumber, b.vendorName, b.txnDate, b.amount])
    ),
    bill_lines: table(
      ["bill_doc_number", "line_number", "expense_category", "amount"],
      plan.bills.flatMap((b) =>
        b.lines.map((l, n) => [b.docNumber, n + 1, l.expenseCategory, l.amount])
      )
    ),
    sales_receipts: table(
      ["id", "customer", "txn_date", "amount", "service_item"],
      plan.salesReceipts.map((sr, i) => [
        seqId("SR", i),
        sr.customerName,
        sr.txnDate,
        sr.amount,
        sr.serviceItemName
      ])
    ),
    direct_expenses: table(
      ["vendor", "txn_date", "amount", "payment_type", "expense_category"],
      plan.directExpenses.map((de) => [
        de.vendorName,
        de.txnDate,
        de.amount,
        de.paymentType,
        de.expenseCategory
      ])
    ),
    payments: table(
      ["id", "invoice_doc_number", "customer", "txn_date", "amount"],
      plan.payments.map((p, i) => [
        seqId("PMT", i),
        invoiceDoc(p.invoiceIndex),
        p.customerName,
        p.txnDate,
        p.amount
      ])
    ),
    bill_payments: table(
      ["bill_doc_number", "vendor", "txn_date", "amount"],
      plan.billPayments.map((bp) => [billDoc(bp.billIndex), bp.vendorName, bp.txnDate, bp.amount])
    ),
    credit_memos: table(
      ["invoice_doc_number", "customer", "txn_date", "amount", "service_item"],
      plan.creditMemos.map((cm) => [
        invoiceDoc(cm.invoiceIndex),
        cm.customerName,
        cm.txnDate,
        cm.amount,
        cm.serviceItemName
      ])
    ),
    refund_receipts: table(
      ["customer", "txn_date", "amount", "service_item"],
      plan.refundReceipts.map((rr) => [rr.customerName, rr.txnDate, rr.amount, rr.serviceItemName])
    ),
    vendor_credits: table(
      ["bill_doc_number", "vendor", "txn_date", "amount", "expense_category"],
      plan.vendorCredits.map((vc) => [
        billDoc(vc.billIndex),
        vc.vendorName,
        vc.txnDate,
        vc.amount,
        vc.expenseCategory
      ])
    ),
    estimates: table(
      ["doc_number", "customer", "txn_date", "amount", "service_item"],
      plan.estimates.map((e) => [
        e.docNumber,
        e.customerName,
        e.txnDate,
        e.amount,
        e.serviceItemName
      ])
    ),
    purchase_orders: table(
      ["doc_number", "vendor", "txn_date", "amount", "expense_category"],
      plan.purchaseOrders.map((po) => [
        po.docNumber,
        po.vendorName,
        po.txnDate,
        po.amount,
        po.expenseCategory
      ])
    ),
    deposits: table(
      ["id", "txn_date", "amount", "account_type"],
      plan.deposits.map((d, i) => [
        seqId("DEP", i),
        d.txnDate,
        d.amount,
        d.depositAccountType || "checking"
      ])
    ),
    deposit_lines: table(
      ["deposit_id", "source_type", "source_id", "amount"],
      plan.deposits.flatMap((d, i) =>
        d.lineItems.map((li) =>
          li.type === "payment"
            ? [seqId("DEP", i), "payment", seqId("PMT", li.index), li.amount]
            : [seqId("DEP", i), "sales_receipt", seqId("SR", li.index), li.amount]
        )
      )
    ),
    transfers: table(
      ["txn_date", "amount"],
      plan.transfers.map((t) => [t.txnDate, t.amount])
    ),
    journal_entries: table(
      ["txn_date", "amount", "type", "memo"],
      plan.journalEntries.map((je) => [je.txnDate, je.amount, je.type, je.memo])
    ),
    payroll_runs: table(
      ["id", "txn_date", "payee", "total_amount"],
      plan.payroll.map((pr, i) => [
        seqId("PAY", i),
        pr.txnDate,
        plan.payrollVendor?.name ?? "",
        pr.totalAmount
      ])
    ),
    payroll_lines: table(
      ["payroll_id", "account", "amount"],
      plan.payroll.flatMap((pr, i) =>
        pr.lines.map((l) => [seqId("PAY", i), l.accountName, l.amount])
      )
    )
  };
}
