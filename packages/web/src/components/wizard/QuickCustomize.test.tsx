import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_EMPLOYEES } from "@easytestdata/core";
import { QuickCustomize } from "@easytestdata/ui";

type Props = Parameters<typeof QuickCustomize>[0];

describe("QuickCustomize", () => {
  afterEach(() => {
    cleanup();
  });

  it("caps the employee field at the generator's maximum (the server refuses more)", () => {
    render(
      <QuickCustomize
        form={
          { startDate: "", endDate: "", customerCount: "10", employeeCount: "5" } as Props["form"]
        }
        setField={vi.fn()}
        connections={[]}
      />
    );

    expect(screen.getByLabelText("Employees")).toHaveAttribute("max", String(MAX_EMPLOYEES));
  });
});
