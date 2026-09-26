import { normalizeArray } from "@easytestdata/core";

const CHUNK_SIZE = 30;
const BATCH_CONCURRENCY = 2;

const ENTITY_KEY_MAP = {
  invoice: "Invoice",
  bill: "Bill",
  estimate: "Estimate",
  purchaseorder: "PurchaseOrder",
  salesreceipt: "SalesReceipt",
  purchase: "Purchase",
  payment: "Payment",
  billpayment: "BillPayment",
  creditmemo: "CreditMemo",
  refundreceipt: "RefundReceipt",
  vendorcredit: "VendorCredit",
  deposit: "Deposit",
  transfer: "Transfer",
  journalentry: "JournalEntry",
  timeactivity: "TimeActivity",
  customer: "Customer",
  vendor: "Vendor",
  item: "Item",
  employee: "Employee",
  account: "Account"
};

/**
 * Runs `chunks` through `runChunk` with up to BATCH_CONCURRENCY in flight. When `signal` aborts,
 * no new chunk is started and every in-flight chunk is drained (its records were created in QBO
 * whether or not we wait for the answer) before `cancelled(partial)` builds the error to throw,
 * so callers can record what already exists instead of losing it.
 */
async function runChunks(chunks, signal, runChunk, cancelled) {
  const inFlight = new Set();
  const track = (task) => {
    inFlight.add(task);
    const done = () => inFlight.delete(task);
    task.then(done, done);
  };

  for (const chunk of chunks) {
    if (signal?.aborted) break;
    track(runChunk(chunk));
    if (inFlight.size >= BATCH_CONCURRENCY) {
      await Promise.race(inFlight).catch(() => {});
    }
  }

  const settled = await Promise.allSettled(inFlight);
  if (signal?.aborted) throw cancelled();
  const failed = settled.find((s) => s.status === "rejected");
  if (failed) throw failed.reason;
}

function chunkItems(items) {
  const chunks = [];
  for (let start = 0; start < items.length; start += CHUNK_SIZE) {
    chunks.push({ start, chunk: items.slice(start, start + CHUNK_SIZE) });
  }
  return chunks;
}

function cancelledError(message, partial) {
  const err = new Error(message);
  err.partial = partial;
  return err;
}

// ---------------------------------------------------------------------------
// batchCreate — send create operations in chunks of 30 (up to 2 concurrent)
// ---------------------------------------------------------------------------
// items:   [{ payload, originalIndex?, ref? }]
// options: { signal, onProgress(done, total), entityLabel, onCreated(results) }
// returns: { results: [{ originalIndex, entity }], count, failures }
//
// `onCreated` is called with each batch's created entities as soon as that batch answers, so a
// ledger stays complete if a later batch (or the whole load) is aborted. On abort the thrown
// error carries `partial` = { results, count, failures } for everything created so far.

export async function batchCreate(client, entityType, items, options = {}) {
  const { signal, onProgress, entityLabel, onCreated } = options;
  const entityKey = ENTITY_KEY_MAP[entityType];
  if (!entityKey) throw new Error(`Unknown entity type for batch: ${entityType}`);

  const results = [];
  const failures = [];
  let count = 0;
  let processed = 0;

  await runChunks(
    chunkItems(items),
    signal,
    async ({ start, chunk }) => {
      const batchRequest = chunk.map((item, idx) => ({
        bId: String(start + idx),
        operation: "create",
        [entityKey]: item.payload
      }));

      try {
        const response = await client.batch(batchRequest);
        const responseItems = normalizeArray(response?.BatchItemResponse);
        const created = [];

        for (const resp of responseItems) {
          const idx = parseInt(resp.bId, 10);
          const item = items[idx];

          if (resp.Fault) {
            const errors = normalizeArray(resp.Fault?.Error);
            const msg = errors.map((e) => e.Message || "Unknown").join("; ") || "Batch item failed";
            failures.push({ entity: entityLabel || entityKey, ref: item.ref, message: msg });
          } else {
            const entity = resp[entityKey];
            if (entity?.Id) {
              created.push({ originalIndex: item.originalIndex, entity });
            } else {
              failures.push({
                entity: entityLabel || entityKey,
                ref: item.ref,
                message: "No Id in batch response"
              });
            }
          }
        }

        results.push(...created);
        count += created.length;
        if (onCreated && created.length > 0) onCreated(created);
      } catch (error) {
        // An aborted request may or may not have been applied by QBO; it is not a failure of
        // the items, and the abort is reported by runChunks.
        if (signal?.aborted) return;
        for (const item of chunk) {
          failures.push({
            entity: entityLabel || entityKey,
            ref: item.ref,
            message: error.message
          });
        }
      }

      processed += chunk.length;
      if (onProgress) onProgress(processed, items.length);
    },
    () => cancelledError("Operation cancelled: client disconnected.", { results, count, failures })
  );

  return { results, count, failures };
}

