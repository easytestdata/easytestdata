import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";

const getJob = vi.fn();
vi.mock("@easytestdata/shared/api-client", async (orig) => ({
  ...(await orig()),
  getJob: (...a: unknown[]) => getJob(...a)
}));
const { useJob } = await import("@easytestdata/shared/api-hooks");

afterEach(() => vi.useRealTimers());

it("polls an active job every 2 seconds and stops when it finishes", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const statuses = ["running", "running", "completed"];
  getJob.mockImplementation(async () => ({ id: "j", status: statuses.shift() ?? "completed" }));
  const qc = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useJob("j"), { wrapper });
  await waitFor(() => expect(result.current.data?.status).toBe("running"));
  await vi.advanceTimersByTimeAsync(2000);
  await vi.advanceTimersByTimeAsync(2000);
  await waitFor(() => expect(result.current.data?.status).toBe("completed"));
  const calls = getJob.mock.calls.length;
  await vi.advanceTimersByTimeAsync(6000);
  expect(getJob.mock.calls.length).toBe(calls);
});
