import { describe, expect, it } from "vitest";
import { clearSandbox } from "../src/clear-sandbox.js";
import { PURGE_TARGETS } from "../src/purge-service.js";

// An in-memory QuickBooks: enough of query/batch/update/delete/request for clearSandbox.
function fakeQbo(tables, { refuse = {} } = {}) {
  const calls = [];
  const rows = (entity) => (tables[entity] ||= []);
  const find = (entity, id) => rows(entity).find((row) => row.Id === id);
  const fault = (message) => Object.assign(new Error(message), { qbo: true });
  const check = (op, entity, row) => {
    const reason = refuse[`${op}:${entity}:${row.Id}`];
    if (reason) throw fault(reason);
  };
  const apply = (op, entity, payload) => {
    const row = find(entity, payload.Id);
    check(op, entity, payload);
    // Like QuickBooks: a parent can't be made inactive while a child is still active.
    if (op === "update" && payload.Active === false) {
      const activeChild = rows(entity).find(
        (r) => r.ParentRef?.value === payload.Id && r.Active !== false
      );
      if (activeChild) throw fault(`${entity} ${payload.Id} still has active children`);
    }
    if (op === "delete") {
      tables[entity] = rows(entity).filter((r) => r.Id !== payload.Id);
    } else {
      Object.assign(row, payload);
    }
  };
  const lower = (key) =>
    Object.keys(tables).find((entity) => entity.toLowerCase() === key) ||
    key.charAt(0).toUpperCase() + key.slice(1);
  return {
    calls,
    async query(sql) {
      calls.push(["query", sql]);
      const [, entity] = sql.match(/from (\w+)/i);
      let result = rows(entity);
      if (/Active = true/.test(sql)) result = result.filter((r) => r.Active !== false);
      const id = sql.match(/Id = '(\d+)'/);
      if (id) result = result.filter((r) => r.Id === id[1]);
      const start = Number(sql.match(/startposition (\d+)/i)?.[1] ?? 1);
      const max = Number(sql.match(/maxresults (\d+)/i)?.[1] ?? 1000);
      return { QueryResponse: { [entity]: result.slice(start - 1, start - 1 + max) } };
    },
    async batch(items) {
      calls.push([
        "batch",
        items.map((i) => {
          const entity = Object.keys(i).find((k) => k !== "bId" && k !== "operation");
          return `${i.operation}:${entity}:${i[entity].Id}`;
        })
      ]);
      return {
        BatchItemResponse: items.map((item) => {
          const entity = Object.keys(item).find((k) => k !== "bId" && k !== "operation");
          try {
            apply(item.operation, entity, item[entity]);
            return { bId: item.bId, [entity]: item[entity] };
          } catch (error) {
            return { bId: item.bId, Fault: { Error: [{ Message: error.message }] } };
          }
        })
      };
    },
    async update(endpoint, payload) {
      calls.push(["update", endpoint, payload.Id]);
      apply("update", lower(endpoint), payload);
      return {};
    },
    async delete(endpoint, id) {
      calls.push(["delete", endpoint, id]);
      apply("delete", lower(endpoint), { Id: id });
      return {};
    },
    async request(method, path, { data }) {
      calls.push(["request", path]);
      const [type, body] = Object.entries(data)[0];
      tables.RecurringTransaction = rows("RecurringTransaction").filter(
        (wrapped) => wrapped[type]?.Id !== body.Id
      );
      return {};
    }
  };
}

const sample = () => ({
  Invoice: [
    { Id: "1", SyncToken: "0", TxnDate: "2026-01-01" },
    { Id: "2", SyncToken: "0", TxnDate: "2026-02-01" }
  ],
  Deposit: [{ Id: "3", SyncToken: "0", TxnDate: "2026-01-05" }],
  RecurringTransaction: [{ Bill: { Id: "20", SyncToken: "0" } }],
  InventoryAdjustment: [
    {
      Id: "30",
      SyncToken: "0",
      DocNumber: "START",
      Line: [{ ItemAdjustmentLineDetail: { ItemRef: { value: "11" }, QtyDiff: 16 } }]
    },
    { Id: "31", SyncToken: "0", DocNumber: "A-1", Line: [] }
  ],
  Customer: [
    { Id: "40", SyncToken: "0", DisplayName: "Parent Co", Active: true },
    { Id: "41", SyncToken: "0", DisplayName: "Job", Active: true, ParentRef: { value: "40" } }
  ],
  Item: [
    { Id: "10", SyncToken: "0", Name: "Tools", Type: "Category", Active: true },
    {
      Id: "11",
      SyncToken: "0",
      Name: "Pump",
      Type: "Inventory",
      Active: false,
      ParentRef: { value: "10" }
    }
  ],
  Term: [
    { Id: "50", SyncToken: "0", Name: "Net 30", Active: true },
    { Id: "51", SyncToken: "0", Name: "Net 60", Active: true }
  ],
  PaymentMethod: [{ Id: "60", SyncToken: "0", Name: "Cash", Active: true }],
  Account: [
    { Id: "70", SyncToken: "0", Name: "Checking", AccountSubType: "Checking", Active: true },
    {
      Id: "71",
      SyncToken: "0",
      Name: "Accounts Receivable (A/R)",
      AccountSubType: "AccountsReceivable",
      Active: true
    },
    {
      Id: "72",
      SyncToken: "0",
      Name: "Board of Equalization Payable",
      AccountSubType: "GlobalTaxPayable",
      Active: true
    }
  ]
});

