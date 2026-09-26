import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { JobResultSummaryView } from "@easytestdata/ui";

describe("JobResultSummaryView for a rollback", () => {
  afterEach(cleanup);

  it("says why master data was kept (a later load may use it)", () => {
    const note =
      'Kept 4 master records because a later load may use them; use "Remove test data" to remove all generated data.';
    render(
      <JobResultSummaryView
        result={{ totalDeleted: 3, totalInactivated: 0, note }}
        type="rollback"
      />
    );
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText(note)).toBeInTheDocument();
  });
});

// Load and download results carry core's plan metrics (totalRevenueGenerated, ...); the view read
// revenue/expenses/ebitda, which no result has, so the money cards never showed.
describe("JobResultSummaryView for a load", () => {
  afterEach(cleanup);

  it("shows the revenue, expenses and profit the plan generated", () => {
    render(
      <JobResultSummaryView
        result={{
          metrics: {
            totalRevenueGenerated: 500000,
            totalExpensesGenerated: 400000,
            ebitdaGenerated: 100000
          }
        }}
        type="load"
      />
    );
    expect(screen.getByText("Revenue")).toBeInTheDocument();
    expect(screen.getByText("Expenses")).toBeInTheDocument();
    expect(screen.getByText("Profit")).toBeInTheDocument();
    expect(screen.getByText(/500,000/)).toBeInTheDocument();
  });
});
