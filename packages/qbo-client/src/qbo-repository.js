import { getQueryItems } from "./qbo-client.js";
import { batchUpdate } from "./batch-helper.js";
import { isGeneratedRecord, MASTER_DATA_TAG_FIELDS } from "./generated-identity.js";

const PAGE_SIZE = 500;

// QBO returns only active name-list records (accounts, items, parties) unless a query asks for
// inactive ones too, but a name held by an inactive record still cannot be reused.
const ACTIVE_AND_INACTIVE = "Active IN (true, false)";

// QBO's query language escapes a quote inside a string literal with a backslash (\'), not by
// doubling it. Names can carry the user's tag, so both characters are escaped.
function escapeSqlString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/** Throws when `signal` is aborted: long operations call it before each QBO request they start. */
export function throwIfCancelled(signal, message = "Operation cancelled.") {
  if (signal?.aborted) throw new Error(message);
}

export async function queryAll(
  client,
  entityName,
  selectFields = "*",
  whereClause = "",
  maxPages = 100,
  { signal } = {}
) {
  let startPosition = 1;
  const allItems = [];
  let pageCount = 0;

  while (true) {
    throwIfCancelled(signal);
    const sql =
      `select ${selectFields} from ${entityName}` +
      (whereClause ? ` where ${whereClause}` : "") +
      ` startposition ${startPosition} maxresults ${PAGE_SIZE}`;

    const response = await client.query(sql);
    const page = getQueryItems(response, entityName);
    allItems.push(...page);
    pageCount += 1;

    if (page.length < PAGE_SIZE) {
      break;
    }

    if (pageCount >= maxPages) {
      break;
    }

    startPosition += PAGE_SIZE;
  }

  return allItems;
}

export async function getChartOfAccounts(client, { signal } = {}) {
  return queryAll(
    client,
    "Account",
    "Id, Name, AccountType, AccountSubType, Active",
    "Active = true",
    undefined,
    { signal }
  );
}

export async function findItemByName(client, name) {
  const safeName = escapeSqlString(name);
  const response = await client.query(
    `select Id, SyncToken, Name, Description, Active from Item where Name = '${safeName}' AND ${ACTIVE_AND_INACTIVE} maxresults 1`
  );
  const items = getQueryItems(response, "Item");
  return items[0] || null;
}

// An existing item with this name is reused (reactivated if inactive) only when it carries
// `noteTag` in its Description, i.e. this tool created it; an unrelated item is never touched.
export async function ensureServiceItem(client, name, incomeAccountId, noteTag) {
  const existing = await findItemByName(client, name);
  if (existing && !isGeneratedRecord("Item", existing, noteTag)) {
    throw new Error(
      `Service item "${name}" already exists and was not created by EasyTestData (its Description does not carry the tag "${noteTag}").`
    );
  }
  if (existing) {
    if (existing.Active === false) {
      const updated = await client.update("item", {
        Id: existing.Id,
        SyncToken: existing.SyncToken,
        sparse: true,
        Active: true
      });
      const value = updated?.Item || updated?.item;
      return {
        item: value || { ...existing, Active: true },
        created: false,
        reactivated: true
      };
    }
    return { item: existing, created: false, reactivated: false };
  }

  const created = await client.create("item", {
    Name: name,
    Type: "Service",
    IncomeAccountRef: { value: incomeAccountId },
    Description: noteTag,
    Active: true
  });

  return {
    item: created?.Item || created?.item,
    created: true,
    reactivated: false
  };
}

/** Inactivate every active record of `entityName`; stops starting batches once `signal` aborts. */
export async function inactivateAllActive(
  client,
  entityName,
  displayField,
  { signal, failures } = {}
) {
  const entities = await queryAll(
    client,
    entityName,
    `Id, SyncToken, ${displayField}, Active`,
    "Active = true",
    undefined,
    { signal }
  );

  if (entities.length === 0) return 0;

  const result = await batchUpdate(
    client,
    entityName.toLowerCase(),
    entities.map((e) => ({
      payload: { Id: e.Id, SyncToken: e.SyncToken, sparse: true, Active: false }
    })),
    { entityLabel: entityName, signal }
  );

  // Records QuickBooks refused to make inactive: the caller reports them (they are not errors here).
  if (failures && result.failures?.length) failures.push(...result.failures);
  return result.updatedCount;
}

