import { normalizeArray } from "@easytestdata/core";
import { batchDelete, batchUpdate } from "./batch-helper.js";
import { getQueryItems } from "./qbo-client.js";
import { PURGE_TARGETS } from "./purge-service.js";
import { queryAll } from "./qbo-repository.js";
import { recordTypeLabel } from "./record-labels.js";

// A sandbox holds a few hundred sample records; this bounds a runaway listing, not a real one.
const MAX_PAGES = 1000;

// Accounts QuickBooks itself depends on: making them inactive is refused or breaks posting.
const SYSTEM_ACCOUNT_SUBTYPES = new Set([
  "AccountsReceivable",
  "AccountsPayable",
  "UndepositedFunds",
  "OpeningBalanceEquity",
  "RetainedEarnings",
  "GlobalTaxPayable"
]);

// Lists made inactive after every transaction is gone; accounts come last (see below).
const LIST_TARGETS = [
  { entity: "Customer", label: "customers", batch: "customer" },
  { entity: "Vendor", label: "vendors", batch: "vendor" },
  { entity: "Employee", label: "employees", batch: "employee" },
  { entity: "Item", label: "products and services", batch: "item" },
  { entity: "Class", label: "classes" },
  { entity: "Department", label: "locations" },
  { entity: "Term", label: "terms" },
  { entity: "PaymentMethod", label: "payment methods" }
];

// Refusals QuickBooks makes for its own reasons (a term used as a default, the built-in "Cash"
// payment method, an initial inventory adjustment): reported as leftovers, not as failures.
const LOCKED_BY_QUICKBOOKS =
  /used as the default|cash payment method|initial inventory adjustment|can't be deleted|cannot be deleted/i;

function cancelled(signal) {
  if (signal?.aborted) throw new Error("Clearing the sandbox was cancelled.");
}

function sortByTxnDateDesc(rows) {
  return [...rows].sort(
    (a, b) =>
      new Date(b.TxnDate || "1970-01-01").valueOf() - new Date(a.TxnDate || "1970-01-01").valueOf()
  );
}

// Children before parents, so QuickBooks never refuses a parent that still has active children.
function depth(row, byId) {
  let d = 0;
  for (
    let parent = row.ParentRef?.value;
    parent && d < 50;
    parent = byId.get(parent)?.ParentRef?.value
  ) {
    d += 1;
  }
  return d;
}

function childrenFirst(rows) {
  const byId = new Map(rows.map((row) => [row.Id, row]));
  return [...rows].sort((a, b) => {
    const categoryLast = (a.Type === "Category") - (b.Type === "Category");
    return categoryLast || depth(b, byId) - depth(a, byId);
  });
}

function faultMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Empties a sandbox before a copy: deletes every transaction (including recurring templates and
 * inventory adjustments), then makes every list record and account inactive. QuickBooks keeps
 * some sample data no app may remove (initial inventory adjustments, terms used as defaults, the
 * "Cash" payment method, its own balance-adjustment entries); those are returned in
 * `leftovers.records` rather than as failures. The caller measures leftover amounts itself.
 * Stops between steps once `signal` aborts; a request already sent finishes.
 */
