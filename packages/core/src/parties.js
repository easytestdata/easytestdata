import { getLocaleConfig } from "./locales/index.js";
import { GENERIC_CLIENTS, INDUSTRY_NOUNS } from "./locales/names.js";

// ---------------------------------------------------------------------------
// Realistic, locale-aware customers, vendors and employees.
//
// Names are unique (case-insensitive) across every party in a plan because QBO
// requires DisplayName to be unique across customers, vendors and employees.
// Generated parties carry a stable `id` (CUST-001, VEND-001, EMP-001, ...) that
// loaders write into a tag field so purge never depends on the display name.
// ---------------------------------------------------------------------------

const PAYROLL_NOUNS = ["Payroll Services", "Payroll Solutions", "HR & Payroll"];
const NO_LEGAL_SUFFIX = new Set(["nonprofit"]);

function splitList(value) {
  return value.split("|");
}

function pick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

function slug(value) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "");
}

function serial(prefix, index) {
  return `${prefix}-${String(index + 1).padStart(3, "0")}`;
}

export function createPartyFactory(rng, { country = "US", industry = null } = {}) {
  const locale = getLocaleConfig(country);
  const firstNames = splitList(locale.nameParts.first);
  const lastNames = splitList(locale.nameParts.last);
  const places = splitList(locale.nameParts.places);
  const legalSuffixes = splitList(locale.nameParts.legal);
  const cities = locale.addressParts.cities;
  const streets = splitList(locale.addressParts.streets);
  const nouns = INDUSTRY_NOUNS[industry] || {};
  const customerNouns = splitList(nouns.customers || GENERIC_CLIENTS);
  const vendorNouns = splitList(nouns.vendors || INDUSTRY_NOUNS["professional-services"].vendors);
  const used = new Set();
  let phoneSeq = 0;

  function claim(makeName) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const name = makeName();
      if (!used.has(name.toLowerCase())) {
        used.add(name.toLowerCase());
        return name;
      }
    }
    // Name space nearly exhausted: disambiguate deterministically.
    const base = makeName();
    let n = 2;
    while (used.has(`${base} ${n}`.toLowerCase())) n += 1;
    used.add(`${base} ${n}`.toLowerCase());
    return `${base} ${n}`;
  }

  function companyName(nounList, allowLegal = true) {
    const roll = rng();
    let root;
    if (roll < 0.55) {
      root = pick(rng, lastNames);
    } else if (roll < 0.85) {
      root = pick(rng, places);
    } else {
      const a = pick(rng, lastNames);
      const b = pick(
        rng,
        lastNames.filter((name) => name !== a)
      );
      root = `${a} & ${b}`;
    }
    const noun = pick(rng, nounList);
    let name = `${root} ${noun}`;
    const legal = pick(rng, legalSuffixes);
    const words = (value) => value.replace(/\./g, "").split(" ");
    const clashes = words(legal).some((word) => words(name).includes(word));
    if (allowLegal && rng() < 0.5 && !clashes) name += ` ${legal}`;
    return name;
  }

  function address() {
    const [city, region, postalCode] = pick(rng, cities);
    const number = 10 + Math.floor(rng() * 1990);
    return {
      line1: `${number} ${pick(rng, streets)}`,
      city,
      region,
      postalCode,
      country: locale.code
    };
  }

  function company(id, name, mailbox) {
    return {
      id,
      name,
      email: `${mailbox}@${slug(name).slice(0, 40)}.example.com`,
      phone: locale.phone(phoneSeq++),
      address: address()
    };
  }

  return {
    customer(index) {
      const allowLegal = !NO_LEGAL_SUFFIX.has(industry);
      return company(
        serial("CUST", index),
        claim(() => companyName(customerNouns, allowLegal)),
        "accounts"
      );
    },
    vendor(index) {
      return company(
        serial("VEND", index),
        claim(() => companyName(vendorNouns)),
        "billing"
      );
    },
    payrollVendor() {
      return company(
        "VEND-PAYROLL",
        claim(() => companyName(PAYROLL_NOUNS)),
        "billing"
      );
    },
    employee(index) {
      const name = claim(() => `${pick(rng, firstNames)} ${pick(rng, lastNames)}`);
      const [givenName, familyName] = name.split(/ (.*)/s);
      return {
        id: serial("EMP", index),
        name,
        givenName,
        familyName,
        email: `${slug(givenName)}.${slug(familyName)}@example.com`,
        phone: locale.phone(phoneSeq++),
        address: address()
      };
    }
  };
}

/**
 * Generate every party for a plan in a fixed order so output is deterministic
 * for a given rng.
 */
export function generateParties(
  rng,
  { country, industry, customerCount, vendorCount, employeeCount }
) {
  const factory = createPartyFactory(rng, { country, industry });
  const customers = Array.from({ length: customerCount }, (_, i) => factory.customer(i));
  const vendors = Array.from({ length: vendorCount }, (_, i) => factory.vendor(i));
  const employees = Array.from({ length: employeeCount }, (_, i) => factory.employee(i));
  const payrollVendor = employeeCount > 0 ? factory.payrollVendor() : null;
  return { customers, vendors, employees, payrollVendor };
}
