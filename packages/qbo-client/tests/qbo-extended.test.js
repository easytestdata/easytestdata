import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import axios from "axios";
import { QboClient } from "../src/qbo-client.js";
import { batchCreate, batchDelete } from "../src/batch-helper.js";
import {
  tagMatches,
  queryAll,
  ensureAccount,
  ensureServiceItem,
  findItemByName
} from "../src/qbo-repository.js";

vi.mock("axios", () => ({
  default: {
    post: vi.fn(),
    request: vi.fn()
  }
}));

function makeClient(overrides = {}) {
  return new QboClient({
    qboClientId: "test-client-id",
    qboClientSecret: "test-client-secret",
    qboAccessToken: "test-access-token",
    qboRefreshToken: "test-refresh-token",
    qboRealmId: "123456789",
    qboBaseUrl: "https://sandbox-quickbooks.api.intuit.com",
    qboMinorVersion: "65",
    ...overrides
  });
}

// ---------------------------------------------------------------------------
// 1. QboClient transient retry (429)
// ---------------------------------------------------------------------------
describe("QboClient transient retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries on 429 and succeeds on 3rd attempt", async () => {
    const error429 = new Error("Too Many Requests");
    error429.response = { status: 429, data: {} };

    axios.request
      .mockRejectedValueOnce(error429)
      .mockRejectedValueOnce(error429)
      .mockResolvedValueOnce({ data: { Invoice: { Id: "42" } } });

    const client = makeClient();

    const resultPromise = client.request("GET", "/query", {
      params: { query: "select * from Invoice" }
    });

    // First retry delay: 1000ms (1000 * 2^0)
    await vi.advanceTimersByTimeAsync(1000);
    // Second retry delay: 2000ms (1000 * 2^1)
    await vi.advanceTimersByTimeAsync(2000);

    const result = await resultPromise;

    expect(result).toEqual({ Invoice: { Id: "42" } });
    expect(axios.request).toHaveBeenCalledTimes(3);
  });

  it.each([500, 503])("retries a GET on %i", async (status) => {
    const err = new Error("Server error");
    err.response = { status, data: {} };
    axios.request.mockRejectedValueOnce(err).mockResolvedValueOnce({ data: { ok: true } });

    const resultPromise = makeClient().query("select * from Invoice");
    await vi.advanceTimersByTimeAsync(1000);

    expect(await resultPromise).toEqual({ ok: true });
    expect(axios.request).toHaveBeenCalledTimes(2);
  });

  // A write QBO may already have committed must never be sent twice: a replayed create or
  // batch would duplicate records and only the last response would reach the load ledger.
  it.each([
    ["create", (c) => c.create("Invoice", { Line: [] })],
    ["batch", (c) => c.batch([{ bId: "1", operation: "create", Invoice: {} }])],
    ["delete", (c) => c.delete("Invoice", "1", "0")]
  ])("does not replay a %s on 500/503", async (_name, call) => {
    for (const status of [500, 503]) {
      axios.request.mockReset();
      const err = new Error("Server error");
      err.response = { status, data: {} };
      axios.request.mockRejectedValueOnce(err).mockResolvedValueOnce({ data: { ok: true } });

      const resultPromise = call(makeClient());
      const settled = resultPromise.then(
        () => "resolved",
        () => "rejected"
      );
      await vi.advanceTimersByTimeAsync(10000);

      expect(await settled).toBe("rejected");
      expect(axios.request).toHaveBeenCalledTimes(1);
    }
    // Drop the never-consumed success so it cannot leak into the next test.
    axios.request.mockReset();
  });

  it("retries a write on 429 (QBO did not process it)", async () => {
    const error429 = new Error("Too Many Requests");
    error429.response = { status: 429, data: {} };
    axios.request
      .mockRejectedValueOnce(error429)
      .mockResolvedValueOnce({ data: { BatchItemResponse: [] } });

    const resultPromise = makeClient().batch([{ bId: "1", operation: "create", Invoice: {} }]);
    await vi.advanceTimersByTimeAsync(1000);

    expect(await resultPromise).toEqual({ BatchItemResponse: [] });
    expect(axios.request).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// 2. QboClient 401 refresh flow
// ---------------------------------------------------------------------------
describe("QboClient 401 refresh flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refreshes token on 401 and retries the request", async () => {
    const error401 = new Error("Unauthorized");
    error401.response = { status: 401, data: {} };

    axios.request
      .mockRejectedValueOnce(error401)
      .mockResolvedValueOnce({ data: { Customer: { Id: "99" } } });

    axios.post.mockResolvedValueOnce({
      data: {
        access_token: "refreshed-access-token",
        refresh_token: "refreshed-refresh-token"
      }
    });

    const client = makeClient();

    const result = await client.request("GET", "/query", {
      params: { query: "select * from Customer" }
    });

    expect(result).toEqual({ Customer: { Id: "99" } });
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(axios.post).toHaveBeenCalledWith(
      "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          "Content-Type": "application/x-www-form-urlencoded"
        })
      })
    );
    expect(client.accessToken).toBe("refreshed-access-token");
    expect(client.refreshToken).toBe("refreshed-refresh-token");
    // Original request + retry after refresh = 2 calls
    expect(axios.request).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// 3. batchCreate chunking
