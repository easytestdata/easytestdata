import { describe, expect, it } from "vitest";
import { recordTypeLabel } from "../src/record-labels.js";
import { PURGE_TARGETS } from "../src/purge-service.js";

describe("recordTypeLabel", () => {
  it("names QuickBooks record types in plain English", () => {
    expect(recordTypeLabel("BillPayment")).toBe("bill payments");
    expect(recordTypeLabel("JournalEntry")).toBe("journal entries");
  });

  it("has a plain name for every record type a purge walks through", () => {
    for (const { queryName } of PURGE_TARGETS) {
      expect(recordTypeLabel(queryName)).not.toBe(queryName);
    }
  });

  it("passes an unknown name through unchanged", () => {
    expect(recordTypeLabel("Mystery")).toBe("Mystery");
  });
});