export async function ensureAccount(client, name, accountType, accountSubType) {
  const safeName = escapeSqlString(name);
  const response = await client.query(
    `select Id, SyncToken, Name, AccountType, AccountSubType, Active from Account where Name = '${safeName}' AND ${ACTIVE_AND_INACTIVE} maxresults 1`
  );
  const items = getQueryItems(response, "Account");
  const existing = items[0] || null;

  if (existing) {
    if (existing.Active === false) {
      const updated = await client.update("account", {
        Id: existing.Id,
        SyncToken: existing.SyncToken,
        sparse: true,
        Active: true
      });
      const value = updated?.Account || updated?.account;
      return value || { ...existing, Active: true };
    }
    return existing;
  }

  const payload = {
    Name: name,
    AccountType: accountType
  };
  if (accountSubType) {
    payload.AccountSubType = accountSubType;
  }

  const created = await client.create("account", payload);
  return created?.Account || created?.account;
}

export function selectBankAccount(accounts, subType = "Checking") {
  return (
    accounts.find(
      (a) => a.AccountType === "Bank" && a.AccountSubType === subType && a.Active !== false
    ) || null
  );
}

export function selectCreditCardAccount(accounts) {
  return accounts.find((a) => a.AccountType === "Credit Card" && a.Active !== false) || null;
}

// The generated-record rule and the tag fields live in generated-identity.js; re-exported here.
export { tagMatches, MASTER_DATA_TAG_FIELDS, partyTag } from "./generated-identity.js";

/**
 * Inactivate active records of `entityName` whose tag field matches `tag`; stops starting batches
 * once `signal` aborts. Pass `failures` (an array) to collect the records QuickBooks refused.
 */
export async function inactivateTaggedEntities(client, entityName, tag, { signal, failures } = {}) {
  if (!MASTER_DATA_TAG_FIELDS[entityName])
    throw new Error(`No tag field defined for ${entityName}.`);
  // "*" reads the tag field the rule needs.
  const entities = await queryAll(client, entityName, "*", "Active = true", undefined, { signal });
  const toInactivate = entities.filter(
    (e) => e.Active !== false && isGeneratedRecord(entityName, e, tag)
  );
  if (toInactivate.length === 0) return 0;

  const result = await batchUpdate(
    client,
    entityName.toLowerCase(),
    toInactivate.map((e) => ({
      payload: { Id: e.Id, SyncToken: e.SyncToken, sparse: true, Active: false }
    })),
    { entityLabel: entityName, signal }
  );

  // Records QuickBooks refused to make inactive: the caller reports them (they are not errors here).
  if (failures && result.failures?.length) failures.push(...result.failures);
  return result.updatedCount;
}

// ---------------------------------------------------------------------------
// Bulk query helpers — fetch all entities of a type in one paginated pass
//
// These include inactive records (ACTIVE_AND_INACTIVE) so a load can reactivate what Remove test data
// or a rollback made inactive, and avoid inactive names.
// ---------------------------------------------------------------------------

export async function queryAllCustomers(client, { signal } = {}) {
  // "*" includes the tag field (MASTER_DATA_TAG_FIELDS)
  return queryAll(client, "Customer", "*", ACTIVE_AND_INACTIVE, undefined, { signal });
}

export async function queryAllVendors(client, { signal } = {}) {
  return queryAll(client, "Vendor", "*", ACTIVE_AND_INACTIVE, undefined, { signal });
}

export async function queryAllEmployees(client, { signal } = {}) {
  return queryAll(client, "Employee", "*", ACTIVE_AND_INACTIVE, undefined, { signal });
}

export async function queryAllItems(client, { signal } = {}) {
  // Description carries the tag (MASTER_DATA_TAG_FIELDS)
  return queryAll(
    client,
    "Item",
    "Id, SyncToken, Name, Description, Active",
    ACTIVE_AND_INACTIVE,
    undefined,
    { signal }
  );
}
