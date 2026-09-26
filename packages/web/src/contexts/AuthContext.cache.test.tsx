import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { useClearQueryCacheOnSessionChange } from "./AuthContext";

function setup() {
  const queryClient = new QueryClient();
  queryClient.setQueryData(["jobs"], ["team-a-job"]);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    ({ userId, teamId }: { userId: string | null; teamId: string | null }) =>
      useClearQueryCacheOnSessionChange(userId, teamId),
    {
      wrapper,
      initialProps: { userId: "u1", teamId: "team-a" } as {
        userId: string | null;
        teamId: string | null;
      }
    }
  );
  return { queryClient, ...hook };
}

describe("useClearQueryCacheOnSessionChange", () => {
  it("keeps the cache on the initial session and when nothing changes", () => {
    const { queryClient, rerender } = setup();
    rerender({ userId: "u1", teamId: "team-a" });
    expect(queryClient.getQueryData(["jobs"])).toEqual(["team-a-job"]);
  });

  it("clears the cache when the team changes", () => {
    const { queryClient, rerender } = setup();
    rerender({ userId: "u1", teamId: "team-b" });
    expect(queryClient.getQueryData(["jobs"])).toBeUndefined();
  });

  it("clears the cache on logout", () => {
    const { queryClient, rerender } = setup();
    rerender({ userId: null, teamId: null });
    expect(queryClient.getQueryData(["jobs"])).toBeUndefined();
  });
});