// ---------------------------------------------------------------------------
// batchDelete — send delete operations in chunks of 30 (up to 2 concurrent)
// ---------------------------------------------------------------------------
// rows:    [{ Id, SyncToken }]
// options: { signal, onProgress(done, total), entityLabel }
// returns: { deletedCount, failures }

export async function batchDelete(client, entityType, rows, options = {}) {
  const { signal, onProgress, entityLabel } = options;
  const entityKey = ENTITY_KEY_MAP[entityType];
  if (!entityKey) throw new Error(`Unknown entity type for batch: ${entityType}`);

  const failures = [];
  let deletedCount = 0;
  let processed = 0;

  await runChunks(
    chunkItems(rows),
    signal,
    async ({ start, chunk }) => {
      const batchRequest = chunk.map((row, idx) => ({
        bId: String(start + idx),
        operation: "delete",
        [entityKey]: { Id: row.Id, SyncToken: row.SyncToken }
      }));

      try {
        const response = await client.batch(batchRequest);
        const responseItems = normalizeArray(response?.BatchItemResponse);

        for (const resp of responseItems) {
          if (resp.Fault) {
            const idx = parseInt(resp.bId, 10);
            const row = rows[idx];
            const errors = normalizeArray(resp.Fault?.Error);
            const msg =
              errors.map((e) => e.Message || "Unknown").join("; ") || "Batch delete failed";
            failures.push({ entity: entityLabel || entityKey, id: row.Id, message: msg });
          } else {
            deletedCount++;
          }
        }
      } catch (error) {
        if (signal?.aborted) return;
        for (const row of chunk) {
          failures.push({ entity: entityLabel || entityKey, id: row.Id, message: error.message });
        }
      }

      processed += chunk.length;
      if (onProgress) onProgress(processed, rows.length);
    },
    () => cancelledError("Purge cancelled: client disconnected.", { deletedCount, failures })
  );

  return { deletedCount, failures };
}

// ---------------------------------------------------------------------------
// batchUpdate — send update operations in chunks of 30 (up to 2 concurrent)
// ---------------------------------------------------------------------------
// items:   [{ payload }]
// options: { signal, onProgress(done, total), entityLabel }
// returns: { updatedCount, failures }

export async function batchUpdate(client, entityType, items, options = {}) {
  const { signal, onProgress, entityLabel } = options;
  const entityKey = ENTITY_KEY_MAP[entityType];
  if (!entityKey) throw new Error(`Unknown entity type for batch: ${entityType}`);

  const failures = [];
  let updatedCount = 0;
  let processed = 0;

  await runChunks(
    chunkItems(items),
    signal,
    async ({ start, chunk }) => {
      const batchRequest = chunk.map((item, idx) => ({
        bId: String(start + idx),
        operation: "update",
        [entityKey]: item.payload
      }));

      try {
        const response = await client.batch(batchRequest);
        const responseItems = normalizeArray(response?.BatchItemResponse);

        for (const resp of responseItems) {
          if (resp.Fault) {
            const idx = parseInt(resp.bId, 10);
            const item = items[idx];
            const errors = normalizeArray(resp.Fault?.Error);
            const msg =
              errors.map((e) => e.Message || "Unknown").join("; ") || "Batch update failed";
            failures.push({
              entity: entityLabel || entityKey,
              id: item.payload?.Id,
              message: msg
            });
          } else {
            updatedCount++;
          }
        }
      } catch (error) {
        if (signal?.aborted) return;
        for (const item of chunk) {
          failures.push({
            entity: entityLabel || entityKey,
            id: item.payload?.Id,
            message: error.message
          });
        }
      }

      processed += chunk.length;
      if (onProgress) onProgress(processed, items.length);
    },
    () => cancelledError("Operation cancelled: client disconnected.", { updatedCount, failures })
  );

  return { updatedCount, failures };
}
