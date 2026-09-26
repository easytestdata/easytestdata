import { describe, expect, it, vi } from "vitest";
import { generate } from "@easytestdata/core";
import { batchCreate, batchDelete } from "../src/batch-helper.js";
import { loadPlanIntoQbo } from "../src/load-service.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A QBO stand-in: every query finds nothing (so the load creates everything), every batch
 * create answers with fresh Ids. `delayFor(request)` can slow individual batches down.
 */
function fakeQbo({ delayFor = () => 0 } = {}) {
  let nextId = 1;
  const batches = [];
  const client = {
    query: async () => ({ QueryResponse: {} }),
    update: async (entity, payload) => ({ [entity]: payload }),
    batch: vi.fn(async (request) => {
      const record = { at: Date.now(), request };
      batches.push(record);
      await sleep(delayFor(request));
      record.answeredAt = Date.now();
      return {
        BatchItemResponse: request.map((item) => {
          const [entityKey] = Object.keys(item).filter((k) => !["bId", "operation"].includes(k));
          return { bId: item.bId, [entityKey]: { Id: String(nextId++), SyncToken: "0" } };
        })
      };
    })
  };
  return { client, batches };
}

const entityOf = (request) =>
  Object.keys(request[0]).find((k) => !["bId", "operation"].includes(k));

describe("batchCreate under abort", () => {
  it("keeps every batch that answered, drains in-flight batches and starts no new ones", async () => {
    // 90 items = 3 batches, 2 in flight at a time. Abort while batches 1 and 2 are in flight:
    // both must be drained (their records exist in QBO) and batch 3 must never be sent.
    const controller = new AbortController();
    const { client, batches } = fakeQbo({
      delayFor: (request) => (request[0].bId === "0" ? 20 : 40)
    });
    const items = Array.from({ length: 90 }, (_, i) => ({
      payload: { n: i },
      originalIndex: i,
      ref: `INV-${i}`
    }));
    const created = [];
    setTimeout(() => controller.abort(), 10);

    let error;
    try {
      await batchCreate(client, "invoice", items, {
        signal: controller.signal,
        entityLabel: "Invoice",
        onCreated: (results) => created.push(...results)
      });
    } catch (err) {
      error = err;
    }

    expect(error.message).toMatch(/cancelled/);
    expect(batches).toHaveLength(2);
    expect(batches.every((b) => b.answeredAt)).toBe(true); // drained, not abandoned
    expect(error.partial.count).toBe(60);
    expect(error.partial.results.map((r) => r.originalIndex)).toEqual(
      Array.from({ length: 60 }, (_, i) => i)
    );
    expect(created).toHaveLength(60); // incremental hook saw both batches
  });

  it("completes normally and reports each batch as it lands when not aborted", async () => {
    const { client } = fakeQbo();
    const items = Array.from({ length: 45 }, (_, i) => ({ payload: {}, originalIndex: i }));
    const seen = [];
    const result = await batchCreate(client, "bill", items, {
      onCreated: (results) => seen.push(results.length)
    });
    expect(result.count).toBe(45);
    expect(seen.sort()).toEqual([15, 30]);
  });

  it("batchDelete drains too and reports what it deleted", async () => {
    const controller = new AbortController();
    const { client, batches } = fakeQbo({ delayFor: () => 20 });
    const rows = Array.from({ length: 90 }, (_, i) => ({ Id: String(i), SyncToken: "0" }));
    setTimeout(() => controller.abort(), 5);
    await expect(
      batchDelete(client, "invoice", rows, { signal: controller.signal })
    ).rejects.toMatchObject({ message: /cancelled/, partial: { deletedCount: 60 } });
    expect(batches).toHaveLength(2);
  });
});

