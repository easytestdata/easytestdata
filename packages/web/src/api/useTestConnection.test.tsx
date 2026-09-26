import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useTestConnection } from "@easytestdata/shared/api-hooks";

vi.mock("@easytestdata/shared/api-client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  testConnection: vi.fn(async () => ({ ok: true, companyName: "Acme Books" }))
}));

// A test renews the token, so the "Token expiring" badge and health dot must refetch after it.
describe("useTestConnection", () => {
  it("refreshes the connection list and health checks after a successful test", async () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useTestConnection(), { wrapper });

    await result.current.mutateAsync("conn-1");

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["connections"] })
    );
  });
});
