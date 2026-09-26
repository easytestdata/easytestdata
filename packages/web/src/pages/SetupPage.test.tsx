import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SetupPage } from "./SetupPage";

const REDIRECT_URI = "http://localhost:28080/api/v1/connections/callback";

const requestMock = vi.hoisted(() => vi.fn());
const refreshMock = vi.hoisted(() => vi.fn());
const authorizeMock = vi.hoisted(() => vi.fn());

vi.mock("../api/client", () => ({
  request: (...args: unknown[]) => requestMock(...args),
  authorizeConnection: (...args: unknown[]) => authorizeMock(...args)
}));

vi.mock("../contexts/AppConfigContext", () => ({
  useAppConfig: () => ({
    deployment: "local",
    qboConfigured: false,
    qboRedirectUri: "http://localhost:28080/api/v1/connections/callback",
    refresh: refreshMock
  })
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function renderSetup() {
  return render(
    <MemoryRouter initialEntries={["/setup"]}>
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/home" element={<div>home-route</div>} />
      </Routes>
    </MemoryRouter>
  );
}

function fillAndSubmit() {
  fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: "ABC" } });
  fireEvent.change(screen.getByLabelText("Client Secret"), { target: { value: "s3cret" } });
  fireEvent.click(screen.getByRole("button", { name: "Save and connect" }));
}

describe("SetupPage", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    requestMock.mockReset();
    refreshMock.mockReset();
    requestMock.mockImplementation(async (method: string) =>
      method === "GET" ? { qboConfigured: false, redirectUri: REDIRECT_URI } : undefined
    );
    refreshMock.mockResolvedValue(undefined);
    authorizeMock.mockReset();
    // No URL: the page falls back to /home, which keeps these tests off window.location.
    authorizeMock.mockResolvedValue({ url: "" });
  });

  it("goes on to Intuit after saving instead of back to the Connect button", async () => {
    requestMock.mockImplementation(async (method: string) =>
      method === "GET"
        ? { qboConfigured: false, redirectUri: REDIRECT_URI }
        : { qboConfigured: true }
    );
    renderSetup();
    await screen.findByText(REDIRECT_URI);

    fillAndSubmit();

    await waitFor(() => expect(authorizeMock).toHaveBeenCalledWith("redirect"));
    expect(refreshMock).toHaveBeenCalled();
  });

  it("shows the redirect URI from GET /setup with a copy button", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderSetup();

    expect(await screen.findByText(REDIRECT_URI)).toBeInTheDocument();
    expect(requestMock).toHaveBeenCalledWith("GET", "/setup");
    fireEvent.click(screen.getByRole("button", { name: "Copy redirect URI" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(REDIRECT_URI));
  });

  it("saves both keys, refreshes the app config, then goes home", async () => {
    requestMock.mockImplementation(async (method: string) =>
      method === "GET"
        ? { qboConfigured: false, redirectUri: REDIRECT_URI }
        : { qboConfigured: true }
    );
    renderSetup();
    await screen.findByText(REDIRECT_URI);

    fillAndSubmit();

    expect(await screen.findByText("home-route")).toBeInTheDocument();
    expect(requestMock).toHaveBeenCalledWith("PUT", "/setup/qbo", {
      clientId: "ABC",
      clientSecret: "s3cret"
    });
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it("stays on the page with an explanation when the app settings cannot be reloaded", async () => {
    requestMock.mockImplementation(async (method: string) =>
      method === "GET"
        ? { qboConfigured: false, redirectUri: REDIRECT_URI }
        : { qboConfigured: true }
    );
    refreshMock.mockRejectedValue(new Error("Failed to load public config"));
    renderSetup();
    await screen.findByText(REDIRECT_URI);

    fillAndSubmit();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The keys were saved, but the app could not reload its settings"
    );
    expect(screen.queryByText("home-route")).not.toBeInTheDocument();
  });

  it("falls back to the app config's redirect URI when GET /setup fails", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    requestMock.mockRejectedValue(new Error("offline"));
    renderSetup();

    expect(await screen.findByText(REDIRECT_URI)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy redirect URI" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(REDIRECT_URI));
  });

  it("shows the server error on 400 and stays on the page", async () => {
    requestMock.mockImplementation(async (method: string) => {
      if (method === "GET") return { qboConfigured: false, redirectUri: REDIRECT_URI };
      throw Object.assign(new Error("Enter the Client ID."), { status: 400 });
    });
    renderSetup();
    await screen.findByText(REDIRECT_URI);

    fillAndSubmit();

    expect(await screen.findByRole("alert")).toHaveTextContent("Enter the Client ID.");
    expect(refreshMock).not.toHaveBeenCalled();
    expect(screen.queryByText("home-route")).not.toBeInTheDocument();
  });
});
