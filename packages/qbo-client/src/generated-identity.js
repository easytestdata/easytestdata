/**
 * The one answer to "did EasyTestData generate this QBO record with tag T?", used by every path
 * that acts on generated records only: a load reusing or reactivating master data, Remove test data
 * (purge, generated mode) and ensureServiceItem. A rollback needs no tag test: it acts on the ids
 * its load's ledger recorded.
 */

/**
 * True when `value` starts with `tag` as a whole token (case-insensitive): "EZTD",
 * "EZTD-INV-0001" and "EZTD CUST-001 ..." match tag "EZTD"; "EZTDX" does not.
 */
export function tagMatches(value, tag) {
  if (!value || !tag) return false;
  const text = String(value).toUpperCase();
  const prefix = String(tag).toUpperCase();
  return text.startsWith(prefix) && !/[A-Z0-9]/.test(text.charAt(prefix.length));
}

/** Transactions carry the tag in PrivateNote (every load) or DocNumber. */
export const TRANSACTION_TAG_FIELDS = ["PrivateNote", "DocNumber"];

/** The transaction types a load creates (and Remove test data deletes), by QBO query name. */
export const TRANSACTION_ENTITIES = [
  "Deposit",
  "Payment",
  "SalesReceipt",
  "CreditMemo",
  "RefundReceipt",
  "Estimate",
  "Invoice",
  "BillPayment",
  "VendorCredit",
  "Bill",
  "PurchaseOrder",
  "Purchase",
  "Transfer",
  "JournalEntry",
  "TimeActivity"
];

/** Where current loads write the tag on master data (a party's tag is e.g. "EZTD-CUST-001"). */
export const MASTER_DATA_TAG_FIELDS = {
  Customer: "Notes",
  Vendor: "AcctNum",
  Employee: "EmployeeNumber",
  Item: "Description"
};

/** Tag value written on a generated party, e.g. "EZTD-CUST-001". */
export function partyTag(tag, partyId) {
  return `${tag}-${partyId}`;
}

const isBlank = (value) => value === undefined || value === null || String(value).trim() === "";

/**
 * Whether `record` (a QBO `entityName` record, e.g. "Invoice" or "Vendor", read with every field
 * the rule needs: `select *` does) was generated with `tag`. Master data is recognised by its tag
 * field only, so a user's record is never matched because of its name. Throws for an entity type
 * the rule does not cover, so a new caller cannot silently match nothing.
 */
export function isGeneratedRecord(entityName, record, tag) {
  if (!record || isBlank(tag)) return false;
  const tagField = MASTER_DATA_TAG_FIELDS[entityName];
  if (tagField) {
    const marker = record[tagField];
    return !isBlank(marker) && tagMatches(marker, tag);
  }
  if (TRANSACTION_ENTITIES.includes(entityName)) {
    return TRANSACTION_TAG_FIELDS.some((field) => tagMatches(record[field], tag));
  }
  throw new Error(`No generated-record rule for ${entityName}.`);
}
