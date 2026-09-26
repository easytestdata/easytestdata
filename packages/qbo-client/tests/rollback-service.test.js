import { describe, it, expect, vi } from "vitest";
import { rollbackLoad } from "../src/rollback-service.js";
import { LoadLedger } from "../src/load-ledger.js";

/**
 * Create a mock QBO client that simulates queryAll (which calls client.query())
 * and batchDelete (which calls client.batch()).
 *
 * queryAll sends a SQL string like "select * from Invoice startposition 1 maxresults 500"
 * and expects { QueryResponse: { Invoice: [...] } }.
 *
 * entityData maps entity names (e.g. "Invoice") to arrays of { Id, SyncToken }.
 */
function createMockClient(entityData = {}) {
  return {
    batch: vi.fn(async (requests) => {
      return {
        BatchItemResponse: requests.map((r) => {
          const entityKey = Object.keys(r).find((k) => k !== "bId" && k !== "operation");
          return {
            bId: r.bId,
            [entityKey]: { Id: r[entityKey]?.Id || "1", status: "Deleted" }
          };
        })
      };
    }),
    query: vi.fn(async (sql) => {
      // Extract entity name from "select * from EntityName ..."
      const match = sql.match(/from\s+(\w+)/i);
      const entityName = match?.[1];
      const data = entityData[entityName] || [];
      return { QueryResponse: { [entityName]: data } };
    })
  };
}

describe("rollbackLoad", () => {
  it("deletes entities in reverse dependency order", async () => {
    const ledger = new LoadLedger();
    ledger.recordBatchResults("invoice", {
      results: [{ entity: { Id: "inv1", SyncToken: "0" } }]
    });
    ledger.recordBatchResults("payment", {
      results: [{ entity: { Id: "pmt1", SyncToken: "0" } }]
    });
    ledger.recordBatchResults("deposit", {
      results: [{ entity: { Id: "dep1", SyncToken: "0" } }]
    });

    const callOrder = [];
    const client = {
      batch: vi.fn(async (requests) => {
        const entityKey = Object.keys(requests[0]).find((k) => k !== "bId" && k !== "operation");
        callOrder.push(entityKey);
        return {
          BatchItemResponse: requests.map((r) => ({
            bId: r.bId,
            [entityKey]: { Id: r[entityKey]?.Id || "1", status: "Deleted" }
          }))
        };
      }),
      query: vi.fn(async (sql) => {
        const match = sql.match(/from\s+(\w+)/i);
        const entityName = match?.[1];
        // Return matching entities so they're found for deletion
        const dataMap = {
          Deposit: [{ Id: "dep1", SyncToken: "1" }],
          Payment: [{ Id: "pmt1", SyncToken: "1" }],
          Invoice: [{ Id: "inv1", SyncToken: "1" }]
        };
        return { QueryResponse: { [entityName]: dataMap[entityName] || [] } };
      })
    };

    const report = await rollbackLoad(client, ledger.toJSON());

    // Should delete in order: deposit -> payment -> invoice
    expect(callOrder).toEqual(["Deposit", "Payment", "Invoice"]);
    expect(report.totalDeleted).toBe(3);
  });

  it("handles empty ledger gracefully", async () => {
    const ledger = new LoadLedger();
    const client = createMockClient();

    const report = await rollbackLoad(client, ledger.toJSON());
    expect(report.totalDeleted).toBe(0);
    expect(report.failures).toHaveLength(0);
  });

  it("reports progress via emit callback", async () => {
    const ledger = new LoadLedger();
    ledger.recordBatchResults("invoice", {
      results: [{ entity: { Id: "1", SyncToken: "0" } }]
    });

    const client = createMockClient({
      Invoice: [{ Id: "1", SyncToken: "1" }]
    });

    const events = [];
    await rollbackLoad(client, ledger.toJSON(), (e) => events.push(e));

    expect(events.length).toBeGreaterThan(0);
    expect(events[0]).toHaveProperty("step");
    expect(events[0]).toHaveProperty("totalSteps");
    expect(events[0]).toHaveProperty("message");
  });

  it("respects abort signal", async () => {
    const ledger = new LoadLedger();
    ledger.recordBatchResults("invoice", {
      results: [{ entity: { Id: "1", SyncToken: "0" } }]
    });

    const controller = new AbortController();
    controller.abort();

    const client = createMockClient();
    await expect(
      rollbackLoad(client, ledger.toJSON(), () => {}, controller.signal)
    ).rejects.toThrow("Rollback cancelled");
  });
});