describe("loadPlanIntoQbo under abort", () => {
  it("returns a ledger covering every record created before and while stopping", async () => {
    const plan = generate({
      template: "saas",
      startDate: "2025-01-01",
      months: 6,
      customerCount: 40,
      seed: 7
    });
    const controller = new AbortController();
    const { client, batches } = fakeQbo({
      // Phase 5 runs invoices and bills in parallel; slow the invoice batches so the abort
      // lands while invoices are still being created and bills are in flight.
      delayFor: (request) => (entityOf(request) === "Invoice" ? 25 : 5)
    });
    let phase5Started = false;
    const emit = ({ step }) => {
      if (step === 5 && !phase5Started) {
        phase5Started = true;
        setTimeout(() => controller.abort(), 30);
      }
    };

    let error;
    try {
      await loadPlanIntoQbo(client, plan, null, emit, controller.signal);
    } catch (err) {
      error = err;
    }

    expect(error).toBeDefined();
    expect(error.message).toMatch(/cancelled/);
    // Everything QBO answered for is in the ledger, invoice batches included, and nothing was
    // created after the load reported its failure.
    const answered = batches.filter((b) => b.answeredAt);
    expect(answered).toHaveLength(batches.length);
    const createdIds = (entity) =>
      new Set(
        batches
          .filter((b) => entityOf(b.request) === entity)
          .flatMap((b) => b.request.map((_, i) => i))
      );
    const ledger = error.ledger;
    expect(ledger.failedError).toMatch(/cancelled/);
    expect(ledger.entries.invoice.length).toBeGreaterThan(0);
    expect(ledger.entries.invoice.length).toBe(
      batches
        .filter((b) => entityOf(b.request) === "Invoice")
        .reduce((n, b) => n + b.request.length, 0)
    );
    if (createdIds("Bill").size > 0) {
      expect(ledger.entries.bill.length).toBe(
        batches
          .filter((b) => entityOf(b.request) === "Bill")
          .reduce((n, b) => n + b.request.length, 0)
      );
    }
    expect(ledger.totalTracked).toBe(
      Object.values(ledger.entries).reduce((n, list) => n + list.length, 0)
    );
    // Later phases never ran.
    expect(batches.some((b) => entityOf(b.request) === "Payment")).toBe(false);
    const batchCountAtFailure = batches.length;
    await sleep(60);
    expect(batches).toHaveLength(batchCountAtFailure);
  });
});

describe("loadPlanIntoQbo master data in the ledger", () => {
  const countSent = (batches, entity) =>
    batches.filter((b) => entityOf(b.request) === entity).reduce((n, b) => n + b.request.length, 0);

  it("records accounts and customer batches drained by an abort during master data", async () => {
    const plan = generate({
      template: "saas",
      startDate: "2025-01-01",
      months: 6,
      customerCount: 40,
      seed: 7
    });
    const controller = new AbortController();
    const { client, batches } = fakeQbo({
      delayFor: (request) => (entityOf(request) === "Customer" ? 30 : 0)
    });
    let phase2Started = false;
    const emit = ({ step }) => {
      if (step === 2 && !phase2Started) {
        phase2Started = true;
        setTimeout(() => controller.abort(), 10);
      }
    };

    let error;
    try {
      await loadPlanIntoQbo(client, plan, null, emit, controller.signal);
    } catch (err) {
      error = err;
    }

    expect(error?.message).toMatch(/cancelled/);
    const ledger = error.ledger;
    expect(countSent(batches, "Account")).toBeGreaterThan(0);
    expect(ledger.entries.account).toHaveLength(countSent(batches, "Account"));
    expect(countSent(batches, "Customer")).toBeGreaterThan(0);
    expect(ledger.entries.customer).toHaveLength(countSent(batches, "Customer"));
    expect(ledger.totalTracked).toBe(
      countSent(batches, "Account") + countSent(batches, "Customer")
    );
  });

  it("records every vendor, employee and service item a completed load creates", async () => {
    const plan = generate({
      template: "saas",
      startDate: "2025-01-01",
      months: 2,
      customerCount: 5,
      seed: 3
    });
    const { client, batches } = fakeQbo();

    const result = await loadPlanIntoQbo(client, plan, null);

    for (const [type, entity] of [
      ["account", "Account"],
      ["customer", "Customer"],
      ["vendor", "Vendor"],
      ["employee", "Employee"],
      ["item", "Item"]
    ]) {
      expect(countSent(batches, entity), entity).toBeGreaterThan(0);
      expect(result.ledger.entries[type], entity).toHaveLength(countSent(batches, entity));
    }
  });
});
