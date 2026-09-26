import { beforeEach, describe, expect, it, vi } from "vitest";
import axios from "axios";
import { generate } from "@easytestdata/core";
import { QboClient, QBO_SANDBOX_BASE_URL, assertSandboxBaseUrl } from "../src/qbo-client.js";
import { MASTER_DATA_TAG_FIELDS, tagMatches } from "../src/qbo-repository.js";
import { customerPayload, vendorPayload, employeePayload } from "../src/load-service.js";
import { purgeTransactions } from "../src/purge-service.js";

vi.mock("axios", () => ({
  default: {
    post: vi.fn(),
    request: vi.fn()
  }
}));

const baseCfg = {
  qboAccessToken: "token",
  qboRealmId: "123"
};

describe("sandbox-only guard", () => {
  beforeEach(() => vi.clearAllMocks());

  it("defaults to the sandbox host", async () => {
    axios.request.mockResolvedValueOnce({ data: {} });
    const client = new QboClient(baseCfg);
    expect(client.baseUrl).toBe(QBO_SANDBOX_BASE_URL);
    await client.query("select * from Customer");
    expect(axios.request.mock.calls[0][0].url).toBe(
      "https://sandbox-quickbooks.api.intuit.com/v3/company/123/query"
    );
  });

  it("accepts the sandbox host with a trailing slash", () => {
    const client = new QboClient({ ...baseCfg, qboBaseUrl: `${QBO_SANDBOX_BASE_URL}/` });
    expect(client.baseUrl).toBe(QBO_SANDBOX_BASE_URL);
  });

  it.each([
    "https://quickbooks.api.intuit.com",
    "http://sandbox-quickbooks.api.intuit.com",
    "https://sandbox-quickbooks.api.intuit.com.evil.example",
    "https://example.com",
    ""
  ])("refuses %s", (url) => {
    expect(() => new QboClient({ ...baseCfg, qboBaseUrl: url })).toThrow(/sandbox/);
    expect(() => assertSandboxBaseUrl(url)).toThrow(/Refusing QBO API base URL/);
  });

  it("re-checks the host on every request", async () => {
    const client = new QboClient(baseCfg);
    client.baseUrl = "https://quickbooks.api.intuit.com";
    await expect(client.query("select * from Customer")).rejects.toThrow(/sandbox/);
    expect(axios.request).not.toHaveBeenCalled();
  });
});

