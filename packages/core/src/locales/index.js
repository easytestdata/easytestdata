import {
  US_ADDRESS_PARTS,
  GB_ADDRESS_PARTS,
  AU_ADDRESS_PARTS,
  CA_ADDRESS_PARTS
} from "./addresses.js";
import { US_NAME_PARTS, GB_NAME_PARTS, AU_NAME_PARTS, CA_NAME_PARTS } from "./names.js";

// Fictional phone numbers only: 555-01xx (NANP), 020 7946 0xxx (Ofcom drama range),
// 02 5550 xxxx (ACMA drama range).
const LOCALE_CONFIGS = {
  US: {
    code: "US",
    currency: "USD",
    currencySymbol: "$",
    taxSystem: "Sales Tax (varies by state)",
    addressParts: US_ADDRESS_PARTS,
    nameParts: US_NAME_PARTS,
    phone: (n) =>
      `(${[512, 303, 312, 206, 617, 503][n % 6]}) 555-01${String(n % 100).padStart(2, "0")}`,
    addressFormat: { subdivision: "State", postalCode: "ZIP Code" },
    defaultPaymentTerms: [
      { days: 15, weight: 0.2 },
      { days: 30, weight: 0.5 },
      { days: 60, weight: 0.3 }
    ]
  },
  GB: {
    code: "GB",
    currency: "GBP",
    currencySymbol: "£",
    taxSystem: "VAT 20%",
    addressParts: GB_ADDRESS_PARTS,
    nameParts: GB_NAME_PARTS,
    phone: (n) => `020 7946 0${String(n % 1000).padStart(3, "0")}`,
    addressFormat: { subdivision: "County", postalCode: "Postcode" },
    defaultPaymentTerms: [
      { days: 14, weight: 0.3 },
      { days: 30, weight: 0.5 },
      { days: 60, weight: 0.2 }
    ]
  },
  AU: {
    code: "AU",
    currency: "AUD",
    currencySymbol: "A$",
    taxSystem: "GST 10%",
    addressParts: AU_ADDRESS_PARTS,
    nameParts: AU_NAME_PARTS,
    phone: (n) => `02 5550 ${String(n % 10000).padStart(4, "0")}`,
    addressFormat: { subdivision: "State", postalCode: "Postcode" },
    defaultPaymentTerms: [
      { days: 14, weight: 0.25 },
      { days: 30, weight: 0.5 },
      { days: 60, weight: 0.25 }
    ]
  },
  CA: {
    code: "CA",
    currency: "CAD",
    currencySymbol: "C$",
    taxSystem: "GST 5% + PST/HST (varies by province)",
    addressParts: CA_ADDRESS_PARTS,
    nameParts: CA_NAME_PARTS,
    phone: (n) => `(${[416, 604, 403, 514, 902][n % 5]}) 555-01${String(n % 100).padStart(2, "0")}`,
    addressFormat: { subdivision: "Province", postalCode: "Postal Code" },
    defaultPaymentTerms: [
      { days: 15, weight: 0.2 },
      { days: 30, weight: 0.5 },
      { days: 60, weight: 0.3 }
    ]
  }
};

const SUPPORTED_COUNTRIES = Object.keys(LOCALE_CONFIGS);

export function getLocaleConfig(countryCode = "US") {
  const code = String(countryCode).toUpperCase();
  const config = LOCALE_CONFIGS[code];
  if (!config) {
    throw new Error(
      `Unsupported country code: ${countryCode}. Supported: ${SUPPORTED_COUNTRIES.join(", ")}`
    );
  }
  return config;
}

export { LOCALE_CONFIGS, SUPPORTED_COUNTRIES };