describe("rollbackLoad master data", () => {
  /** A client whose queries return `active` (entity name -> rows) and records every batch. */
  function recordingClient(active, { failIds = [] } = {}) {
    const calls = [];
    return {
      calls,
      batch: vi.fn(async (requests) => {
        const entityKey = Object.keys(requests[0]).find((k) => k !== "bId" && k !== "operation");
        calls.push({ operation: requests[0].operation, entityKey, requests });
        return {
          BatchItemResponse: requests.map((r) =>
            failIds.includes(r[entityKey].Id)
              ? { bId: r.bId, Fault: { Error: [{ Message: "Object is in use" }] } }
              : { bId: r.bId, [entityKey]: { Id: r[entityKey].Id } }
          )
        };
      }),
      query: vi.fn(async (sql) => {
        const entityName = sql.match(/from\s+(\w+)/i)?.[1];
        return { QueryResponse: { [entityName]: active[entityName] || [] } };
      })
    };
  }

  function ledgerWith(entries) {
    const ledger = new LoadLedger();
    for (const [type, ids] of Object.entries(entries)) {
      ledger.recordBatchResults(type, {
        results: ids.map((Id) => ({ entity: { Id, SyncToken: "0" } }))
      });
    }
    return ledger.toJSON();
  }

  it("inactivates the parties and items a load created, after deleting its transactions, and keeps accounts", async () => {
    const client = recordingClient({
      Invoice: [{ Id: "inv1", SyncToken: "1" }],
      Item: [{ Id: "it1", SyncToken: "2" }],
      Employee: [{ Id: "em1", SyncToken: "0" }],
      Vendor: [{ Id: "ve1", SyncToken: "0" }],
      Customer: [{ Id: "cu1", SyncToken: "3" }],
      Account: [{ Id: "ac1", SyncToken: "0" }]
    });
    const ledger = ledgerWith({
      account: ["ac1"],
      customer: ["cu1"],
      vendor: ["ve1"],
      employee: ["em1"],
      item: ["it1"],
      invoice: ["inv1"]
    });

    const report = await rollbackLoad(client, ledger);

    expect(client.calls.map((c) => `${c.operation} ${c.entityKey}`)).toEqual([
      "delete Invoice",
      "update Item",
      "update Employee",
      "update Vendor",
      "update Customer"
    ]);
    // Sparse updates with the fresh SyncToken, like purge's inactivation.
    expect(client.calls[1].requests[0].Item).toEqual({
      Id: "it1",
      SyncToken: "2",
      sparse: true,
      Active: false
    });
    expect(report.totalDeleted).toBe(1);
    expect(report.inactivatedByEntity).toEqual({
      item: 1,
      employee: 1,
      vendor: 1,
      customer: 1
    });
    expect(report.totalInactivated).toBe(4);
    // QuickBooks may refuse to inactivate an account (a balance, an item posting to it), which
    // would make the rollback fail on every retry: accounts stay, as Remove test data leaves them.
    expect(report.keptMasterData).toBe(1);
    expect(report.note).toBe(
      'QuickBooks accounts are left in place, as "Remove test data" does (1 kept).'
    );
    expect(report.failures).toEqual([]);
  });

  it("keeps master data when asked (a later load may use it) and still deletes transactions", async () => {
    const client = recordingClient({
      Invoice: [{ Id: "inv1", SyncToken: "1" }],
      Customer: [{ Id: "cu1", SyncToken: "0" }],
      Account: [{ Id: "ac1", SyncToken: "0" }]
    });
    const ledger = ledgerWith({ account: ["ac1"], customer: ["cu1", "cu2"], invoice: ["inv1"] });

    const report = await rollbackLoad(client, ledger, () => {}, null, { keepMasterData: true });

    expect(client.calls.map((c) => `${c.operation} ${c.entityKey}`)).toEqual(["delete Invoice"]);
    expect(report.totalDeleted).toBe(1);
    expect(report.totalInactivated).toBe(0);
    expect(report.keptMasterData).toBe(3);
    expect(report.note).toBe(
      'Kept 2 master records because a later load may use them; use "Remove test data" to remove all generated data. ' +
        'QuickBooks accounts are left in place, as "Remove test data" does (1 kept).'
    );
    expect(report.failures).toEqual([]);
  });

  it("rolls back a load whose ledger holds only accounts, touching nothing and saying so", async () => {
    const client = recordingClient({ Account: [{ Id: "ac1", SyncToken: "0" }] });
    const report = await rollbackLoad(client, ledgerWith({ account: ["ac1", "ac2"] }));

    expect(client.calls).toEqual([]);
    expect(report).toMatchObject({
      totalDeleted: 0,
      totalInactivated: 0,
      keptMasterData: 2,
      failures: [],
      note: 'QuickBooks accounts are left in place, as "Remove test data" does (2 kept).'
    });
  });

  it("skips master records that are already inactive (a retried rollback)", async () => {
    const client = recordingClient({ Customer: [{ Id: "cu2", SyncToken: "0" }] });
    const report = await rollbackLoad(client, ledgerWith({ customer: ["cu1", "cu2"] }));

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].requests.map((r) => r.Customer.Id)).toEqual(["cu2"]);
    expect(report.inactivatedByEntity.customer).toBe(1);
  });

  it("reports master records it could not inactivate as failures", async () => {
    const client = recordingClient(
      { Vendor: [{ Id: "ve1", SyncToken: "0" }] },
      { failIds: ["ve1"] }
    );
    const report = await rollbackLoad(client, ledgerWith({ vendor: ["ve1"] }));

    expect(report.totalInactivated).toBe(0);
    expect(report.failures).toEqual([
      expect.objectContaining({ entity: "Vendor", id: "ve1", message: "Object is in use" })
    ]);
  });
});
