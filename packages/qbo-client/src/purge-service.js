import { inactivateTaggedEntities, inactivateAllActive, queryAll } from "./qbo-repository.js";
import { recordTypeLabel } from "./record-labels.js";
import { isGeneratedRecord } from "./generated-identity.js";
import { batchDelete } from "./batch-helper.js";

export const PURGE_TARGETS = [
  // 1. Deposits first (frees linked payments / sales receipts)
  { endpoint: "deposit", queryName: "Deposit" },
  // 2. Receivables
  { endpoint: "payment", queryName: "Payment" },
  { endpoint: "salesreceipt", queryName: "SalesReceipt" },
  { endpoint: "creditmemo", queryName: "CreditMemo" },
  { endpoint: "refundreceipt", queryName: "RefundReceipt" },
  { endpoint: "estimate", queryName: "Estimate" },
  { endpoint: "invoice", queryName: "Invoice" },
  // 3. Payables
  { endpoint: "billpayment", queryName: "BillPayment" },
  { endpoint: "vendorcredit", queryName: "VendorCredit" },
  { endpoint: "bill", queryName: "Bill" },
  { endpoint: "purchaseorder", queryName: "PurchaseOrder" },
  // 4. Banking / other
  { endpoint: "purchase", queryName: "Purchase" },
  { endpoint: "transfer", queryName: "Transfer" },
  { endpoint: "journalentry", queryName: "JournalEntry" },
  { endpoint: "timeactivity", queryName: "TimeActivity" }
];

function sortByTxnDateDesc(items) {
  return [...items].sort((a, b) => {
    const aDate = new Date(a.TxnDate || "1970-01-01").valueOf();
    const bDate = new Date(b.TxnDate || "1970-01-01").valueOf();
    return bDate - aDate;
  });
}

export async function purgeTransactions(client, options = {}, emit = () => {}, signal = null) {
  const { mode = "generated", tag = "EZTD" } = options;
  if (mode !== "generated" && mode !== "all") {
    throw new Error(`Unknown purge mode "${mode}". Use "generated" or "all".`);
  }
  if (mode === "generated" && !String(tag || "").trim()) {
    throw new Error('A non-empty tag is required for purge mode "generated".');
  }
  const includeAll = mode === "all";

  const totalSteps = PURGE_TARGETS.length + 4;

  const report = {
    mode,
    deletedByEntity: {},
    failures: []
  };

  let currentStep = 0;

  for (const target of PURGE_TARGETS) {
    if (signal?.aborted) throw new Error("Purge cancelled: client disconnected.");
    currentStep += 1;
    emit({
      step: currentStep,
      totalSteps,
      message: `Checking ${recordTypeLabel(target.queryName)}...`
    });

    try {
      const allRows = await queryAll(client, target.queryName, "*", "", undefined, { signal });
      const candidateRows = includeAll
        ? allRows
        : allRows.filter((row) => isGeneratedRecord(target.queryName, row, tag));
      const orderedRows = sortByTxnDateDesc(candidateRows);

      if (orderedRows.length === 0) {
        report.deletedByEntity[target.queryName] = 0;
      } else {
        const step = currentStep;
        const result = await batchDelete(client, target.endpoint, orderedRows, {
          signal,
          onProgress: (done, total) =>
            emit({
              step,
              totalSteps,
              message: `Deleting ${recordTypeLabel(target.queryName)}... ${done} of ${total}`
            }),
          entityLabel: target.queryName
        });
        report.deletedByEntity[target.queryName] = result.deletedCount;
        report.failures.push(...result.failures);
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      report.deletedByEntity[target.queryName] = 0;
      report.failures.push({
        entity: target.queryName,
        id: null,
        message: error.message
      });
    }
  }

  // Inactivate master data (generated mode: the records generated-identity.js recognises by their
  // tag field; all mode: every active record)
  {
    const label = includeAll ? "all" : "test";
    // Refused inactivations count as failures too, so the job never reads as a clean success.
    const failures = report.failures;

    if (signal?.aborted) throw new Error("Purge cancelled: client disconnected.");
    currentStep += 1;
    emit({ step: currentStep, totalSteps, message: `Making ${label} customers inactive...` });
    const customersInactivated = includeAll
      ? await inactivateAllActive(client, "Customer", "DisplayName", { signal, failures })
      : await inactivateTaggedEntities(client, "Customer", tag, { signal, failures });

    if (signal?.aborted) throw new Error("Purge cancelled: client disconnected.");
    currentStep += 1;
    emit({ step: currentStep, totalSteps, message: `Making ${label} vendors inactive...` });
    const vendorsInactivated = includeAll
      ? await inactivateAllActive(client, "Vendor", "DisplayName", { signal, failures })
      : await inactivateTaggedEntities(client, "Vendor", tag, { signal, failures });

    if (signal?.aborted) throw new Error("Purge cancelled: client disconnected.");
    currentStep += 1;
    emit({ step: currentStep, totalSteps, message: `Making ${label} items inactive...` });
    const itemsInactivated = includeAll
      ? await inactivateAllActive(client, "Item", "Name", { signal, failures })
      : await inactivateTaggedEntities(client, "Item", tag, { signal, failures });

    if (signal?.aborted) throw new Error("Purge cancelled: client disconnected.");
    currentStep += 1;
    emit({ step: currentStep, totalSteps, message: `Making ${label} employees inactive...` });
    const employeesInactivated = includeAll
      ? await inactivateAllActive(client, "Employee", "DisplayName", { signal, failures })
      : await inactivateTaggedEntities(client, "Employee", tag, { signal, failures });

    report.masterData = {
      customersInactivated,
      vendorsInactivated,
      itemsInactivated,
      employeesInactivated
    };
  }

  report.deletedTotal = Object.values(report.deletedByEntity).reduce(
    (sum, value) => sum + value,
    0
  );
  report.failureCount = report.failures.length;

  return report;
}
