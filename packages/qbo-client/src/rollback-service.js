import { batchDelete, batchUpdate } from "./batch-helper.js";
import { queryAll } from "./qbo-repository.js";
import { LoadLedger } from "./load-ledger.js";
import { recordTypeLabel } from "./record-labels.js";

// Map lowercase entity type keys to QBO query entity names
const QUERY_NAME_MAP = {
  journalentry: "JournalEntry",
  transfer: "Transfer",
  deposit: "Deposit",
  vendorcredit: "VendorCredit",
  refundreceipt: "RefundReceipt",
  creditmemo: "CreditMemo",
  billpayment: "BillPayment",
  payment: "Payment",
  purchase: "Purchase",
  salesreceipt: "SalesReceipt",
  bill: "Bill",
  invoice: "Invoice",
  purchaseorder: "PurchaseOrder",
  estimate: "Estimate",
  item: "Item",
  employee: "Employee",
  vendor: "Vendor",
  customer: "Customer",
  account: "Account"
};

/**
 * The ledger's entries that still exist (for deletes) or are still active (for inactivation),
 * with fresh SyncTokens; the ledger's own entries if the re-query fails (not when it was
 * cancelled: that stops the rollback).
 */
async function currentEntities(client, queryName, entities, whereClause, signal) {
  try {
    const fresh = await queryAll(client, queryName, "*", whereClause, undefined, { signal });
    const freshById = new Map(fresh.map((e) => [e.Id, e]));
    return entities
      .map((e) => freshById.get(e.Id))
      .filter(Boolean)
      .map((e) => ({ Id: e.Id, SyncToken: e.SyncToken }));
  } catch (err) {
    if (signal?.aborted) throw err;
    return entities;
  }
}

/**
 * Rollback a failed load: deletes every transaction tracked in the ledger (reverse dependency
 * order), then makes the master data it created or reactivated (items, employees, vendors,
 * customers) inactive, as purge does: QBO cannot delete those. Accounts stay, as purge leaves
 * them (QBO may refuse, and the rollback could then never succeed). Records already gone
 * or inactive are skipped, so a retry picks up where a failed rollback stopped.
 *
 * With `keepMasterData` (a later load on the same sandbox may be using those records), only the
 * transactions are deleted; the report's `keptMasterData` and `note` say what was kept.
 *
 * @param {import("./qbo-client.js").QboClient} client
 * @param {object} ledgerJson - Serialized LoadLedger (from job.result.ledger)
 * @param {(event: object) => void} [emit] - Progress callback
 * @param {AbortSignal} [signal]
 * @param {{ keepMasterData?: boolean }} [options]
 * @returns {Promise<{ deletedByEntity: Record<string, number>, inactivatedByEntity: Record<string, number>, failures: Array<object>, totalDeleted: number, totalInactivated: number }>}
 */
export async function rollbackLoad(
  client,
  ledgerJson,
  emit = () => {},
  signal = null,
  { keepMasterData = false } = {}
) {
  const ledger = LoadLedger.fromJSON(ledgerJson);
  const manifest = ledger.getCleanupManifest();
  const masterData = ledger.getInactivationManifest();
  const inactivation = keepMasterData ? [] : masterData;
  const totalSteps = manifest.length + inactivation.length;

  const report = {
    deletedByEntity: {},
    inactivatedByEntity: {},
    failures: [],
    totalDeleted: 0,
    totalInactivated: 0
  };
  // Accounts always stay (see load-ledger.js); other master data stays when a later load may
  // use it. The note tells the user what was kept and why.
  const keptAccounts = ledger.entities.get("account")?.length || 0;
  const keptOthers = keepMasterData
    ? masterData.reduce((n, { entities }) => n + entities.length, 0)
    : 0;
  const notes = [];
  if (keptOthers > 0) {
    notes.push(
      `Kept ${keptOthers} master records because a later load may use them; ` +
        'use "Remove test data" to remove all generated data.'
    );
  }
  if (keptAccounts > 0) {
    notes.push(
      `QuickBooks accounts are left in place, as "Remove test data" does (${keptAccounts} kept).`
    );
  }
  if (keptOthers + keptAccounts > 0) {
    report.keptMasterData = keptOthers + keptAccounts;
    report.note = notes.join(" ");
  }

  for (let i = 0; i < manifest.length; i++) {
    if (signal?.aborted) throw new Error("Rollback cancelled.");

    const { entityType, entities } = manifest[i];
    const queryName = QUERY_NAME_MAP[entityType] || entityType;
    emit({
      step: i + 1,
      totalSteps,
      message: `Rolling back ${recordTypeLabel(queryName)}... (${entities.length} records)`
    });

    // Refresh SyncTokens in case they've gone stale since the original load
    const entitiesToDelete = await currentEntities(client, queryName, entities, "", signal);

    if (entitiesToDelete.length === 0) {
      report.deletedByEntity[entityType] = 0;
      continue;
    }

    const result = await batchDelete(client, entityType, entitiesToDelete, {
      signal,
      onProgress: (done, total) =>
        emit({
          step: i + 1,
          totalSteps,
          message: `Rolling back ${recordTypeLabel(queryName)}... ${done} of ${total}`
        }),
      entityLabel: queryName
    });

    report.deletedByEntity[entityType] = result.deletedCount;
    report.failures.push(...result.failures);
    report.totalDeleted += result.deletedCount;
  }

  for (let i = 0; i < inactivation.length; i++) {
    if (signal?.aborted) throw new Error("Rollback cancelled.");

    const { entityType, entities } = inactivation[i];
    const queryName = QUERY_NAME_MAP[entityType];
    const step = manifest.length + i + 1;
    emit({
      step,
      totalSteps,
      message: `Making ${recordTypeLabel(queryName)} inactive... (${entities.length} records)`
    });

    const active = await currentEntities(client, queryName, entities, "Active = true", signal);
    if (active.length === 0) {
      report.inactivatedByEntity[entityType] = 0;
      continue;
    }

    const result = await batchUpdate(
      client,
      entityType,
      active.map((e) => ({
        payload: { Id: e.Id, SyncToken: e.SyncToken, sparse: true, Active: false }
      })),
      {
        signal,
        onProgress: (done, total) =>
          emit({
            step,
            totalSteps,
            message: `Making ${recordTypeLabel(queryName)} inactive... ${done} of ${total}`
          }),
        entityLabel: queryName
      }
    );

    report.inactivatedByEntity[entityType] = result.updatedCount;
    report.failures.push(...result.failures);
    report.totalInactivated += result.updatedCount;
  }

  return report;
}
