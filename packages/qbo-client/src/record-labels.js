/** QuickBooks entity names (as QBO queries them) in plain plural English, for progress messages. */
const RECORD_LABELS = {
  Bill: "bills",
  BillPayment: "bill payments",
  CreditMemo: "credit memos",
  Customer: "customers",
  Deposit: "deposits",
  Employee: "employees",
  Estimate: "estimates",
  Invoice: "invoices",
  Item: "items",
  JournalEntry: "journal entries",
  Payment: "payments",
  Purchase: "expenses and checks",
  PurchaseOrder: "purchase orders",
  RefundReceipt: "refund receipts",
  SalesReceipt: "sales receipts",
  TimeActivity: "time entries",
  Transfer: "transfers",
  Vendor: "vendors",
  VendorCredit: "vendor credits",
  Account: "accounts"
};

/** "BillPayment" -> "bill payments"; an unknown name is returned unchanged. */
export function recordTypeLabel(queryName) {
  return RECORD_LABELS[queryName] || queryName;
}