// ---------------------------------------------------------------------------
describe("batchCreate chunking", () => {
  it("splits 35 items into two batch calls (30 + 5)", async () => {
    const mockClient = {
      batch: vi.fn()
    };

    // First call: 30 items
    mockClient.batch.mockResolvedValueOnce({
      BatchItemResponse: Array.from({ length: 30 }, (_, i) => ({
        bId: String(i),
        Invoice: { Id: String(100 + i) }
      }))
    });

    // Second call: 5 items
    mockClient.batch.mockResolvedValueOnce({
      BatchItemResponse: Array.from({ length: 5 }, (_, i) => ({
        bId: String(30 + i),
        Invoice: { Id: String(200 + i) }
      }))
    });

    const items = Array.from({ length: 35 }, (_, i) => ({
      payload: { DocNumber: `INV-${i}` },
      originalIndex: i
    }));

    const result = await batchCreate(mockClient, "invoice", items);

    expect(mockClient.batch).toHaveBeenCalledTimes(2);
    expect(result.count).toBe(35);
    expect(result.results).toHaveLength(35);
    expect(result.failures).toHaveLength(0);

    // Verify first batch had 30 items
    const firstBatchArg = mockClient.batch.mock.calls[0][0];
    expect(firstBatchArg).toHaveLength(30);
    expect(firstBatchArg[0]).toHaveProperty("operation", "create");
    expect(firstBatchArg[0]).toHaveProperty("Invoice");

    // Verify second batch had 5 items
    const secondBatchArg = mockClient.batch.mock.calls[1][0];
    expect(secondBatchArg).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// 4. batchCreate failure accumulation
// ---------------------------------------------------------------------------
describe("batchCreate failure accumulation", () => {
  it("accumulates failures from Fault responses", async () => {
    const mockClient = {
      batch: vi.fn()
    };

    mockClient.batch.mockResolvedValueOnce({
      BatchItemResponse: [
        { bId: "0", Invoice: { Id: "100" } },
        {
          bId: "1",
          Fault: {
            Error: [{ Message: "Duplicate DocNumber", Detail: "INV-001 already exists" }]
          }
        },
        { bId: "2", Invoice: { Id: "102" } },
        {
          bId: "3",
          Fault: {
            Error: [{ Message: "Validation error" }]
          }
        },
        { bId: "4", Invoice: { Id: "104" } }
      ]
    });

    const items = Array.from({ length: 5 }, (_, i) => ({
      payload: { DocNumber: `INV-${i}` },
      originalIndex: i,
      ref: `INV-${i}`
    }));

    const result = await batchCreate(mockClient, "invoice", items);

    expect(result.count).toBe(3);
    expect(result.results).toHaveLength(3);
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0].message).toContain("Duplicate DocNumber");
    expect(result.failures[0].ref).toBe("INV-1");
    expect(result.failures[1].message).toContain("Validation error");
    expect(result.failures[1].ref).toBe("INV-3");
  });
});

// ---------------------------------------------------------------------------
// 5. batchDelete ordering
// ---------------------------------------------------------------------------
describe("batchDelete", () => {
  it("deletes rows and returns correct deletedCount", async () => {
    const mockClient = {
      batch: vi.fn()
    };

    const rows = [
      { Id: "10", SyncToken: "0" },
      { Id: "20", SyncToken: "1" },
      { Id: "30", SyncToken: "2" }
    ];

    mockClient.batch.mockResolvedValueOnce({
      BatchItemResponse: [
        { bId: "0", Invoice: { Id: "10", status: "Deleted" } },
        { bId: "1", Invoice: { Id: "20", status: "Deleted" } },
        { bId: "2", Invoice: { Id: "30", status: "Deleted" } }
      ]
    });

    const result = await batchDelete(mockClient, "invoice", rows);

    expect(result.deletedCount).toBe(3);
    expect(result.failures).toHaveLength(0);
    expect(mockClient.batch).toHaveBeenCalledTimes(1);

    const batchArg = mockClient.batch.mock.calls[0][0];
    expect(batchArg).toHaveLength(3);
    expect(batchArg[0]).toEqual({
      bId: "0",
      operation: "delete",
      Invoice: { Id: "10", SyncToken: "0" }
    });
    expect(batchArg[1]).toEqual({
      bId: "1",
      operation: "delete",
      Invoice: { Id: "20", SyncToken: "1" }
    });
    expect(batchArg[2]).toEqual({
      bId: "2",
      operation: "delete",
      Invoice: { Id: "30", SyncToken: "2" }
    });
  });

  it("accumulates failures from Fault responses during delete", async () => {
    const mockClient = {
      batch: vi.fn()
    };

    const rows = [
      { Id: "10", SyncToken: "0" },
      { Id: "20", SyncToken: "1" }
    ];

    mockClient.batch.mockResolvedValueOnce({
      BatchItemResponse: [
        { bId: "0", Invoice: { Id: "10", status: "Deleted" } },
        {
          bId: "1",
          Fault: {
            Error: [{ Message: "Object Not Found" }]
          }
        }
      ]
    });

    const result = await batchDelete(mockClient, "invoice", rows);

    expect(result.deletedCount).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].id).toBe("20");
    expect(result.failures[0].message).toContain("Object Not Found");
  });
});