export async function clearSandbox(client, { emit = () => {}, signal } = {}) {
  const report = {
    deletedByEntity: {},
    inactivatedByEntity: {},
    failures: [],
    leftovers: { records: [] }
  };
  const totalSteps = PURGE_TARGETS.length + 3 + LIST_TARGETS.length + 1;
  let step = 0;
  const progress = (message) => emit({ step: ++step, totalSteps, message });
  const refused = ({ entity, id, message }) =>
    report.leftovers.records.push({ entity, id, reason: "quickbooks-refused", message });
  const record = (failure) => {
    if (LOCKED_BY_QUICKBOOKS.test(failure.message)) {
      report.leftovers.records.push({
        entity: failure.entity,
        id: failure.id,
        reason: "locked-by-quickbooks"
      });
    } else {
      report.failures.push(failure);
    }
  };

  // 1. Transactions, in the purge order (deposits first, so linked payments can go).
  for (const target of PURGE_TARGETS) {
    cancelled(signal);
    progress(`Removing ${recordTypeLabel(target.queryName)}`);
    const rows = await queryAll(client, target.queryName, "*", "", MAX_PAGES, { signal });
    if (rows.length === 0) {
      report.deletedByEntity[target.queryName] = 0;
      continue;
    }
    const result = await batchDelete(client, target.endpoint, sortByTxnDateDesc(rows), {
      signal,
      entityLabel: target.queryName
    });
    report.deletedByEntity[target.queryName] = result.deletedCount;
    result.failures.forEach(record);
  }

  // 2. Recurring templates: rows come wrapped by their transaction type ({ Invoice: {...} }) and
  // are deleted with the same wrapper.
  cancelled(signal);
  progress("Removing recurring templates");
  const recurring = getQueryItems(
    await client.query("select * from RecurringTransaction maxresults 1000"),
    "RecurringTransaction"
  );
  report.deletedByEntity.RecurringTransaction = 0;
  for (const wrapped of recurring) {
    cancelled(signal);
    const [type, row] = Object.entries(wrapped)[0] || [];
    if (!row?.Id) continue;
    try {
      await client.request("POST", "/recurringtransaction", {
        params: { operation: "delete" },
        headers: { "Content-Type": "application/json" },
        data: { [type]: { Id: row.Id, SyncToken: row.SyncToken } }
      });
      report.deletedByEntity.RecurringTransaction += 1;
    } catch (error) {
      record({ entity: "RecurringTransaction", id: row.Id, message: faultMessage(error) });
    }
  }

  // 3. Inventory adjustments. An item's initial ("START") adjustment cannot be deleted; it is
  // zeroed instead while its item is still active, so it stops carrying a balance.
  cancelled(signal);
  progress("Removing inventory adjustments");
  const adjustments = await queryAll(client, "InventoryAdjustment", "*", "", MAX_PAGES, { signal });
  report.deletedByEntity.InventoryAdjustment = 0;
  const initial = [];
  for (const adjustment of adjustments) {
    cancelled(signal);
    if (adjustment.DocNumber === "START") {
      initial.push(adjustment);
      continue;
    }
    try {
      await client.delete("inventoryadjustment", adjustment.Id, adjustment.SyncToken);
      report.deletedByEntity.InventoryAdjustment += 1;
    } catch (error) {
      if (/initial inventory adjustment/i.test(faultMessage(error))) initial.push(adjustment);
      else
        record({ entity: "InventoryAdjustment", id: adjustment.Id, message: faultMessage(error) });
    }
  }

  cancelled(signal);
  progress("Zeroing starting inventory quantities");
  for (const adjustment of initial) {
    cancelled(signal);
    const leftover = {
      entity: "InventoryAdjustment",
      id: adjustment.Id,
      reason: "initial-inventory"
    };
    try {
      for (const line of normalizeArray(adjustment.Line)) {
        const itemId = line.ItemAdjustmentLineDetail?.ItemRef?.value;
        if (!itemId) continue;
        const item = getQueryItems(
          await client.query(
            `select * from Item where Id = '${itemId.replace(/\D/g, "")}' AND Active IN (true, false)`
          ),
          "Item"
        )[0];
        if (item && item.Active === false) {
          await client.update("item", {
            Id: item.Id,
            SyncToken: item.SyncToken,
            Name: item.Name,
            sparse: true,
            Active: true
          });
        }
      }
      await client.update("inventoryadjustment", {
        ...adjustment,
        Line: normalizeArray(adjustment.Line).map((line) => ({
          ...line,
          ItemAdjustmentLineDetail: { ...line.ItemAdjustmentLineDetail, QtyDiff: 0 }
        }))
      });
    } catch {
      report.leftovers.records.push(leftover);
    }
  }

  // 4. Lists, children before parents.
  for (const target of LIST_TARGETS) {
    cancelled(signal);
    progress(`Making ${target.label} inactive`);
    report.inactivatedByEntity[target.entity] = await inactivate(client, target, {
      signal,
      refused
    });
  }

  // 5. Accounts last (lists and transactions referenced them), keeping QuickBooks' own.
  cancelled(signal);
  progress("Making accounts inactive");
  report.inactivatedByEntity.Account = await inactivate(
    client,
    {
      entity: "Account",
      batch: "account",
      keep: (row) => SYSTEM_ACCOUNT_SUBTYPES.has(row.AccountSubType)
    },
    { signal, refused }
  );

  return report;
}

// QuickBooks refuses to make some built-in records inactive (sample "Uncategorized" accounts,
// default items and terms, the "Cash" payment method), often as "Request has invalid or
// unsupported property". Such a record simply stays: it is a leftover the copy measures, not a
// failure of the clearing.
async function inactivate(client, target, { signal, refused }) {
  const rows = (
    await queryAll(client, target.entity, "*", "Active = true", MAX_PAGES, { signal })
  ).filter((row) => !target.keep?.(row));
  if (rows.length === 0) return 0;
  const payload = (row) => ({
    Id: row.Id,
    SyncToken: row.SyncToken,
    sparse: true,
    Active: false,
    // Sent as read: the sandbox tests updated terms and payment methods with their name.
    ...(row.Name !== undefined ? { Name: row.Name } : {})
  });
  const ordered = childrenFirst(rows);

  if (target.batch) {
    const result = await batchUpdate(
      client,
      target.batch,
      ordered.map((row) => ({ payload: payload(row) })),
      { signal, entityLabel: target.entity }
    );
    result.failures.forEach(refused);
    return result.updatedCount;
  }

  let count = 0;
  for (const row of ordered) {
    cancelled(signal);
    try {
      await client.update(target.entity.toLowerCase(), payload(row));
      count += 1;
    } catch (error) {
      refused({ entity: target.entity, id: row.Id, message: faultMessage(error) });
    }
  }
  return count;
}
