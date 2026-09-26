import { describe, it, expect } from "vitest";
import { getLocaleConfig, SUPPORTED_COUNTRIES } from "../src/locales/index.js";

describe("getLocaleConfig", () => {
  it("should return valid US config with addresses, names, and currency", () => {
    const config = getLocaleConfig("US");
    expect(config.code).toBe("US");
    expect(config.currency).toBe("USD");
    expect(config.currencySymbol).toBe("$");
    expect(config.addressParts.cities.length).toBeGreaterThan(0);
    expect(config.nameParts.first.split("|").length).toBeGreaterThan(10);
    expect(config.nameParts.last.split("|").length).toBeGreaterThan(10);
    expect(config.defaultPaymentTerms).toBeDefined();
    expect(config.defaultPaymentTerms.length).toBeGreaterThan(0);
  });

  it("should return GBP currency and GB addresses for GB", () => {
    const config = getLocaleConfig("GB");
    expect(config.code).toBe("GB");
    expect(config.currency).toBe("GBP");
    expect(config.currencySymbol).toBe("\u00A3");
    expect(config.addressParts.cities.length).toBeGreaterThan(0);
    expect(config.phone(7)).toBe("020 7946 0007");
  });

  it("should return AUD currency and AU addresses for AU", () => {
    const config = getLocaleConfig("AU");
    expect(config.code).toBe("AU");
    expect(config.currency).toBe("AUD");
    expect(config.currencySymbol).toBe("A$");
    expect(config.addressParts.cities.length).toBeGreaterThan(0);
  });

  it("should return CAD currency and CA addresses for CA", () => {
    const config = getLocaleConfig("CA");
    expect(config.code).toBe("CA");
    expect(config.currency).toBe("CAD");
    expect(config.currencySymbol).toBe("C$");
    expect(config.addressParts.cities.length).toBeGreaterThan(0);
  });

  it("should throw error for invalid country code", () => {
    expect(() => getLocaleConfig("ZZ")).toThrow("Unsupported country code: ZZ");
  });

  it("should handle lowercase country codes", () => {
    const config = getLocaleConfig("gb");
    expect(config.code).toBe("GB");
    expect(config.currency).toBe("GBP");
  });

  it("should default to US when no code provided", () => {
    const config = getLocaleConfig();
    expect(config.code).toBe("US");
    expect(config.currency).toBe("USD");
  });

  it("should list all supported countries", () => {
    expect(SUPPORTED_COUNTRIES).toContain("US");
    expect(SUPPORTED_COUNTRIES).toContain("GB");
    expect(SUPPORTED_COUNTRIES).toContain("AU");
    expect(SUPPORTED_COUNTRIES).toContain("CA");
    expect(SUPPORTED_COUNTRIES).toHaveLength(4);
  });
});