// ---------------------------------------------------------------------------
// 6. tagMatches function
// ---------------------------------------------------------------------------
describe("tagMatches", () => {
  it("returns true when value starts with tag", () => {
    expect(tagMatches("EZTD-INV-001", "EZTD")).toBe(true);
  });

  it("returns false when value does not start with tag", () => {
    expect(tagMatches("OTHER-INV", "EZTD")).toBe(false);
  });

  it("returns false for null value", () => {
    expect(tagMatches(null, "EZTD")).toBe(false);
  });

  it("returns false for undefined value", () => {
    expect(tagMatches(undefined, "EZTD")).toBe(false);
  });

  it("matches case-insensitively", () => {
    expect(tagMatches("eztd-test", "EZTD")).toBe(true);
    expect(tagMatches("EZTD-TEST", "eztd")).toBe(true);
    expect(tagMatches("Eztd-Mixed", "EZTD")).toBe(true);
  });

  it("requires the tag to end at a token boundary", () => {
    expect(tagMatches("EZTD", "EZTD")).toBe(true);
    expect(tagMatches("EZTD-CUST-001 (generated by EasyTestData)", "EZTD")).toBe(true);
    expect(tagMatches("EZTD monthly depreciation", "EZTD")).toBe(true);
    expect(tagMatches("EZTDX-INV-001", "EZTD")).toBe(false);
    expect(tagMatches("EZTD1", "EZTD")).toBe(false);
  });

  it("returns false for empty string value", () => {
    expect(tagMatches("", "EZTD")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. queryAll pagination
// ---------------------------------------------------------------------------
describe("queryAll pagination", () => {
  it("fetches all pages until a partial page is returned", async () => {
    const mockClient = {
      query: vi.fn()
    };

    // First page: 500 items (full page, triggers next page)
    mockClient.query.mockResolvedValueOnce({
      QueryResponse: {
        Invoice: Array.from({ length: 500 }, (_, i) => ({ Id: String(i + 1) }))
      }
    });

    // Second page: 200 items (partial page, stops pagination)
    mockClient.query.mockResolvedValueOnce({
      QueryResponse: {
        Invoice: Array.from({ length: 200 }, (_, i) => ({ Id: String(501 + i) }))
      }
    });

    const items = await queryAll(mockClient, "Invoice");

    expect(items).toHaveLength(700);
    expect(items[0].Id).toBe("1");
    expect(items[499].Id).toBe("500");
    expect(items[500].Id).toBe("501");
    expect(items[699].Id).toBe("700");
    expect(mockClient.query).toHaveBeenCalledTimes(2);

    // Verify pagination SQL includes startposition
    const firstCall = mockClient.query.mock.calls[0][0];
    expect(firstCall).toContain("startposition 1");
    expect(firstCall).toContain("maxresults 500");

    const secondCall = mockClient.query.mock.calls[1][0];
    expect(secondCall).toContain("startposition 501");
    expect(secondCall).toContain("maxresults 500");
  });

  it("respects maxPages limit", async () => {
    const mockClient = {
      query: vi.fn()
    };

    // Return full pages both times
    mockClient.query.mockResolvedValueOnce({
      QueryResponse: {
        Invoice: Array.from({ length: 500 }, (_, i) => ({ Id: String(i + 1) }))
      }
    });

    // This should never be called because maxPages=1
    mockClient.query.mockResolvedValueOnce({
      QueryResponse: {
        Invoice: Array.from({ length: 500 }, (_, i) => ({ Id: String(501 + i) }))
      }
    });

    const items = await queryAll(mockClient, "Invoice", "*", "", 1);

    expect(items).toHaveLength(500);
    expect(mockClient.query).toHaveBeenCalledTimes(1);
  });

  it("handles empty result set", async () => {
    const mockClient = {
      query: vi.fn()
    };

    mockClient.query.mockResolvedValueOnce({
      QueryResponse: {}
    });

    const items = await queryAll(mockClient, "Invoice");

    expect(items).toHaveLength(0);
    expect(mockClient.query).toHaveBeenCalledTimes(1);
  });
});

describe("name lookups see inactive records (QBO hides them unless asked)", () => {
  // Answers like QBO: an inactive record comes back only when the query asks for inactive ones.
  function qbo(rows) {
    return {
      query: vi.fn(async (sql) => {
        const entity = sql.match(/from (\w+)/)[1];
        const includeInactive = /Active IN \(true, false\)/.test(sql);
        const found = rows.filter(
          (r) => r.entity === entity && (includeInactive || r.Active !== false)
        );
        return { QueryResponse: found.length ? { [entity]: found } : {} };
      }),
      update: vi.fn(async (entity, payload) => ({ [entity]: payload })),
      create: vi.fn(async () => {
        throw new Error("Duplicate Name Exists Error");
      })
    };
  }

  it("reactivates an inactive account with the same name instead of creating it", async () => {
    const client = qbo([
      { entity: "Account", Id: "7", SyncToken: "2", Name: "EZTD Payroll Taxes", Active: false }
    ]);
    const account = await ensureAccount(client, "EZTD Payroll Taxes", "Expense", "TaxesPaid");
    expect(client.create).not.toHaveBeenCalled();
    expect(client.update).toHaveBeenCalledWith("account", expect.objectContaining({ Id: "7" }));
    expect(account.Id).toBe("7");
  });

  it("reactivates an inactive service item with the same name instead of creating it", async () => {
    const client = qbo([
      {
        entity: "Item",
        Id: "8",
        SyncToken: "1",
        Name: "EZTD-CONSULT",
        Description: "EZTD",
        Active: false
      }
    ]);
    const result = await ensureServiceItem(client, "EZTD-CONSULT", "99", "EZTD");
    expect(client.create).not.toHaveBeenCalled();
    expect(client.update).toHaveBeenCalledWith("item", expect.objectContaining({ Id: "8" }));
    expect(result).toMatchObject({ created: false, reactivated: true });
  });

  it("never reactivates or reuses an untagged item that merely has the same name", async () => {
    const client = qbo([
      {
        entity: "Item",
        Id: "9",
        SyncToken: "1",
        Name: "EZTD-CONSULT",
        Description: "Our own consulting",
        Active: false
      }
    ]);
    await expect(ensureServiceItem(client, "EZTD-CONSULT", "99", "EZTD")).rejects.toThrow(
      /not created by EasyTestData/
    );
    expect(client.update).not.toHaveBeenCalled();
    expect(client.query.mock.calls[0][0]).toContain("Description");
  });
});

describe("name lookups quote the name for QBO's query language", () => {
  // The tag is user input (--tag, the API's `tag`) and is part of account and item names.
  it("escapes an apostrophe (and a backslash) with a backslash", async () => {
    const client = {
      query: vi.fn(async () => ({ QueryResponse: {} })),
      create: vi.fn(async () => ({ Account: { Id: "9" }, Item: { Id: "9" } }))
    };
    await ensureAccount(client, "O'BRIEN Payroll Taxes", "Expense", "TaxesPaid");
    await findItemByName(client, "O'BRIEN\\X-SRV");
    expect(client.query.mock.calls[0][0]).toContain("where Name = 'O\\'BRIEN Payroll Taxes'");
    expect(client.query.mock.calls[1][0]).toContain("where Name = 'O\\'BRIEN\\\\X-SRV'");
  });
});
