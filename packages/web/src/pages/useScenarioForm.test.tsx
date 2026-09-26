import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useScenarioForm } from "@easytestdata/ui";

const sandbox = (id: string) => ({ id, company_name: id, realm_id: id }) as never;

describe("useScenarioForm on the always-open load screen", () => {
  it("keeps what the user entered when the connection list refetches", async () => {
    const getPreset = vi.fn(async () => ({ request: {} }) as never);
    const { result, rerender } = renderHook(
      ({ connections }) => useScenarioForm(true, connections, getPreset),
      { initialProps: { connections: [sandbox("a"), sandbox("b")] } }
    );
    await waitFor(() => expect(result.current.form.connectionId).toBe("a"));

    act(() => {
      result.current.setField("customerCount", "42");
      result.current.setField("connectionId", "b");
    });

    // Same sandboxes, new array (a refetch after last_used_at changed).
    rerender({ connections: [sandbox("a"), sandbox("b")] });
    expect(result.current.form.customerCount).toBe("42");
    expect(result.current.form.connectionId).toBe("b");

    // The chosen sandbox was removed elsewhere: move to one that exists, keep the rest.
    rerender({ connections: [sandbox("a")] });
    expect(result.current.form.connectionId).toBe("a");
    expect(result.current.form.customerCount).toBe("42");
  });

  it("picks the first sandbox once connections load", async () => {
    const getPreset = vi.fn(async () => ({ request: {} }) as never);
    const { result, rerender } = renderHook(
      ({ connections }) => useScenarioForm(true, connections, getPreset),
      { initialProps: { connections: [] as never[] } }
    );
    expect(result.current.form.connectionId).toBe("");
    rerender({ connections: [sandbox("z")] });
    await waitFor(() => expect(result.current.form.connectionId).toBe("z"));
  });

  it("ignores a slow preset response after the user picked another preset", async () => {
    const slow = { request: { totalRevenue: 111 } };
    const fast = { request: { totalRevenue: 222 } };
    let resolveSlow: (v: unknown) => void = () => {};
    const getPreset = vi.fn((id: string) =>
      id === "slow" ? new Promise((r) => (resolveSlow = r)) : Promise.resolve(fast)
    );
    const { result } = renderHook(() => useScenarioForm(true, [], getPreset as never));
    act(() => void result.current.applyPreset("slow"));
    await act(async () => void (await result.current.applyPreset("fast")));
    await act(async () => resolveSlow(slow));
    expect(result.current.form.presetId).toBe("fast");
    expect(result.current.form.totalRevenue).toBe("222");
  });
});