describe("clearSandbox", () => {
  it("deletes transactions in purge order, then templates and adjustments, then lists, accounts last", async () => {
    const tables = sample();
    const qbo = fakeQbo(tables);
    const report = await clearSandbox(qbo);

    expect(tables.Invoice).toEqual([]);
    expect(tables.Deposit).toEqual([]);
    expect(report.deletedByEntity).toMatchObject({
      Invoice: 2,
      Deposit: 1,
      RecurringTransaction: 1,
      InventoryAdjustment: 1
    });
    expect(tables.RecurringTransaction).toEqual([]);
    // Deposits are queried before invoices (purge order), accounts after every list.
    const queried = qbo.calls
      .filter(([op]) => op === "query")
      .map(([, sql]) => sql.match(/from (\w+)/)[1]);
    expect(queried.indexOf("Deposit")).toBeLessThan(queried.indexOf("Invoice"));
    expect(queried.lastIndexOf("Account")).toBeGreaterThan(queried.lastIndexOf("PaymentMethod"));
    expect(queried.slice(0, PURGE_TARGETS.length)).toEqual(PURGE_TARGETS.map((t) => t.queryName));
    expect(report.failures).toEqual([]);
  });

  it("zeroes an initial inventory adjustment (reactivating its item) instead of deleting it", async () => {
    const tables = sample();
    const qbo = fakeQbo(tables);
    await clearSandbox(qbo);
    const start = tables.InventoryAdjustment.find((a) => a.Id === "30");
    expect(start.Line[0].ItemAdjustmentLineDetail.QtyDiff).toBe(0);
    expect(qbo.calls).toContainEqual(["update", "item", "11"]);
    // The item is made inactive again by the list step.
    expect(tables.Item.find((i) => i.Id === "11").Active).toBe(false);
  });

  it("reports an initial adjustment QuickBooks will not change as a leftover", async () => {
    const tables = sample();
    const qbo = fakeQbo(tables, {
      refuse: {
        "update:InventoryAdjustment:30":
          "A business validation error has occurred while processing your request (Business Validation Error: You need to activate this item before updating the quantity.)"
      }
    });
    const report = await clearSandbox(qbo);
    expect(report.leftovers.records).toContainEqual({
      entity: "InventoryAdjustment",
      id: "30",
      reason: "initial-inventory"
    });
    expect(report.failures).toEqual([]);
  });

  it("makes children inactive before parents and categories last", async () => {
    const tables = sample();
    const qbo = fakeQbo(tables);
    await clearSandbox(qbo);
    const report = await clearSandbox(fakeQbo(sample()));
    expect(report.leftovers.records).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ entity: "Customer" })])
    );
    expect(tables.Customer.every((c) => c.Active === false)).toBe(true);
    expect(tables.Item.every((i) => i.Active === false)).toBe(true);
    // Each tree level is its own batch call, child first: never a parent and its child together.
    const batches = qbo.calls.filter(([op]) => op === "batch").map(([, ids]) => ids);
    const at = (id) => batches.findIndex((ids) => ids.includes(id));
    expect(at("update:Customer:41")).toBeLessThan(at("update:Customer:40"));
    expect(at("update:Item:11")).toBeLessThan(at("update:Item:10"));
  });

  it("keeps parents and children in separate calls even past one batch chunk", async () => {
    const tables = sample();
    tables.Customer = [
      { Id: "1", SyncToken: "0", DisplayName: "Parent", Active: true },
      ...Array.from({ length: 40 }, (_, i) => ({
        Id: String(100 + i),
        SyncToken: "0",
        DisplayName: `Child ${i}`,
        Active: true,
        ParentRef: { value: "1" }
      }))
    ];
    const qbo = fakeQbo(tables);
    const report = await clearSandbox(qbo);
    expect(tables.Customer.every((c) => c.Active === false)).toBe(true);
    expect(report.inactivatedByEntity.Customer).toBe(41);
  });

  it("keeps QuickBooks' own accounts and reports refused inactivations as leftovers, not failures", async () => {
    const tables = sample();
    const qbo = fakeQbo(tables, {
      refuse: {
        "update:Term:50":
          "This term can't be deleted because it is used as the default for Cal Telephone",
        "update:PaymentMethod:60":
          "Business Validation Error: You can't edit the cash payment method."
      }
    });
    const report = await clearSandbox(qbo);
    const account = (id) => tables.Account.find((a) => a.Id === id);
    expect(account("70").Active).toBe(false);
    expect(account("71").Active).toBe(true);
    expect(account("72").Active).toBe(true);
    expect(tables.Term.find((t) => t.Id === "51").Active).toBe(false);
    expect(report.leftovers.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entity: "Term", id: "50", reason: "quickbooks-refused" }),
        expect.objectContaining({ entity: "PaymentMethod", id: "60", reason: "quickbooks-refused" })
      ])
    );
    expect(report.failures).toEqual([]);
    expect(report.inactivatedByEntity).toMatchObject({
      Term: 1,
      PaymentMethod: 0,
      Account: 1,
      Customer: 2
    });
  });

  it("deletes every recurring template, past the first page", async () => {
    const tables = sample();
    tables.RecurringTransaction = Array.from({ length: 1003 }, (_, i) => ({
      Invoice: { Id: String(5000 + i), SyncToken: "0" }
    }));
    const report = await clearSandbox(fakeQbo(tables));
    expect(report.deletedByEntity.RecurringTransaction).toBe(1003);
    expect(tables.RecurringTransaction).toEqual([]);
  });

  it("keeps a failed request a failure, never a leftover", async () => {
    const tables = sample();
    const qbo = fakeQbo(tables);
    const batch = qbo.batch;
    qbo.batch = async (items) => {
      if (items.some((i) => i.Customer)) throw new Error("Request failed with status code 503");
      return batch(items);
    };
    const report = await clearSandbox(qbo);
    expect(report.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entity: "Customer",
          message: "Request failed with status code 503"
        })
      ])
    );
    expect(report.leftovers.records.some((r) => r.entity === "Customer")).toBe(false);
  });

  it("keeps a failed request while zeroing a starting quantity a failure", async () => {
    const tables = sample();
    const qbo = fakeQbo(tables, {
      refuse: { "update:InventoryAdjustment:30": "Request failed with status code 503" }
    });
    const report = await clearSandbox(qbo);
    expect(report.failures).toContainEqual({
      entity: "InventoryAdjustment",
      id: "30",
      message: "Request failed with status code 503"
    });
    expect(report.leftovers.records.some((r) => r.id === "30")).toBe(false);
  });

  it("reports other refusals as failures", async () => {
    const tables = sample();
    const qbo = fakeQbo(tables, { refuse: { "delete:Invoice:1": "Object Not Found" } });
    const report = await clearSandbox(qbo);
    expect(report.failures).toContainEqual({
      entity: "Invoice",
      id: "1",
      message: "Object Not Found"
    });
  });

  it("sends Name with sparse updates of terms and payment methods", async () => {
    const tables = sample();
    const qbo = fakeQbo(tables);
    const seen = [];
    const update = qbo.update;
    qbo.update = (endpoint, payload) => {
      seen.push([endpoint, payload]);
      return update(endpoint, payload);
    };
    await clearSandbox(qbo);
    expect(seen.find(([e]) => e === "term")[1]).toMatchObject({
      Name: "Net 30",
      sparse: true,
      Active: false
    });
  });

  it("reports plain-English progress once per step", async () => {
    const events = [];
    await clearSandbox(fakeQbo(sample()), { emit: (e) => events.push(e) });
    expect(events.map((e) => e.message)).toEqual(
      expect.arrayContaining([
        "Removing invoices",
        "Removing recurring templates",
        "Making customers inactive",
        "Making accounts inactive"
      ])
    );
    expect(events.at(-1).step).toBe(events.at(-1).totalSteps);
  });

  it("stops before the next step once the signal aborts", async () => {
    const controller = new AbortController();
    const tables = sample();
    const qbo = fakeQbo(tables);
    await expect(
      clearSandbox(qbo, {
        signal: controller.signal,
        emit: (e) => {
          if (e.message === "Removing invoices") controller.abort();
        }
      })
    ).rejects.toThrow(/cancelled/);
    expect(tables.Customer.every((c) => c.Active)).toBe(true);
  });
});
