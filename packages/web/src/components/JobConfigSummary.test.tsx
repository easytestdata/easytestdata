import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { JobConfigSummary } from "@easytestdata/ui";

describe("JobConfigSummary for a purge", () => {
  afterEach(cleanup);

  // Purge jobs store the mode as config.purgeMode (routes/connections.js); the row read
  // config.mode, which is never set, so it never showed.
  it("says a Remove test data job removes only EasyTestData's records", () => {
    render(<JobConfigSummary config={{ tag: "EZTD", purgeMode: "generated" }} type="purge" />);
    expect(screen.getByText("Removes")).toBeInTheDocument();
    expect(screen.getByText(/^EasyTestData's transactions;/)).toBeInTheDocument();
  });

  // An erase deletes transactions and inactivates lists; it never removes accounts, so the
  // row must not claim the sandbox was emptied.
  it("says an Erase all data job deletes every transaction but keeps accounts", () => {
    render(<JobConfigSummary config={{ tag: "EZTD", purgeMode: "all" }} type="purge" />);
    const row = screen.getByText(/^Every transaction of the types EasyTestData loads, including yours;/);
    expect(row).toHaveTextContent("accounts kept");
  });
});
