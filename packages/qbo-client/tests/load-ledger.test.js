import { describe, it, expect } from "vitest";
import { LoadLedger } from "../src/load-ledger.js";

describe("LoadLedger", () => {
  it("records batch results", () => {
    const ledger = new LoadLedger();
    ledger.recordBatchResults("invoice", {
      results: [{ entity: { Id: "1", SyncToken: "0" } }, { entity: { Id: "2", SyncToken: "1" } }]
    });
    expect(ledger.totalTracked).toBe(2);
    expect(ledger.entities.get("invoice")).toHaveLength(2);
  });

  it("accumulates results for same entity type", () => {
    const ledger = new LoadLedger();
    ledger.recordBatchResults("purchase", {
      results: [{ entity: { Id: "1", SyncToken: "0" } }]
    });
    ledger.recordBatchResults("purchase", {
      results: [{ entity: { Id: "2", SyncToken: "0" } }]
    });
    expect(ledger.entities.get("purchase")).toHaveLength(2);
  });

  it("handles empty/null batch results", () => {
    const ledger = new LoadLedger();
    ledger.recordBatchResults("invoice", null);
    ledger.recordBatchResults("invoice", { results: null });
    ledger.recordBatchResults("invoice", { results: [] });
    expect(ledger.totalTracked).toBe(0);
  });

  it("skips entities without Id", () => {
    const ledger = new LoadLedger();
    ledger.recordBatchResults("invoice", {
      results: [{ entity: {} }, { entity: { Id: "1", SyncToken: "0" } }]
    });
    expect(ledger.totalTracked).toBe(1);
  });

  it("serialization round-trip preserves data", () => {
    const ledger = new LoadLedger();
    ledger.recordBatchResults("invoice", {
      results: [{ entity: { Id: "10", SyncToken: "2" } }]
    });
    ledger.recordBatchResults("bill", {
      results: [{ entity: { Id: "20", SyncToken: "0" } }]
    });
    ledger.markFailed(5, "QBO rate limit");

    const json = ledger.toJSON();
    const restored = LoadLedger.fromJSON(json);

    expect(restored.totalTracked).toBe(2);
    expect(restored.failedAtPhase).toBe(5);
    expect(restored.failedError).toBe("QBO rate limit");
    expect(restored.entities.get("invoice")).toEqual([{ Id: "10", SyncToken: "2" }]);
    expect(restored.entities.get("bill")).toEqual([{ Id: "20", SyncToken: "0" }]);
  });

  it("getCleanupManifest returns reverse dependency order", () => {
    const ledger = new LoadLedger();
    // Add in forward order
    ledger.recordBatchResults("estimate", {
      results: [{ entity: { Id: "1", SyncToken: "0" } }]
    });
    ledger.recordBatchResults("invoice", {
      results: [{ entity: { Id: "2", SyncToken: "0" } }]
    });
    ledger.recordBatchResults("payment", {
      results: [{ entity: { Id: "3", SyncToken: "0" } }]
    });
    ledger.recordBatchResults("deposit", {
      results: [{ entity: { Id: "4", SyncToken: "0" } }]
    });
    ledger.recordBatchResults("journalentry", {
      results: [{ entity: { Id: "5", SyncToken: "0" } }]
    });

    const manifest = ledger.getCleanupManifest();
    const order = manifest.map((m) => m.entityType);

    // Journal entries should come before deposits, deposits before payments, etc.
    expect(order.indexOf("journalentry")).toBeLessThan(order.indexOf("deposit"));
    expect(order.indexOf("deposit")).toBeLessThan(order.indexOf("payment"));
    expect(order.indexOf("payment")).toBeLessThan(order.indexOf("invoice"));
    expect(order.indexOf("invoice")).toBeLessThan(order.indexOf("estimate"));
  });

  it("getCleanupManifest skips empty entity types", () => {
    const ledger = new LoadLedger();
    ledger.recordBatchResults("invoice", {
      results: [{ entity: { Id: "1", SyncToken: "0" } }]
    });
    const manifest = ledger.getCleanupManifest();
    expect(manifest).toHaveLength(1);
    expect(manifest[0].entityType).toBe("invoice");
  });

  it("fromJSON handles null/undefined", () => {
    const restored = LoadLedger.fromJSON(null);
    expect(restored.totalTracked).toBe(0);
    expect(restored.failedAtPhase).toBeNull();
  });

  it("markFailed sets phase and error", () => {
    const ledger = new LoadLedger();
    ledger.markFailed(8, "Connection timeout");
    expect(ledger.failedAtPhase).toBe(8);
    expect(ledger.failedError).toBe("Connection timeout");
  });
});
