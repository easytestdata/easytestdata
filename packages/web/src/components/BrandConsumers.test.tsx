import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConnectStep,
  EraseConfirmDialog,
  InlineJobProgress,
  JobConfigSummary,
  JobDetailSheet,
  LoadStep,
  ProductBrandProvider,
  type Job,
  type QboConnection,
  type ScenarioFormState
} from "@easytestdata/ui";
import { brand } from "../brand";
import { Layout } from "./Layout";
import { AboutSection } from "./settings/AboutSection";
import { LoginPage } from "../pages/LoginPage";

vi.mock("../brand", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../brand")>();
  return { brand: { ...actual.brand } };
});

const appConfig = vi.hoisted(() => ({
  deployment: "cloud" as "cloud" | "local",
  enabledOAuthProviders: ["google"],
  marketingUrl: "https://easytestdata.com",
  qboConfigured: true,
  version: "0.1.0"
}));
const auth = vi.hoisted(() => ({
  user: null,
  loading: false,
  isAdmin: false,
  logout: vi.fn(),
  exchangeOAuthCode: vi.fn()
}));
vi.mock("../contexts/AuthContext", () => ({ useAuth: () => auth }));
vi.mock("../contexts/AppConfigContext", () => ({ useAppConfig: () => appConfig }));
vi.mock("@easytestdata/shared/api-hooks", () => ({
  useJob: () => ({ data: undefined }),
  useJobData: () => ({ data: undefined, isLoading: false, error: null }),
  useCreateJob: () => ({ mutateAsync: vi.fn(), isPending: false })
}));

const publicBrand = { ...brand };
const sourceBrand = {
  name: "EasyTestData Pro",
  description: "Read real companies and generate sandbox data.",
  repoUrl: null,
  supportsSourceReads: true,
  companionUrl: "https://easytestdata.com/run-locally",
  companionLabel: "EasyTestData (free)",
  logo: ({ className }: { className?: string }) => (
    <svg className={className} aria-label="Pro logo" />
  )
};
const connection = {
  id: "conn-1",
  company_name: "Acme Books",
  connected_at: "2026-09-01T00:00:00Z",
  tokenHealth: "ok"
} as QboConnection;
const job: Job = {
  id: "job-1",
  type: "load",
  status: "completed",
  connection_id: connection.id,
  config: { templateId: "retail", purgeMode: "all", tag: "EZTD" },
  progress: null,
  result: null,
  error: null,
  entity_count: 42,
  created_at: "2026-09-01T00:00:00Z",
  started_at: "2026-09-01T00:00:00Z",
  completed_at: "2026-09-01T00:00:10Z",
  result_summary: null
};

function renderBrand(children: ReactNode) {
  return render(
    <ProductBrandProvider value={brand}>
      <MemoryRouter>{children}</MemoryRouter>
    </ProductBrandProvider>
  );
}

beforeEach(() => {
  Object.assign(brand, publicBrand);
  appConfig.deployment = "cloud";
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
});
afterEach(() => {
  cleanup();
  Object.assign(brand, publicBrand, { companionUrl: undefined, companionLabel: undefined });
  vi.unstubAllGlobals();
});

