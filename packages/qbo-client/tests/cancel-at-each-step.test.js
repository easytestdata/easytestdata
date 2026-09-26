import { afterEach, describe, expect, it, vi } from "vitest";
import axios from "axios";
import { QboClient, QboRequestCancelledError } from "../src/qbo-client.js";
import { purgeTransactions } from "../src/purge-service.js";
import { rollbackLoad } from "../src/rollback-service.js";
import { LoadLedger } from "../src/load-ledger.js";

// Cancellation reaches every step: a long operation is cancelled at the start of each of its QBO
// calls in turn (call 1, then call 2, ...), and must start no further call after the abort and
// end cancelled (reject), never complete.

const TAG = "EZTD";

/**
 * A fake QBO client over a fixture { EntityName: rows }. Calls are recorded in start order and
 * `onCall(n)` runs synchronously as call n starts, so a test can abort exactly there; the call
 * itself still answers, like a request already sent.
 */
function fakeQbo(fixture) {
  const calls = [];
  const client = {
    calls,
    onCall: () => {},
    start(kind, detail) {
      calls.push([kind, detail]);
      client.onCall(calls.length);
    },
    async query(sql) {
      const entity = sql.match(/from (\w+)/i)[1];
      client.start("query", entity);
      const start = Number(sql.match(/startposition (\d+)/)?.[1] || 1);
      const size = Number(sql.match(/maxresults (\d+)/)?.[1] || 500);
      let rows = fixture[entity] || [];
      if (/Active = true/.test(sql)) rows = rows.filter((r) => r.Active !== false);
      return { QueryResponse: { [entity]: rows.slice(start - 1, start - 1 + size) } };
    },
    async batch(items) {
      client.start("batch", items.length);
      return {
        BatchItemResponse: items.map((item) => {
          const [key] = Object.keys(item).filter((k) => !["bId", "operation"].includes(k));
          return { bId: item.bId, [key]: { Id: item[key].Id || `new-${item.bId}` } };
        })
      };
    },
    async update(entity, payload) {
      client.start("update", entity);
      return { [entity]: payload };
    },
    async create(entity, payload) {
      client.start("create", entity);
      return { [entity]: { ...payload, Id: "new" } };
    }
  };
  return client;
}

const rows = (n, entity, extra = {}) =>
  Array.from({ length: n }, (_, i) => ({
    Id: `${entity}-${i + 1}`,
    SyncToken: "0",
    Active: true,
    ...extra
  }));

/** A sandbox where every purge step has work, and the master data spans several batches. */
function purgeFixture() {
  const tagged = { PrivateNote: TAG, TxnDate: "2026-01-01" };
  return {
    Deposit: rows(1, "dep", tagged),
    Payment: rows(1, "pay", tagged),
    SalesReceipt: rows(1, "sr", tagged),
    CreditMemo: rows(1, "cm", tagged),
    RefundReceipt: rows(1, "rr", tagged),
    Estimate: rows(1, "est", tagged),
    Invoice: rows(35, "inv", tagged), // two batches
    BillPayment: rows(1, "bp", tagged),
    VendorCredit: rows(1, "vc", tagged),
    Bill: rows(1, "bill", tagged),
    PurchaseOrder: rows(1, "po", tagged),
    Purchase: rows(1, "pur", tagged),
    Transfer: rows(1, "tr", tagged),
    JournalEntry: rows(1, "je", tagged),
    TimeActivity: rows(1, "ta", tagged),
    Customer: rows(61, "cust", { Notes: `${TAG}-CUST-1`, DisplayName: "Acme" }), // three batches
    Vendor: rows(31, "vend", { AcctNum: `${TAG}-VEND-1`, DisplayName: "Supply" }), // two
    Item: rows(1, "item", { Description: TAG, Name: "EZTD-CONSULT" }),
    Employee: rows(1, "emp", { EmployeeNumber: `${TAG}-EMP-1`, DisplayName: "Pat" })
  };
}

function ledgerFixture() {
  const ledger = new LoadLedger();
  const record = (type, list) =>
    ledger.recordBatchResults(type, { results: list.map((entity) => ({ entity })) });
  record("invoice", rows(35, "inv"));
  record("payment", rows(1, "pay"));
  record("customer", rows(61, "cust"));
  record("vendor", rows(31, "vend"));
  record("item", rows(1, "item"));
  return ledger.toJSON();
}

function rollbackFixture() {
  return {
    Invoice: rows(35, "inv"),
    Payment: rows(1, "pay"),
    Customer: rows(61, "cust"),
    Vendor: rows(31, "vend"),
    Item: rows(1, "item")
  };
}

/**
 * Runs `operation(client, signal)` once to count its QBO calls, then once per call k, aborting
 * as call k starts: exactly k calls may have started, and the operation must reject.
 */
async function expectCancellableAtEveryCall(fixture, operation) {
  const dry = fakeQbo(fixture());
  await operation(dry, new AbortController().signal);
  const total = dry.calls.length;
  expect(total).toBeGreaterThan(10);

  for (let k = 1; k <= total; k++) {
    const controller = new AbortController();
    const client = fakeQbo(fixture());
    client.onCall = (n) => n === k && controller.abort();
    const outcome = await operation(client, controller.signal).then(
      () => "completed",
      (err) => err
    );
    expect({ k, calls: client.calls.length, after: client.calls.slice(k) }).toEqual({
      k,
      calls: k,
      after: []
    });
    expect(outcome).toBeInstanceOf(Error);
  }
  return total;
}

describe("cancelling at every QBO call", () => {
  it.each(["generated", "all"])(
    "purge (%s mode) stops at once and ends cancelled",
    async (mode) => {
      const total = await expectCancellableAtEveryCall(purgeFixture, (client, signal) =>
        purgeTransactions(client, { mode, tag: TAG }, () => {}, signal)
      );
      // Every transaction type is queried, and the master data takes several batches.
      expect(total).toBeGreaterThanOrEqual(15 + 4 + 3 + 2);
    }
  );

  it("rollback stops at once and ends cancelled", async () => {
    const ledger = ledgerFixture();
    await expectCancellableAtEveryCall(rollbackFixture, (client, signal) =>
      rollbackLoad(client, ledger, () => {}, signal)
    );
  });
});

describe("QboClient bound to a signal", () => {
  afterEach(() => vi.restoreAllMocks());

  const newClient = (signal) => new QboClient({ qboRealmId: "1", qboAccessToken: "token", signal });

  it("sends nothing once the signal has aborted", async () => {
    const send = vi.spyOn(axios, "request").mockResolvedValue({ data: {} });
    const controller = new AbortController();
    const client = newClient(controller.signal);
    await client.query("select * from Invoice");
    expect(send).toHaveBeenCalledTimes(1);

    controller.abort();
    await expect(client.query("select * from Invoice")).rejects.toBeInstanceOf(
      QboRequestCancelledError
    );
    await expect(client.batch([])).rejects.toBeInstanceOf(QboRequestCancelledError);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not retry a refused (429) request after the abort, and stops waiting at once", async () => {
    const controller = new AbortController();
    const send = vi.spyOn(axios, "request").mockImplementation(async () => {
      controller.abort();
      throw Object.assign(new Error("Too Many Requests"), { response: { status: 429 } });
    });
    const client = newClient(controller.signal);
    const started = Date.now();
    await expect(client.query("select * from Invoice")).rejects.toBeInstanceOf(
      QboRequestCancelledError
    );
    expect(send).toHaveBeenCalledTimes(1);
    // The 1 s retry backoff was cut short by the abort.
    expect(Date.now() - started).toBeLessThan(500);
  });
});