describe("generated master data is identified by tag field, not name", () => {
  const plan = generate({ startDate: "2025-01-01", months: 3, seed: 3, tag: "EZTD" });

  it("load payloads put the tag in the field purge reads", () => {
    const cases = [
      ["Customer", customerPayload(plan.customers[0], plan.tag)],
      ["Vendor", vendorPayload(plan.vendors[0], plan.tag)],
      ["Vendor", vendorPayload(plan.payrollVendor, plan.tag)],
      ["Employee", employeePayload(plan.employees[0], plan.tag)]
    ];
    for (const [entity, payload] of cases) {
      expect(tagMatches(payload[MASTER_DATA_TAG_FIELDS[entity]], "EZTD")).toBe(true);
      expect(tagMatches(payload.DisplayName, "EZTD")).toBe(false);
    }
    const customer = customerPayload(plan.customers[0], plan.tag);
    expect(customer.BillAddr.Line1).toBe(plan.customers[0].address.line1);
    expect(customer.BillAddr.Country).toBe("US");
  });

  it("purge --mode generated inactivates tagged records only", async () => {
    const rows = {
      Customer: [
        {
          Id: "1",
          SyncToken: "0",
          DisplayName: "Reyes Architects",
          Notes: "EZTD-CUST-001",
          Active: true
        },
        {
          Id: "2",
          SyncToken: "0",
          DisplayName: "EZTD lookalike",
          Notes: "real client",
          Active: true
        },
        { Id: "3", SyncToken: "0", DisplayName: "Other", Notes: "EZTDX-CUST-001", Active: true }
      ],
      Vendor: [
        {
          Id: "4",
          SyncToken: "0",
          DisplayName: "Chen Telecom",
          AcctNum: "EZTD-VEND-001",
          Active: true
        },
        { Id: "5", SyncToken: "0", DisplayName: "Real Vendor", AcctNum: "12345", Active: true }
      ],
      Employee: [
        {
          Id: "6",
          SyncToken: "0",
          DisplayName: "Priya Foster",
          EmployeeNumber: "EZTD-EMP-001",
          Active: true
        },
        // No EmployeeNumber, the tag only in its name: the user's, kept.
        { Id: "7", SyncToken: "0", DisplayName: "EZTD Bob 02", Active: true },
        {
          Id: "12",
          SyncToken: "0",
          DisplayName: "EZTD Carol 03",
          EmployeeNumber: "E-7",
          Active: true
        },
        // A user's employee whose name only starts with the tag: kept.
        { Id: "13", SyncToken: "0", DisplayName: "EZTD Mary Ann 01", Active: true }
      ],
      Item: [
        { Id: "8", SyncToken: "0", Name: "EZTD-Consulting", Description: "EZTD", Active: true },
        { Id: "9", SyncToken: "0", Name: "Hours", Description: "Hourly work", Active: true }
      ],
      Invoice: [
        { Id: "10", SyncToken: "0", DocNumber: "EZTD-INV-0001", TxnDate: "2025-01-02" },
        { Id: "11", SyncToken: "0", DocNumber: "1001", TxnDate: "2025-01-02" }
      ]
    };
    const batches = [];
    const client = {
      query: vi.fn(async (sql) => {
        const entity = /from\s+(\w+)/i.exec(sql)[1];
        return { QueryResponse: { [entity]: rows[entity] || [] } };
      }),
      batch: vi.fn(async (requests) => {
        batches.push(requests);
        return {
          BatchItemResponse: requests.map((r) => {
            const key = Object.keys(r).find((k) => k !== "bId" && k !== "operation");
            return { bId: r.bId, [key]: { Id: r[key].Id } };
          })
        };
      })
    };

    const report = await purgeTransactions(client, { mode: "generated", tag: "EZTD" });

    const touched = batches.flat().map((r) => {
      const key = Object.keys(r).find((k) => k !== "bId" && k !== "operation");
      return r[key].Id;
    });
    expect(touched.sort()).toEqual(["1", "10", "4", "6", "8"].sort());
    expect(report.masterData).toEqual({
      customersInactivated: 1,
      vendorsInactivated: 1,
      itemsInactivated: 1,
      employeesInactivated: 1
    });
    expect(report.deletedByEntity.Invoice).toBe(1);
  });

  // A refused inactivation counts as a failure: otherwise a purge that left an active customer
  // would report failureCount 0 and the app would show a clean success.
  it("counts a customer QuickBooks refused to make inactive as a purge failure", async () => {
    const rows = {
      Customer: [{ Id: "1", SyncToken: "0", DisplayName: "Busy Customer", Active: true }]
    };
    const client = {
      query: vi.fn(async (sql) => {
        const entity = /from\s+(\w+)/i.exec(sql)[1];
        return { QueryResponse: { [entity]: rows[entity] || [] } };
      }),
      batch: vi.fn(async (requests) => ({
        BatchItemResponse: requests.map((r) => ({
          bId: r.bId,
          Fault: { Error: [{ Message: "Customer has an open balance" }] }
        }))
      }))
    };

    const report = await purgeTransactions(client, { mode: "all" });

    expect(report.masterData.customersInactivated).toBe(0);
    expect(report.failureCount).toBe(1);
    expect(report.failures).toContainEqual(
      expect.objectContaining({
        entity: "Customer",
        id: "1",
        message: "Customer has an open balance"
      })
    );
  });

  it("rejects unknown purge modes", async () => {
    await expect(purgeTransactions({}, { mode: "everything" })).rejects.toThrow(
      /Unknown purge mode/
    );
  });
});
