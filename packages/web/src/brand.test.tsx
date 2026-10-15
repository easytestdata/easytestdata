import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProductBrandProvider,
  REPO_URL,
  SANDBOX_GUARD_SOURCE_URL,
  TrustBanner,
  useProductBrand
} from "@easytestdata/ui";
import { brand } from "./brand";

const sourceBrand = {
  name: "EasyTestData Pro",
  repoUrl: null,
  supportsSourceReads: true
};

function BrandConsumer() {
  const { name, repoUrl, supportsSourceReads } = useProductBrand();
  return <output>{JSON.stringify({ name, repoUrl, supportsSourceReads })}</output>;
}

afterEach(cleanup);

describe("ProductBrandProvider", () => {
  it("defaults to the public brand without a provider", () => {
    render(<BrandConsumer />);
    expect(JSON.parse(screen.getByRole("status").textContent!)).toEqual({
      name: brand.name,
      repoUrl: brand.repoUrl,
      supportsSourceReads: false
    });
  });

  it("provides the alternate brand and restores the outer value after a nested provider", () => {
    const { rerender } = render(
      <ProductBrandProvider value={sourceBrand}>
        <BrandConsumer />
      </ProductBrandProvider>
    );
    expect(JSON.parse(screen.getByRole("status").textContent!)).toEqual(sourceBrand);
    rerender(
      <ProductBrandProvider value={sourceBrand}>
        <ProductBrandProvider value={brand}>
          <BrandConsumer />
        </ProductBrandProvider>
        <BrandConsumer />
      </ProductBrandProvider>
    );
    expect(screen.getAllByRole("status").map((node) => JSON.parse(node.textContent!))).toEqual(
      [brand, sourceBrand].map(({ name, repoUrl, supportsSourceReads }) => ({
        name,
        repoUrl,
        supportsSourceReads
      }))
    );
  });
});

describe.each(["full", "compact", "badge"] as const)("TrustBanner %s", (variant) => {
  it("preserves the public sandbox message and guard link", () => {
    const { container } = render(<TrustBanner variant={variant} />);
    expect(container).toHaveTextContent(
      variant === "badge" ? "Sandbox only" : "Sandbox companies only"
    );
    if (variant !== "badge") {
      expect(container).toHaveTextContent(
        "EasyTestData refuses any non-sandbox QuickBooks address"
      );
      expect(screen.getByRole("link", { name: "see the check in the code" })).toHaveAttribute(
        "href",
        SANDBOX_GUARD_SOURCE_URL
      );
    }
    expect(REPO_URL).toBe("https://github.com/easytestdata/easytestdata");
  });

  it("keeps the sandbox message for generated data without a repository", () => {
    const { container } = render(
      <ProductBrandProvider value={sourceBrand}>
        <TrustBanner variant={variant} />
      </ProductBrandProvider>
    );
    expect(container).toHaveTextContent(/sandbox/i);
    expect(container).toHaveTextContent(/generated data/i);
    if (variant !== "badge") {
      expect(container).toHaveTextContent(
        "Generated data is only ever loaded into sandbox companies"
      );
    }
    expect(container).not.toHaveTextContent("refuses any non-sandbox");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("omits only repository links for a public-style brand without a repository", () => {
    const { container } = render(
      <ProductBrandProvider value={{ ...sourceBrand, supportsSourceReads: false }}>
        <TrustBanner variant={variant} />
      </ProductBrandProvider>
    );
    expect(container).toHaveTextContent(/sandbox/i);
    if (variant !== "badge") {
      expect(container).toHaveTextContent(
        "EasyTestData Pro refuses any non-sandbox QuickBooks address"
      );
    }
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});

it("builds the guard link from the supplied repository", () => {
  render(
    <ProductBrandProvider value={{ ...sourceBrand, repoUrl: "https://example.com/product" }}>
      <TrustBanner />
    </ProductBrandProvider>
  );
  expect(screen.getByRole("link")).toHaveAttribute(
    "href",
    "https://example.com/product/blob/main/packages/qbo-client/src/qbo-client.js"
  );
  expect(screen.getByRole("link")).toHaveAttribute("rel", "noopener noreferrer");
});