describe.each([false, true])("brand consumers (source reads: %s)", (sourceReads) => {
  beforeEach(() => {
    if (sourceReads) Object.assign(brand, sourceBrand);
  });

  it("renders the brand logo beside the name within the mobile header", () => {
    renderBrand(<Layout />);
    const mobileHeader = screen
      .getByRole("button", { name: "Open navigation menu" })
      .closest("header")!;
    expect(mobileHeader).toHaveClass("lg:hidden");
    expect(within(mobileHeader).getByText(brand.name)).toBeInTheDocument();
    if (sourceReads) {
      expect(within(mobileHeader).getByLabelText("Pro logo")).toBeInTheDocument();
    } else {
      expect(mobileHeader.querySelector('svg[viewBox="0 0 40 40"]')).toBeInTheDocument();
    }
  });

  it("renders desktop and mobile navigation with the right name, links and badges", () => {
    const { container } = renderBrand(<Layout />);
    expect(container.querySelectorAll("header")[0]).toHaveTextContent(brand.name);
    expect(container.querySelectorAll("header")[1]).toHaveTextContent(brand.name);
    if (sourceReads) {
      expect(
        within(container.querySelectorAll("header")[0]!).getByLabelText("Pro logo")
      ).toBeInTheDocument();
      expect(screen.queryByText("Sandbox only")).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Open source" })).not.toBeInTheDocument();
      const companion = screen.getByRole("link", { name: sourceBrand.companionLabel });
      expect(companion).toHaveAttribute("href", sourceBrand.companionUrl);
      expect(companion).toHaveAttribute("target", "_blank");
      expect(companion).toHaveAttribute("rel", "noopener noreferrer");
    } else {
      expect(screen.getAllByText("Sandbox only")).toHaveLength(2);
      expect(screen.getByRole("link", { name: "Open source" })).toHaveAttribute(
        "href",
        brand.repoUrl
      );
    }
    fireEvent.click(screen.getByRole("button", { name: "Open navigation menu" }));
    const menu = screen.getByRole("dialog");
    expect(within(menu).getByRole("heading")).toHaveTextContent(brand.name);
    if (sourceReads) {
      expect(menu).not.toHaveTextContent(/Sandbox only|Apache|Open source/);
      expect(within(menu).getByLabelText("Pro logo")).toBeInTheDocument();
      const companion = within(menu).getByRole("link", { name: sourceBrand.companionLabel });
      expect(companion).toHaveAttribute("href", sourceBrand.companionUrl);
      expect(companion).toHaveAttribute("target", "_blank");
      expect(companion).toHaveAttribute("rel", "noopener noreferrer");
      expect(container.querySelectorAll('a[href*="github.com"]')).toHaveLength(0);
    } else {
      expect(within(menu).getByText("Sandbox only")).toBeInTheDocument();
      expect(within(menu).getByRole("link", { name: "Open source (Apache-2.0)" })).toHaveAttribute(
        "href",
        publicBrand.repoUrl
      );
    }
  });

  it("renders truthful login copy with the supplied logo and description", () => {
    const { container } = renderBrand(<LoginPage />);
    expect(screen.getByRole("heading", { name: brand.name })).toBeInTheDocument();
    expect(screen.getByText(brand.description)).toBeInTheDocument();
    if (sourceReads) {
      expect(screen.getByLabelText("Pro logo")).toBeInTheDocument();
      expect(container).toHaveTextContent(
        "Real companies are read only. Generated data goes only to sandboxes."
      );
      expect(container).not.toHaveTextContent(
        /never connects to a production|Apache|Free and open source/
      );
      expect(container.querySelector('a[href*="github.com"]')).toBeNull();
    } else {
      expect(container).toHaveTextContent(
        "Sandbox-only: EasyTestData never connects to a production QuickBooks company."
      );
      expect(container).toHaveTextContent("Free and open source (Apache-2.0).");
      expect(screen.getByRole("link", { name: "Read the code on GitHub" })).toHaveAttribute(
        "href",
        publicBrand.repoUrl
      );
    }
  });

  it.each(["cloud", "local"] as const)(
    "renders truthful About resources in %s mode",
    async (deployment) => {
      appConfig.deployment = deployment;
      const { container } = renderBrand(<AboutSection />);
      await screen.findByText("Reachable");
      expect(screen.getByText(`About ${brand.name}`)).toBeInTheDocument();
      expect(screen.getByText(brand.description)).toBeInTheDocument();
      expect(
        screen.getAllByText(deployment === "local" ? "Local" : `${brand.name} Cloud`)
      ).toHaveLength(2);
      if (sourceReads) {
        expect(screen.getByLabelText("Pro logo")).toBeInTheDocument();
        expect(container).toHaveTextContent(
          "Real companies are read only. Generated data goes only to sandboxes."
        );
        expect(container).not.toHaveTextContent(
          /never connects to a production|Apache|Sandbox only/
        );
        expect(container.querySelector('a[href*="github.com"]')).toBeNull();
        expect(screen.getByRole("link", { name: sourceBrand.companionLabel })).toHaveAttribute(
          "href",
          sourceBrand.companionUrl
        );
      } else {
        expect(container).toHaveTextContent(
          `EasyTestData only connects to QuickBooks Online (QBO) sandbox companies. QBO API calls are hard-coded to the sandbox endpoint, so this ${deployment === "local" ? "app" : "service"} never connects to a production company. EasyTestData is open source under the Apache 2.0 license.`
        );
        expect(screen.getByText("Sandbox only")).toBeInTheDocument();
        expect(screen.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([
          publicBrand.repoUrl,
          `${publicBrand.repoUrl}/blob/main/docs/run-locally.md`,
          `${publicBrand.repoUrl}#readme`,
          `${publicBrand.repoUrl}/issues`
        ]);
      }
    }
  );

  it.each([false, true])(
    "keeps the wizard's sandbox guarantee with an existing connection: %s",
    (connected) => {
      const { container } = renderBrand(
        <ConnectStep
          connections={connected ? [connection] : []}
          onConnected={vi.fn()}
          onDeleteConnection={vi.fn()}
          onTestConnection={vi.fn()}
          onAuthorizeConnection={vi.fn()}
          onConnectionsInvalidate={vi.fn()}
        />
      );
      expect(container).toHaveTextContent("Sandbox companies only");
      if (sourceReads) {
        expect(container).toHaveTextContent(
          "Generated data is only ever loaded into sandbox companies"
        );
        if (!connected)
          expect(container).toHaveTextContent(
            "Generated data can only be loaded into sandbox companies"
          );
        expect(container).not.toHaveTextContent("refuses any non-sandbox");
        expect(container.querySelector('a[href*="github.com"]')).toBeNull();
      } else {
        expect(container).toHaveTextContent(
          "EasyTestData refuses any non-sandbox QuickBooks address"
        );
        expect(screen.getByRole("link", { name: "see the check in the code" })).toBeInTheDocument();
      }
      if (connected) {
        fireEvent.click(screen.getByRole("button", { name: "Disconnect Acme Books" }));
        expect(screen.getByRole("alertdialog")).toHaveTextContent(
          `${brand.name} forgets this sandbox and its tokens. Data already in QuickBooks stays. You can reconnect anytime.`
        );
      }
    }
  );

  it("preserves erase confirmation and uses the product name in its warning", () => {
    const onConfirm = vi.fn();
    renderBrand(<EraseConfirmDialog open onOpenChange={vi.fn()} onConfirm={onConfirm} />);
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent(
      `transaction of the types ${brand.name} loads, including ones you entered by hand, not just ${brand.name}'s.`
    );
    expect(dialog).toHaveTextContent("Accounts stay.");
    const confirm = within(dialog).getByRole("button", { name: "Erase all data" });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "erase" } });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "ERASE" } });
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it.each(["all", "generated"])("names the product in the %s purge configuration", (purgeMode) => {
    const { container } = renderBrand(
      <JobConfigSummary config={{ purgeMode, tag: "EZTD" }} type="purge" />
    );
    expect(container).toHaveTextContent(
      purgeMode === "all"
        ? `Every transaction of the types ${brand.name} loads, including yours`
        : `${brand.name}'s transactions`
    );
    expect(container).toHaveTextContent("accounts kept");
    expect(container).toHaveTextContent("EZTD");
  });

  it("passes the product name to the completed purge outcome", () => {
    renderBrand(
      <InlineJobProgress
        job={{ ...job, type: "purge", config: { purgeMode: "generated" } }}
        connectionName="Acme Books"
        onCancelJob={vi.fn()}
      />
    );
    expect(screen.getByText(new RegExp(`42 ${brand.name} transaction`))).toHaveTextContent(
      "accounts stay."
    );
  });

  it("passes the product name to the Load again destructive warning", () => {
    renderBrand(
      <JobDetailSheet open onOpenChange={vi.fn()} job={job} connectionName="Acme Books" />
    );
    fireEvent.click(screen.getByRole("button", { name: "Load again (new data)" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      `every transaction of the types ${brand.name} loads is deleted, including ones you entered by hand`
    );
  });

  it("keeps the free local-product referral and stable EZTD tag in LoadStep", () => {
    const form = {
      templateId: "retail",
      connectionId: connection.id,
      startDate: "2026-01-01",
      endDate: "2026-03-31",
      ratioOverrides: {},
      purgeMode: "none"
    } as ScenarioFormState;
    const { container } = renderBrand(
      <LoadStep
        form={form}
        setField={vi.fn()}
        setRatio={vi.fn()}
        applyPreset={vi.fn()}
        overrideCount={0}
        advancedOpen={false}
        setAdvancedOpen={vi.fn()}
        connections={[connection]}
        templates={[]}
        isLoadingTemplates={false}
        presets={[]}
        isLoadingPresets={false}
        estimate={{ estimatedEntities: 6000, limit: 5000, metrics: {} }}
        activeJob={null}
        onCancelJob={vi.fn()}
        isLoading={false}
        onLoad={vi.fn()}
      />
    );
    expect(container).toHaveTextContent("run EasyTestData locally for no limits.");
    expect(container).not.toHaveTextContent("run EasyTestData Pro locally");
    expect(container).toHaveTextContent("EZTD");
  });
});
