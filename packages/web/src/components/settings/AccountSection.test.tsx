import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountSection } from "./AccountSection";

const authState = vi.hoisted(() => ({
  user: { id: "u1", email: "user@example.com", displayName: "User One", avatarUrl: null },
  isAdmin: false
}));

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => authState
}));

describe("AccountSection", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows the profile", () => {
    render(<AccountSection />);

    expect(screen.getByText("User One")).toBeInTheDocument();
    expect(screen.getByText("user@example.com")).toBeInTheDocument();
  });
});
