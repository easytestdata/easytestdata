import {
  ensureServiceItem,
  ensureAccount,
  getChartOfAccounts,
  partyTag,
  selectBankAccount,
  selectCreditCardAccount,
  queryAllCustomers,
  queryAllVendors,
  queryAllEmployees,
  queryAllItems
} from "./qbo-repository.js";
import { isGeneratedRecord } from "./generated-identity.js";

import { resolveConfig } from "@easytestdata/core";
import { batchCreate } from "./batch-helper.js";
import { LoadLedger } from "./load-ledger.js";

// ---------------------------------------------------------------------------
// Abort signal check -- throws if the client disconnected
// ---------------------------------------------------------------------------

function checkAbort(signal) {
  if (signal?.aborted) {
    throw new Error("Operation cancelled: client disconnected.");
  }
}

// ---------------------------------------------------------------------------
// Phase 1: Resolve / create all accounts
// ---------------------------------------------------------------------------

// `onCreated(results)` receives every account this phase creates or reactivates, as it happens.
async function resolveAccounts(client, plan, config, signal, onCreated = () => {}) {
  checkAbort(signal);
  const accounts = await getChartOfAccounts(client, { signal });
  const accountByName = new Map(accounts.map((a) => [a.Name, a]));

  // Collect all accounts we need: { name, accountType, subType }
  const neededAccounts = [];

  for (const item of config.serviceItems) {
    neededAccounts.push({
      name: `${plan.tag} ${item.name}`,
      accountType: item.accountType,
      subType: item.subType
    });
  }
  for (const cat of config.expenseCategories) {
    neededAccounts.push({
      name: `${plan.tag} ${cat.name}`,
      accountType: cat.accountType,
      subType: cat.subType
    });
  }

  // Fixed accounts
  const fixedAccounts = [
    { name: `${plan.tag} Depreciation`, accountType: "Other Expense", subType: "Depreciation" },
    {
      name: `${plan.tag} Accrued Liabilities`,
      accountType: "Other Current Liability",
      subType: "OtherCurrentLiabilities"
    },
    {
      name: `${plan.tag} Accrued Expenses`,
      accountType: "Other Expense",
      subType: "OtherMiscellaneousExpense"
    }
  ];

  // Bank / CC accounts — only create tagged versions if defaults not found
  if (!selectBankAccount(accounts, "Checking")) {
    fixedAccounts.push({ name: `${plan.tag} Checking`, accountType: "Bank", subType: "Checking" });
  }
  if (!selectBankAccount(accounts, "Savings")) {
    fixedAccounts.push({ name: `${plan.tag} Savings`, accountType: "Bank", subType: "Savings" });
  }
  if (!selectCreditCardAccount(accounts)) {
    fixedAccounts.push({
      name: `${plan.tag} Credit Card`,
      accountType: "Credit Card",
      subType: "CreditCard"
    });
  }
  if (!accounts.find((a) => a.Name === "Undeposited Funds" && a.Active !== false)) {
    fixedAccounts.push({
      name: "Undeposited Funds",
      accountType: "Other Current Asset",
      subType: "UndepositedFunds"
    });
  }

  // Payroll accounts
  const payrollCategories = [];
  if (plan.payroll && plan.payroll.length > 0) {
    payrollCategories.push(
      { name: `${plan.tag} Salaries & Wages`, accountType: "Expense", subType: "PayrollExpenses" },
      { name: `${plan.tag} Payroll Taxes`, accountType: "Expense", subType: "TaxesPaid" }
    );
    if (plan.includeBenefits) {
      payrollCategories.push(
        { name: `${plan.tag} Health Insurance`, accountType: "Expense", subType: "Insurance" },
        { name: `${plan.tag} Dental Insurance`, accountType: "Expense", subType: "Insurance" }
      );
    }
  }

  neededAccounts.push(...fixedAccounts, ...payrollCategories);

  // Separate into existing (already in chart) vs missing (need to create)
  const resolvedByName = new Map();
  const toCreate = [];

  for (const acct of neededAccounts) {
    const existing = accountByName.get(acct.name);
    if (existing) {
      resolvedByName.set(acct.name, existing);
    } else {
      toCreate.push(acct);
    }
  }

  // Reactivate inactive accounts that we need (requires individual update calls)
  // Note: getChartOfAccounts filters Active=true, so if we didn't find it, it's either
  // inactive or truly missing. Query for inactive ones individually only if needed.
  // For simplicity and to avoid a second full query, batch-create missing ones.
  // QBO will return a DuplicateNameError if an inactive account exists with that name,
  // in which case we fall back to ensureAccount for those specific ones.

  if (toCreate.length > 0) {
    checkAbort(signal);
    const batchItems = toCreate.map((acct, i) => {
      const payload = { Name: acct.name, AccountType: acct.accountType };
      if (acct.subType) payload.AccountSubType = acct.subType;
      return { payload, originalIndex: i, ref: acct.name };
    });
    const result = await batchCreate(client, "account", batchItems, {
      signal,
      entityLabel: "Account",
      onCreated
    });

    for (const r of result.results) {
      resolvedByName.set(toCreate[r.originalIndex].name, r.entity);
    }

    // Fall back to ensureAccount for any that failed (e.g. inactive account with same name)
    for (const f of result.failures) {
      const acct = toCreate.find((a) => a.name === f.ref);
      if (acct && !resolvedByName.has(acct.name)) {
        checkAbort(signal);
        const resolved = await ensureAccount(client, acct.name, acct.accountType, acct.subType);
        resolvedByName.set(acct.name, resolved);
        // Not in the active chart read above: ensureAccount created or reactivated it.
        if (resolved?.Id && !accounts.some((a) => a.Id === resolved.Id)) {
          onCreated([{ entity: resolved }]);
        }
      }
    }
  }

  // Build result maps
  const incomeAccountMap = new Map();
  for (const item of config.serviceItems) {
    const accountName = `${plan.tag} ${item.name}`;
    incomeAccountMap.set(accountName, resolvedByName.get(accountName));
  }

  const expenseAccountMap = new Map();
  for (const cat of config.expenseCategories) {
    const accountName = `${plan.tag} ${cat.name}`;
    expenseAccountMap.set(accountName, resolvedByName.get(accountName));
  }

  const checkingAccount =
    selectBankAccount(accounts, "Checking") || resolvedByName.get(`${plan.tag} Checking`);
  const savingsAccount =
    selectBankAccount(accounts, "Savings") || resolvedByName.get(`${plan.tag} Savings`);
  const ccAccount =
    selectCreditCardAccount(accounts) || resolvedByName.get(`${plan.tag} Credit Card`);
  const undepositedFunds =
    accounts.find((a) => a.Name === "Undeposited Funds" && a.Active !== false) ||
    resolvedByName.get("Undeposited Funds");

  const payrollAccountMap = new Map();
  for (const cat of payrollCategories) {
    payrollAccountMap.set(cat.name, resolvedByName.get(cat.name));
  }

  const depreciationAccount = resolvedByName.get(`${plan.tag} Depreciation`);
  const accruedLiabilities = resolvedByName.get(`${plan.tag} Accrued Liabilities`);
  const accrualExpenseAccount = resolvedByName.get(`${plan.tag} Accrued Expenses`);

  // Validate required accounts — fail early with a clear message rather than
  // crashing mid-load with a cryptic TypeError after hundreds of entities exist
  const missing = [];
  if (!checkingAccount?.Id) missing.push("Checking");
  if (!savingsAccount?.Id) missing.push("Savings");
  if (!ccAccount?.Id) missing.push("Credit Card");
  if (!undepositedFunds?.Id) missing.push("Undeposited Funds");
  if (!depreciationAccount?.Id) missing.push("Depreciation");
  if (!accruedLiabilities?.Id) missing.push("Accrued Liabilities");
  if (!accrualExpenseAccount?.Id) missing.push("Accrued Expenses");
  if (missing.length > 0) {
    throw new Error(`Failed to resolve required accounts: ${missing.join(", ")}. Cannot continue.`);
  }

  return {
    incomeAccountMap,
    expenseAccountMap,
    payrollAccountMap,
    checkingAccount,
    savingsAccount,
    ccAccount,
    undepositedFunds,
    depreciationAccount,
    accruedLiabilities,
    accrualExpenseAccount
  };
}

// ---------------------------------------------------------------------------
// Phase 2 helper: ensure entities exist (reactivate inactive, batch-create missing)
// ---------------------------------------------------------------------------

const MAX_DISPLAY_NAME = 100;

/**
 * QBO display names are unique across customers, vendors and employees together. A generated
 * party whose name is already taken (by a record this load will not reuse) is created as
 * "Name (TAG)", then "Name (TAG 2)", ...; the chosen name is reserved in `takenNames`.
 */
export function uniqueDisplayName(name, tag, takenNames) {
  return resolveGeneratedName(name, tag, takenNames, new Map(), () => false).displayName;
}

// The n-th name tried for a generated record: "Name", "Name (TAG)", "Name (TAG 2)", ...
function nameCandidate(name, tag, n) {
  if (n === 0) return name.slice(0, MAX_DISPLAY_NAME);
  const suffix = n === 1 ? ` (${tag})` : ` (${tag} ${n})`;
  return name.slice(0, MAX_DISPLAY_NAME - suffix.length) + suffix;
}

/**
 * Walks the names a generated record can have (see uniqueDisplayName). Returns
 * `{ existing }` for the first record in `existingByName` that `isGenerated` accepts, so a
 * record an earlier load created as "Name (TAG)" is reused; otherwise `{ displayName }`, the
 * first free name, reserved in `takenNames` (upper-cased names).
 */
export function resolveGeneratedName(name, tag, takenNames, existingByName, isGenerated) {
  for (let n = 0; ; n++) {
    const candidate = nameCandidate(name, tag, n);
    const existing = existingByName.get(candidate);
    if (existing && isGenerated(existing)) return { existing };
    if (!takenNames.has(candidate.toUpperCase())) {
      takenNames.add(candidate.toUpperCase());
      return { displayName: candidate };
    }
  }
}

function withDisplayName(payload, displayName) {
  if (payload.DisplayName === displayName) return payload;
  const renamed = { ...payload, DisplayName: displayName };
  // Customers and vendors show CompanyName too: keep it matching the distinct display name.
  if (renamed.CompanyName) renamed.CompanyName = displayName;
  if (renamed.PrintOnCheckName) renamed.PrintOnCheckName = displayName;
  return renamed;
}

async function ensureEntities(
  client,
  entityType,
  parties,
  existingMap,
  { buildPayload, signal, tag, takenNames, onProgress = () => {}, onCreated = () => {} }
) {
  const idByName = new Map();
  let created = 0;
  let reactivated = 0;
  let failures = [];
  const missing = [];
  const label = entityType.charAt(0).toUpperCase() + entityType.slice(1);

  for (const party of parties) {
    const name = party.name;
    if (idByName.has(name)) continue;
    // Only a record this tool created (it carries the tag) is reused, also when an earlier load
    // had to create it as "Name (TAG)". An unrelated record with the same realistic name is left
    // alone and the generated party gets a distinct name, so transactions never attach to it and
    // purge can find everything that was created.
    const { existing, displayName } = resolveGeneratedName(
      name,
      tag,
      takenNames,
      existingMap,
      (record) => isGeneratedRecord(label, record, tag)
    );
    if (existing) {
      if (existing.Active === false) {
        checkAbort(signal);
        onProgress(`Reactivating ${entityType} ${idByName.size + 1}...`);
        const updated = await client.update(entityType, {
          Id: existing.Id,
          SyncToken: existing.SyncToken,
          sparse: true,
          Active: true
        });
        const value = updated?.[label] || updated?.[entityType];
        idByName.set(name, (value || existing).Id);
        onCreated([{ entity: value || existing }]);
        reactivated += 1;
      } else {
        idByName.set(name, existing.Id);
      }
    } else {
      missing.push({ party, displayName });
    }
  }

  if (missing.length > 0) {
    onProgress(`Creating ${missing.length} new ${entityType}s...`);
    const batchItems = missing.map(({ party, displayName }, i) => ({
      payload: withDisplayName(buildPayload(party), displayName),
      originalIndex: i,
      ref: displayName
    }));
    const result = await batchCreate(client, entityType, batchItems, {
      signal,
      onProgress: (done, total) => onProgress(`Creating ${entityType}s... ${done} of ${total}`),
      entityLabel: label,
      onCreated
    });
    for (const r of result.results) {
      idByName.set(missing[r.originalIndex].party.name, r.entity.Id);
    }
    created = result.count;
    // Kept so the load reports why a party is missing, not only the transactions that needed it.
    failures = result.failures;
  }

  return { idByName, created, reactivated, failures };
}

// ---------------------------------------------------------------------------
// Phase 2: Master data -- customers, vendors, employees
//
// Every created record carries the plan tag in a tag field (see
// MASTER_DATA_TAG_FIELDS) so purge can find it without relying on its name.
// ---------------------------------------------------------------------------

function toQboAddress(address = {}) {
  return {
    Line1: address.line1,
    City: address.city,
    CountrySubDivisionCode: address.region,
    PostalCode: address.postalCode,
    Country: address.country
  };
}

export function customerPayload(party, tag) {
  return {
    DisplayName: party.name,
    CompanyName: party.name,
    Notes: `${partyTag(tag, party.id)} (generated by EasyTestData)`,
    PrimaryEmailAddr: { Address: party.email },
    PrimaryPhone: { FreeFormNumber: party.phone },
    BillAddr: toQboAddress(party.address)
  };
}

export function vendorPayload(party, tag) {
  return {
    DisplayName: party.name,
    CompanyName: party.name,
    PrintOnCheckName: party.name,
    AcctNum: partyTag(tag, party.id),
    PrimaryEmailAddr: { Address: party.email },
    PrimaryPhone: { FreeFormNumber: party.phone },
    BillAddr: toQboAddress(party.address)
  };
}

export function employeePayload(party, tag) {
  return {
    DisplayName: party.name,
    GivenName: party.givenName,
    FamilyName: party.familyName,
    EmployeeNumber: partyTag(tag, party.id),
    PrimaryEmailAddr: { Address: party.email },
    PrimaryPhone: { FreeFormNumber: party.phone },
    PrimaryAddr: toQboAddress(party.address)
  };
}

// `track(entityType)` builds the ledger hook for records this phase creates or reactivates.
async function loadMasterData(client, plan, config, signal, onProgress, track) {
  onProgress("Querying existing customers, vendors, employees...");
  checkAbort(signal);
  const [existingCustomers, existingVendors, existingEmployees] = await Promise.all([
    queryAllCustomers(client, { signal }),
    queryAllVendors(client, { signal }),
    queryAllEmployees(client, { signal })
  ]);

  const existingCustomerMap = new Map(existingCustomers.map((c) => [c.DisplayName, c]));
  const existingVendorMap = new Map(existingVendors.map((v) => [v.DisplayName, v]));
  const existingEmployeeMap = new Map(existingEmployees.map((e) => [e.DisplayName, e]));
  // Every display name already in use (any of the three types): a party that is not reused
  // must not take one of them.
  const takenNames = new Set(
    [...existingCustomers, ...existingVendors, ...existingEmployees]
      .map((record) => String(record.DisplayName || "").toUpperCase())
      .filter(Boolean)
  );

  const customers = await ensureEntities(client, "customer", plan.customers, existingCustomerMap, {
    signal,
    onProgress,
    tag: plan.tag,
    takenNames,
    onCreated: track("customer"),
    buildPayload: (party) => customerPayload(party, plan.tag)
  });

  const allVendors = plan.payrollVendor ? [...plan.vendors, plan.payrollVendor] : plan.vendors;
  const vendors = await ensureEntities(client, "vendor", allVendors, existingVendorMap, {
    signal,
    onProgress,
    tag: plan.tag,
    takenNames,
    onCreated: track("vendor"),
    buildPayload: (party) => vendorPayload(party, plan.tag)
  });

  const employees = await ensureEntities(client, "employee", plan.employees, existingEmployeeMap, {
    signal,
    onProgress,
    tag: plan.tag,
    takenNames,
    onCreated: track("employee"),
    buildPayload: (party) => employeePayload(party, plan.tag)
  });

  return {
    customerIdByName: customers.idByName,
    vendorIdByName: vendors.idByName,
    employeeIdByName: employees.idByName,
    failures: [...customers.failures, ...vendors.failures, ...employees.failures],
    counts: {
      customersCreated: customers.created,
      customersReactivated: customers.reactivated,
      vendorsCreated: vendors.created,
      vendorsReactivated: vendors.reactivated,
      employeesCreated: employees.created,
      employeesReactivated: employees.reactivated
    }
  };
}

// ---------------------------------------------------------------------------
// Phase 3: Service items (names up to 100 characters)
// ---------------------------------------------------------------------------

async function loadServiceItems(
  client,
  plan,
  config,
  incomeAccountMap,
  signal,
  onProgress = () => {},
  onCreated = () => {}
) {
  checkAbort(signal);
  onProgress("Querying existing service items...");
  const existingItems = await queryAllItems(client, { signal });
  const existingItemMap = new Map(existingItems.map((i) => [i.Name, i]));
  const takenItemNames = new Set(
    existingItems.map((i) => String(i.Name || "").toUpperCase()).filter(Boolean)
  );

  const itemIdByName = new Map();
  const toCreate = [];
  const toReactivate = [];

  for (const item of config.serviceItems) {
    const itemName = `${plan.tag}-${item.suffix}`;
    const accountName = `${plan.tag} ${item.name}`;
    const incomeAccount = incomeAccountMap.get(accountName);
    if (!incomeAccount?.Id) {
      throw new Error(
        `Income account not found for "${accountName}". Account setup may have failed.`
      );
    }

    // As with parties: only an item this tool created (Description carries the tag) is reused
    // or reactivated. An unrelated item holding the name is left alone and the generated item
    // is created as "Name (TAG)", which a later load finds and reuses.
    const { existing, displayName } = resolveGeneratedName(
      itemName,
      plan.tag,
      takenItemNames,
      existingItemMap,
      (record) => isGeneratedRecord("Item", record, plan.tag)
    );
    if (existing) {
      if (existing.Active === false) {
        toReactivate.push({ itemName, existing });
      } else {
        itemIdByName.set(itemName, existing.Id);
      }
    } else {
      toCreate.push({
        itemName,
        safeName: displayName,
        incomeAccountId: incomeAccount.Id
      });
    }
  }

  // Reactivate inactive items (requires individual update calls for SyncToken)
  for (const { itemName, existing } of toReactivate) {
    checkAbort(signal);
    const updated = await client.update("item", {
      Id: existing.Id,
      SyncToken: existing.SyncToken,
      sparse: true,
      Active: true
    });
    const value = updated?.Item || updated?.item;
    itemIdByName.set(itemName, (value || existing).Id);
    onCreated([{ entity: value || existing }]);
  }

  // Batch-create missing items
  if (toCreate.length > 0) {
    onProgress(`Creating ${toCreate.length} new service items...`);
    const batchItems = toCreate.map((entry, i) => ({
      payload: {
        Name: entry.safeName,
        Type: "Service",
        IncomeAccountRef: { value: entry.incomeAccountId },
        Description: plan.tag,
        Active: true
      },
      originalIndex: i,
      ref: entry.safeName
    }));
    const result = await batchCreate(client, "item", batchItems, {
      signal,
      onProgress: (done, total) => onProgress(`Creating service items... ${done} of ${total}`),
      entityLabel: "Item",
      onCreated
    });
    for (const r of result.results) {
      itemIdByName.set(toCreate[r.originalIndex].itemName, r.entity.Id);
    }

    // Fall back to ensureServiceItem for any failures (e.g. inactive item name collision)
    for (const f of result.failures) {
      const entry = toCreate.find((e) => e.safeName === f.ref);
      if (entry && !itemIdByName.has(entry.itemName)) {
        checkAbort(signal);
        const fallback = await ensureServiceItem(
          client,
          entry.safeName,
          entry.incomeAccountId,
          plan.tag
        );
        if (fallback?.item?.Id) {
          itemIdByName.set(entry.itemName, fallback.item.Id);
          if (fallback.created || fallback.reactivated) onCreated([{ entity: fallback.item }]);
        } else {
          throw new Error(
            `Failed to resolve service item "${entry.safeName}". Both batch create and individual create returned no item.`
          );
        }
      }
    }
  }

  return itemIdByName;
}

// ---------------------------------------------------------------------------
// Phase 4: Estimates & Purchase Orders
// ---------------------------------------------------------------------------

async function loadEstimates(
  client,
  plan,
  customerIdByName,
  itemIdByName,
  signal,
  onProgress = () => {},
  onCreated
) {
  const batchItems = [];
  for (const est of plan.estimates) {
    if (est.amount <= 0) continue;
    const customerId = customerIdByName.get(est.customerName);
    const itemId = itemIdByName.get(est.serviceItemName);
    if (!customerId || !itemId) continue;
    batchItems.push({
      payload: {
        CustomerRef: { value: customerId },
        TxnDate: est.txnDate,
        DocNumber: est.docNumber,
        PrivateNote: plan.tag,
        Line: [
          {
            Amount: est.amount,
            DetailType: "SalesItemLineDetail",
            Description: `${plan.tag} estimate`,
            SalesItemLineDetail: {
              ItemRef: { value: itemId }
            }
          }
        ]
      },
      ref: est.docNumber
    });
  }
  if (batchItems.length === 0) return { results: [], count: 0, failures: [] };
  const result = await batchCreate(client, "estimate", batchItems, {
    signal,
    onProgress: (done, total) => onProgress(`Creating estimates... ${done} of ${total}`),
    entityLabel: "Estimate",
    onCreated
  });
  return { results: result.results, count: result.count, failures: result.failures };
}

async function loadPurchaseOrders(
  client,
  plan,
  vendorIdByName,
  expenseAccountMap,
  signal,
  onProgress = () => {},
  onCreated
) {
  const batchItems = [];
  for (const po of plan.purchaseOrders) {
    if (po.amount <= 0) continue;
    const vendorId = vendorIdByName.get(po.vendorName);
    const accountRef = expenseAccountMap.get(po.expenseCategory);
    if (!vendorId || !accountRef?.Id) continue;
    batchItems.push({
      payload: {
        VendorRef: { value: vendorId },
        TxnDate: po.txnDate,
        DocNumber: po.docNumber,
        PrivateNote: plan.tag,
        Line: [
          {
            Amount: po.amount,
            DetailType: "AccountBasedExpenseLineDetail",
            Description: `${plan.tag} purchase order`,
            AccountBasedExpenseLineDetail: {
              AccountRef: { value: accountRef.Id }
            }
          }
        ]
      },
      ref: po.docNumber
    });
  }
  if (batchItems.length === 0) return { results: [], count: 0, failures: [] };
  const result = await batchCreate(client, "purchaseorder", batchItems, {
    signal,
    onProgress: (done, total) => onProgress(`Creating purchase orders... ${done} of ${total}`),
    entityLabel: "PurchaseOrder",
    onCreated
  });
  return { results: result.results, count: result.count, failures: result.failures };
}

// ---------------------------------------------------------------------------
// Phase 5: Base transactions -- invoices & bills (multi-line)
// ---------------------------------------------------------------------------

async function loadInvoices(
  client,
  plan,
  customerIdByName,
  itemIdByName,
  signal,
  onProgress = () => {},
  onCreated
) {
  const createdIds = new Array(plan.invoices.length).fill(null);
  const failures = [];
  const batchItems = [];

  for (let i = 0; i < plan.invoices.length; i++) {
    const invoice = plan.invoices[i];
    if (invoice.amount <= 0) continue;
    const customerId = customerIdByName.get(invoice.customerName);
    if (!customerId) {
      failures.push({
        entity: "Invoice",
        ref: invoice.docNumber,
        message: `Customer not found: ${invoice.customerName}`
      });
      continue;
    }

    const lines = invoice.lines
      .filter((line) => line.amount > 0)
      .map((line) => ({
        Amount: line.amount,
        DetailType: "SalesItemLineDetail",
        Description: `${plan.tag} generated revenue`,
        SalesItemLineDetail: {
          ItemRef: { value: itemIdByName.get(line.serviceItemName) }
        }
      }));

    if (lines.length === 0) continue;

    batchItems.push({
      payload: {
        CustomerRef: { value: customerId },
        TxnDate: invoice.txnDate,
        DueDate: invoice.dueDate,
        DocNumber: invoice.docNumber,
        PrivateNote: plan.tag,
        Line: lines
      },
      originalIndex: i,
      ref: invoice.docNumber
    });
  }

  if (batchItems.length === 0) return { results: [], createdIds, count: 0, failures };

  const result = await batchCreate(client, "invoice", batchItems, {
    signal,
    onProgress: (done, total) => onProgress(`Creating invoices... ${done} of ${total}`),
    entityLabel: "Invoice",
    onCreated
  });

  for (const r of result.results) {
    createdIds[r.originalIndex] = r.entity.Id;
  }

  return {
    results: result.results,
    createdIds,
    count: result.count,
    failures: [...failures, ...result.failures]
  };
}

async function loadBills(
  client,
  plan,
  vendorIdByName,
  expenseAccountMap,
  signal,
  onProgress = () => {},
  onCreated
) {
  const createdIds = new Array(plan.bills.length).fill(null);
  const failures = [];
  const batchItems = [];

  for (let i = 0; i < plan.bills.length; i++) {
    const bill = plan.bills[i];
    if (bill.amount <= 0) continue;
    const vendorId = vendorIdByName.get(bill.vendorName);
    if (!vendorId) {
      failures.push({
        entity: "Bill",
        ref: bill.docNumber,
        message: `Vendor not found: ${bill.vendorName}`
      });
      continue;
    }

    const lines = bill.lines
      .filter((line) => line.amount > 0)
      .map((line) => ({
        Amount: line.amount,
        DetailType: "AccountBasedExpenseLineDetail",
        Description: `${plan.tag} generated operating expense`,
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: expenseAccountMap.get(line.expenseCategory)?.Id }
        }
      }));

    if (lines.length === 0) continue;

    batchItems.push({
      payload: {
        VendorRef: { value: vendorId },
        TxnDate: bill.txnDate,
        DocNumber: bill.docNumber,
        PrivateNote: plan.tag,
        Line: lines
      },
      originalIndex: i,
      ref: bill.docNumber
    });
  }

  if (batchItems.length === 0) return { results: [], createdIds, count: 0, failures };

  const result = await batchCreate(client, "bill", batchItems, {
    signal,
    onProgress: (done, total) => onProgress(`Creating bills... ${done} of ${total}`),
    entityLabel: "Bill",
    onCreated
  });

  for (const r of result.results) {
    createdIds[r.originalIndex] = r.entity.Id;
  }

  return {
    results: result.results,
    createdIds,
    count: result.count,
    failures: [...failures, ...result.failures]
  };
}

// ---------------------------------------------------------------------------
// Phase 6: Cash sales & direct expenses
// ---------------------------------------------------------------------------

async function loadSalesReceipts(
  client,
  plan,
  customerIdByName,
  itemIdByName,
  undepositedFundsId,
  signal,
  onProgress = () => {},
  onCreated
) {
  const createdIds = new Array(plan.salesReceipts.length).fill(null);
  const failures = [];
  const batchItems = [];

  for (let i = 0; i < plan.salesReceipts.length; i++) {
    const sr = plan.salesReceipts[i];
    if (sr.amount <= 0) continue;
    const customerId = customerIdByName.get(sr.customerName);
    const itemId = itemIdByName.get(sr.serviceItemName);
    if (!customerId || !itemId) continue;

    batchItems.push({
      payload: {
        CustomerRef: { value: customerId },
        TxnDate: sr.txnDate,
        PrivateNote: plan.tag,
        DepositToAccountRef: { value: undepositedFundsId },
        Line: [
          {
            Amount: sr.amount,
            DetailType: "SalesItemLineDetail",
            Description: `${plan.tag} cash sale`,
            SalesItemLineDetail: {
              ItemRef: { value: itemId }
            }
          }
        ]
      },
      originalIndex: i,
      ref: `SR-${i + 1}`
    });
  }

  if (batchItems.length === 0) return { results: [], createdIds, count: 0, failures };

  const result = await batchCreate(client, "salesreceipt", batchItems, {
    signal,
    onProgress: (done, total) => onProgress(`Creating sales receipts... ${done} of ${total}`),
    entityLabel: "SalesReceipt",
    onCreated
  });

  for (const r of result.results) {
    createdIds[r.originalIndex] = r.entity.Id;
  }

  return {
    results: result.results,
    createdIds,
    count: result.count,
    failures: [...failures, ...result.failures]
  };
}

async function loadDirectExpenses(
  client,
  plan,
  vendorIdByName,
  expenseAccountMap,
  ccAccountId,
  checkingAccountId,
  signal,
  onProgress = () => {},
  onCreated
) {
  const batchItems = [];
  for (const expense of plan.directExpenses) {
    if (expense.amount <= 0) continue;
    const accountRef = expenseAccountMap.get(expense.expenseCategory);
    const vendorId = vendorIdByName.get(expense.vendorName);
    if (!vendorId || !accountRef?.Id) continue;
    const payAccountId = expense.paymentType === "CreditCard" ? ccAccountId : checkingAccountId;
    batchItems.push({
      payload: {
        PaymentType: expense.paymentType,
        AccountRef: { value: payAccountId },
        TxnDate: expense.txnDate,
        PrivateNote: plan.tag,
        EntityRef: {
          value: vendorId,
          type: "Vendor"
        },
        Line: [
          {
            Amount: expense.amount,
            DetailType: "AccountBasedExpenseLineDetail",
            Description: `${plan.tag} direct expense`,
            AccountBasedExpenseLineDetail: {
              AccountRef: { value: accountRef.Id }
            }
          }
        ]
      },
      ref: `EXP-${batchItems.length + 1}`
    });
  }
  if (batchItems.length === 0) return { results: [], count: 0, failures: [] };
  const result = await batchCreate(client, "purchase", batchItems, {
    signal,
    onProgress: (done, total) => onProgress(`Creating direct expenses... ${done} of ${total}`),
    entityLabel: "DirectExpense",
    onCreated
  });
  return { results: result.results, count: result.count, failures: result.failures };
}

// ---------------------------------------------------------------------------
// Phase 7: Payroll -- semi-monthly payroll checks
// ---------------------------------------------------------------------------

async function loadPayroll(
  client,
  plan,
  vendorIdByName,
  payrollAccountMap,
  checkingAccountId,
  signal,
  onProgress = () => {},
  onCreated
) {
  if (!plan.payroll || plan.payroll.length === 0) return { results: [], count: 0, failures: [] };

  const payrollVendorName = plan.payrollVendor?.name;
  const payrollVendorId = vendorIdByName.get(payrollVendorName);
  if (!payrollVendorId) {
    return {
      results: [],
      count: 0,
      failures: [
        {
          entity: "Payroll",
          ref: "payroll-vendor-missing",
          message: `Payroll vendor not found: ${payrollVendorName}`
        }
      ]
    };
  }
  const batchItems = [];

  for (const run of plan.payroll) {
    if (run.totalAmount <= 0) continue;

    const lines = run.lines
      .filter((line) => line.amount > 0)
      .map((line) => ({
        Amount: line.amount,
        DetailType: "AccountBasedExpenseLineDetail",
        Description: `${plan.tag} payroll`,
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: payrollAccountMap.get(line.accountName)?.Id }
        }
      }));

    if (lines.length === 0) continue;

    batchItems.push({
      payload: {
        PaymentType: "Check",
        AccountRef: { value: checkingAccountId },
        TxnDate: run.txnDate,
        PrivateNote: plan.tag,
        EntityRef: {
          value: payrollVendorId,
          type: "Vendor"
        },
        Line: lines
      },
      ref: `PAY-${batchItems.length + 1}`
    });
  }

  if (batchItems.length === 0) return { results: [], count: 0, failures: [] };
  const result = await batchCreate(client, "purchase", batchItems, {
    signal,
    onProgress: (done, total) => onProgress(`Creating payroll checks... ${done} of ${total}`),
    entityLabel: "Payroll",
    onCreated
  });
  return { results: result.results, count: result.count, failures: result.failures };
}

// ---------------------------------------------------------------------------
// Phase 8: Settlements -- payments & bill payments
// ---------------------------------------------------------------------------

async function loadPayments(
  client,
  plan,
  customerIdByName,
  invoiceIds,
  undepositedFundsId,
  signal,
  onProgress = () => {},
  onCreated
) {
  const createdIds = new Array(plan.payments.length).fill(null);
  const failures = [];
  const batchItems = [];

  for (let i = 0; i < plan.payments.length; i++) {
    const payment = plan.payments[i];
    const invoiceId = invoiceIds[payment.invoiceIndex];
    const customerId = customerIdByName.get(payment.customerName);
    if (!invoiceId || !customerId || payment.amount <= 0) continue;

    batchItems.push({
      payload: {
        CustomerRef: { value: customerId },
        TotalAmt: payment.amount,
        TxnDate: payment.txnDate,
        PrivateNote: plan.tag,
        DepositToAccountRef: { value: undepositedFundsId },
        Line: [
          {
            Amount: payment.amount,
            LinkedTxn: [{ TxnId: invoiceId, TxnType: "Invoice", TxnLineId: "0" }]
          }
        ]
      },
      originalIndex: i,
      ref: `PMT-${i + 1}`
    });
  }

  if (batchItems.length === 0) return { results: [], createdIds, count: 0, failures };

  const result = await batchCreate(client, "payment", batchItems, {
    signal,
    onProgress: (done, total) => onProgress(`Recording payments... ${done} of ${total}`),
    entityLabel: "Payment",
    onCreated
  });

  for (const r of result.results) {
    createdIds[r.originalIndex] = r.entity.Id;
  }

  return {
    results: result.results,
    createdIds,
    count: result.count,
    failures: [...failures, ...result.failures]
  };
}

async function loadBillPayments(
  client,
  plan,
  vendorIdByName,
  billIds,
  checkingAccountId,
  signal,
  onProgress = () => {},
  onCreated
) {
  const batchItems = [];
  for (const bp of plan.billPayments) {
    const billId = billIds[bp.billIndex];
    const vendorId = vendorIdByName.get(bp.vendorName);
    if (!billId || !vendorId || bp.amount <= 0) continue;
    batchItems.push({
      payload: {
        VendorRef: { value: vendorId },
        TotalAmt: bp.amount,
        TxnDate: bp.txnDate,
        PrivateNote: plan.tag,
        PayType: "Check",
        CheckPayment: {
          BankAccountRef: { value: checkingAccountId }
        },
        Line: [
          {
            Amount: bp.amount,
            LinkedTxn: [{ TxnId: billId, TxnType: "Bill", TxnLineId: "0" }]
          }
        ]
      },
      ref: `BP-${batchItems.length + 1}`
    });
  }
  if (batchItems.length === 0) return { results: [], count: 0, failures: [] };
  const result = await batchCreate(client, "billpayment", batchItems, {
    signal,
    onProgress: (done, total) => onProgress(`Recording bill payments... ${done} of ${total}`),
    entityLabel: "BillPayment",
    onCreated
  });
  return { results: result.results, count: result.count, failures: result.failures };
}

// ---------------------------------------------------------------------------
// Phase 9: Adjustments -- credit memos, refund receipts, vendor credits
// ---------------------------------------------------------------------------

async function loadCreditMemos(
  client,
  plan,
  customerIdByName,
  itemIdByName,
  signal,
  onProgress = () => {},
  onCreated
) {
  const batchItems = [];
  for (const cm of plan.creditMemos) {
    if (cm.amount <= 0) continue;
    const customerId = customerIdByName.get(cm.customerName);
    const itemId = itemIdByName.get(cm.serviceItemName);
    if (!customerId || !itemId) continue;
    batchItems.push({
      payload: {
        CustomerRef: { value: customerId },
        TxnDate: cm.txnDate,
        PrivateNote: plan.tag,
        Line: [
          {
            Amount: cm.amount,
            DetailType: "SalesItemLineDetail",
            Description: `${plan.tag} credit memo`,
            SalesItemLineDetail: {
              ItemRef: { value: itemId }
            }
          }
        ]
      },
      ref: `CM-${batchItems.length + 1}`
    });
  }
  if (batchItems.length === 0) return { results: [], count: 0, failures: [] };
  const result = await batchCreate(client, "creditmemo", batchItems, {
    signal,
    onProgress: (done, total) => onProgress(`Creating credit memos... ${done} of ${total}`),
    entityLabel: "CreditMemo",
    onCreated
  });
  return { results: result.results, count: result.count, failures: result.failures };
}

async function loadRefundReceipts(
  client,
  plan,
  customerIdByName,
  itemIdByName,
  checkingAccountId,
  signal,
  onProgress = () => {},
  onCreated
) {
  const batchItems = [];
  for (const rr of plan.refundReceipts) {
    if (rr.amount <= 0) continue;
    const customerId = customerIdByName.get(rr.customerName);
    const itemId = itemIdByName.get(rr.serviceItemName);
    if (!customerId || !itemId) continue;
    batchItems.push({
      payload: {
        CustomerRef: { value: customerId },
        TxnDate: rr.txnDate,
        PrivateNote: plan.tag,
        DepositToAccountRef: { value: checkingAccountId },
        Line: [
          {
            Amount: rr.amount,
            DetailType: "SalesItemLineDetail",
            Description: `${plan.tag} refund`,
            SalesItemLineDetail: {
              ItemRef: { value: itemId }
            }
          }
        ]
      },
      ref: `RR-${batchItems.length + 1}`
    });
  }
  if (batchItems.length === 0) return { results: [], count: 0, failures: [] };
  const result = await batchCreate(client, "refundreceipt", batchItems, {
    signal,
    onProgress: (done, total) => onProgress(`Creating refund receipts... ${done} of ${total}`),
    entityLabel: "RefundReceipt",
    onCreated
  });
  return { results: result.results, count: result.count, failures: result.failures };
}

async function loadVendorCredits(
  client,
  plan,
  vendorIdByName,
  expenseAccountMap,
  signal,
  onProgress = () => {},
  onCreated
) {
  const batchItems = [];
  for (const vc of plan.vendorCredits) {
    if (vc.amount <= 0) continue;
    const accountRef = expenseAccountMap.get(vc.expenseCategory);
    const vendorId = vendorIdByName.get(vc.vendorName);
    if (!vendorId || !accountRef?.Id) continue;
    batchItems.push({
      payload: {
        VendorRef: { value: vendorId },
        TxnDate: vc.txnDate,
        PrivateNote: plan.tag,
        Line: [
          {
            Amount: vc.amount,
            DetailType: "AccountBasedExpenseLineDetail",
            Description: `${plan.tag} vendor credit`,
            AccountBasedExpenseLineDetail: {
              AccountRef: { value: accountRef.Id }
            }
          }
        ]
      },
      ref: `VC-${batchItems.length + 1}`
    });
  }
  if (batchItems.length === 0) return { results: [], count: 0, failures: [] };
  const result = await batchCreate(client, "vendorcredit", batchItems, {
    signal,
    onProgress: (done, total) => onProgress(`Creating vendor credits... ${done} of ${total}`),
    entityLabel: "VendorCredit",
    onCreated
  });
  return { results: result.results, count: result.count, failures: result.failures };
}

// ---------------------------------------------------------------------------
// Phase 10: Banking -- deposits & transfers (deposits spread across accounts)
// ---------------------------------------------------------------------------

async function loadDeposits(
  client,
  plan,
  paymentIds,
  salesReceiptIds,
  checkingAccountId,
  savingsAccountId,
  signal,
  onProgress = () => {},
  onCreated
) {
  const batchItems = [];
  for (const deposit of plan.deposits) {
    if (deposit.amount <= 0) continue;

    const lines = [];
    for (const lineItem of deposit.lineItems) {
      let txnId = null;
      let txnType = null;
      if (lineItem.type === "payment") {
        txnId = paymentIds[lineItem.index];
        txnType = "Payment";
      } else if (lineItem.type === "salesReceipt") {
        txnId = salesReceiptIds[lineItem.index];
        txnType = "SalesReceipt";
      }
      if (!txnId) continue;

      lines.push({
        Amount: lineItem.amount,
        LinkedTxn: [{ TxnId: txnId, TxnType: txnType, TxnLineId: "0" }]
      });
    }

    if (lines.length === 0) continue;

    const depositAccountId =
      deposit.depositAccountType === "savings" ? savingsAccountId : checkingAccountId;

    batchItems.push({
      payload: {
        DepositToAccountRef: { value: depositAccountId },
        TxnDate: deposit.txnDate,
        PrivateNote: plan.tag,
        Line: lines
      },
      ref: `DEP-${batchItems.length + 1}`
    });
  }
  if (batchItems.length === 0) return { results: [], count: 0, failures: [] };
  const result = await batchCreate(client, "deposit", batchItems, {
    signal,
    onProgress: (done, total) => onProgress(`Creating deposits... ${done} of ${total}`),
    entityLabel: "Deposit",
    onCreated
  });
  return { results: result.results, count: result.count, failures: result.failures };
}

async function loadTransfers(
  client,
  plan,
  checkingAccountId,
  savingsAccountId,
  signal,
  onProgress = () => {},
  onCreated
) {
  const batchItems = [];
  for (const transfer of plan.transfers) {
    if (transfer.amount <= 0) continue;
    batchItems.push({
      payload: {
        FromAccountRef: { value: checkingAccountId },
        ToAccountRef: { value: savingsAccountId },
        Amount: transfer.amount,
        TxnDate: transfer.txnDate,
        PrivateNote: plan.tag
      },
      ref: `TXF-${batchItems.length + 1}`
    });
  }
  if (batchItems.length === 0) return { results: [], count: 0, failures: [] };
  const result = await batchCreate(client, "transfer", batchItems, {
    signal,
    onProgress: (done, total) => onProgress(`Creating transfers... ${done} of ${total}`),
    entityLabel: "Transfer",
    onCreated
  });
  return { results: result.results, count: result.count, failures: result.failures };
}

// ---------------------------------------------------------------------------
// Phase 11: Journal entries -- depreciation & accruals
// ---------------------------------------------------------------------------

async function loadJournalEntries(client, plan, accts, signal, onProgress = () => {}, onCreated) {
  const batchItems = [];
  for (const je of plan.journalEntries) {
    if (je.amount <= 0) continue;

    let debitAccountId, creditAccountId;
    if (je.type === "depreciation") {
      debitAccountId = accts.depreciationAccount.Id;
      creditAccountId = accts.accruedLiabilities.Id;
    } else {
      debitAccountId = accts.accrualExpenseAccount.Id;
      creditAccountId = accts.accruedLiabilities.Id;
    }

    batchItems.push({
      payload: {
        TxnDate: je.txnDate,
        PrivateNote: plan.tag,
        Line: [
          {
            DetailType: "JournalEntryLineDetail",
            Amount: je.amount,
            Description: je.memo,
            JournalEntryLineDetail: {
              PostingType: "Debit",
              AccountRef: { value: debitAccountId }
            }
          },
          {
            DetailType: "JournalEntryLineDetail",
            Amount: je.amount,
            Description: je.memo,
            JournalEntryLineDetail: {
              PostingType: "Credit",
              AccountRef: { value: creditAccountId }
            }
          }
        ]
      },
      ref: `JE-${batchItems.length + 1}`
    });
  }
  if (batchItems.length === 0) return { results: [], count: 0, failures: [] };
  const result = await batchCreate(client, "journalentry", batchItems, {
    signal,
    onProgress: (done, total) => onProgress(`Creating journal entries... ${done} of ${total}`),
    entityLabel: "JournalEntry",
    onCreated
  });
  return { results: result.results, count: result.count, failures: result.failures };
}

// ---------------------------------------------------------------------------
// Orchestrator (11 phases, abort signal, failure aggregation)
// ---------------------------------------------------------------------------

/**
 * Like Promise.all, but waits for every loader to settle before rethrowing the first rejection:
 * when one parallel loader aborts, its siblings keep creating records until they notice the
 * signal, and those records must reach the ledger before the load reports its failure.
 */
async function settleAll(promises) {
  const settled = await Promise.allSettled(promises);
  const failed = settled.find((s) => s.status === "rejected");
  if (failed) throw failed.reason;
  return settled.map((s) => s.value);
}

export async function loadPlanIntoQbo(
  client,
  plan,
  config,
  emit = () => {},
  signal = null,
  onCheckpoint = null
) {
  // The plan records its industry template, so callers may omit config.
  config = config || resolveConfig(plan.meta?.industry || {}, {}, plan.country || "US");
  const STEPS = 11;
  const progress = (step, message) => emit({ step, totalSteps: STEPS, message });
  const allFailures = [];
  const ledger = new LoadLedger();
  // Records each batch's created entities as soon as QBO answers, so an abort mid-phase (even
  // mid-batch) leaves a ledger that covers everything that exists for rollback. Master data
  // (accounts, parties, items) is recorded too, created or reactivated; rollback inactivates the
  // parties and items and leaves accounts in place, as purge does.
  const track = (entityType) => (created) =>
    ledger.recordBatchResults(entityType, { results: created });

  function checkpoint(phase) {
    if (onCheckpoint) {
      try {
        onCheckpoint({ phase, ledger: ledger.toJSON() });
      } catch {
        // Checkpoint failures should not interrupt the load
      }
    }
  }

  try {
    // Phase 1: Accounts
    progress(1, "Setting up chart of accounts...");
    const accts = await resolveAccounts(client, plan, config, signal, track("account"));

    checkpoint(1);

    // Phase 2: Master data
    progress(2, "Creating master data...");
    const master = await loadMasterData(
      client,
      plan,
      config,
      signal,
      (msg) => progress(2, msg),
      track
    );
    allFailures.push(...master.failures);
    checkpoint(2);

    // Phase 3: Service items
    progress(3, "Creating service items...");
    const itemIdByName = await loadServiceItems(
      client,
      plan,
      config,
      accts.incomeAccountMap,
      signal,
      (msg) => progress(3, msg),
      track("item")
    );

    checkpoint(3);

    // Phase 4: Estimates & Purchase Orders (parallel — independent entities)
    progress(4, "Creating estimates & purchase orders...");
    const [estimateResult, poResult] = await settleAll([
      loadEstimates(
        client,
        plan,
        master.customerIdByName,
        itemIdByName,
        signal,
        (msg) => progress(4, msg),
        track("estimate")
      ),
      loadPurchaseOrders(
        client,
        plan,
        master.vendorIdByName,
        accts.expenseAccountMap,
        signal,
        (msg) => progress(4, msg),
        track("purchaseorder")
      )
    ]);
    allFailures.push(...estimateResult.failures);
    allFailures.push(...poResult.failures);

    checkpoint(4);

    // Phase 5: Base transactions (parallel — invoices and bills are independent)
    progress(5, "Creating invoices & bills...");
    const [invoiceResult, billResult] = await settleAll([
      loadInvoices(
        client,
        plan,
        master.customerIdByName,
        itemIdByName,
        signal,
        (msg) => progress(5, msg),
        track("invoice")
      ),
      loadBills(
        client,
        plan,
        master.vendorIdByName,
        accts.expenseAccountMap,
        signal,
        (msg) => progress(5, msg),
        track("bill")
      )
    ]);
    allFailures.push(...invoiceResult.failures);
    allFailures.push(...billResult.failures);

    checkpoint(5);

    // Phase 6: Payroll
    progress(6, "Creating payroll checks...");
    const payrollResult = await loadPayroll(
      client,
      plan,
      master.vendorIdByName,
      accts.payrollAccountMap,
      accts.checkingAccount.Id,
      signal,
      (msg) => progress(6, msg),
      track("purchase")
    );
    allFailures.push(...payrollResult.failures);

    checkpoint(6);

    // Phase 7: Cash sales & direct expenses (parallel — independent entities)
    progress(7, "Creating sales receipts & expenses...");
    const [salesReceiptResult, directExpenseResult] = await settleAll([
      loadSalesReceipts(
        client,
        plan,
        master.customerIdByName,
        itemIdByName,
        accts.undepositedFunds.Id,
        signal,
        (msg) => progress(7, msg),
        track("salesreceipt")
      ),
      loadDirectExpenses(
        client,
        plan,
        master.vendorIdByName,
        accts.expenseAccountMap,
        accts.ccAccount.Id,
        accts.checkingAccount.Id,
        signal,
        (msg) => progress(7, msg),
        track("purchase")
      )
    ]);
    allFailures.push(...salesReceiptResult.failures);
    allFailures.push(...directExpenseResult.failures);

    checkpoint(7);

    // Phase 8: Settlements (parallel — payments and bill payments are independent)
    progress(8, "Recording payments...");
    const [paymentResult, billPaymentResult] = await settleAll([
      loadPayments(
        client,
        plan,
        master.customerIdByName,
        invoiceResult.createdIds,
        accts.undepositedFunds.Id,
        signal,
        (msg) => progress(8, msg),
        track("payment")
      ),
      loadBillPayments(
        client,
        plan,
        master.vendorIdByName,
        billResult.createdIds,
        accts.checkingAccount.Id,
        signal,
        (msg) => progress(8, msg),
        track("billpayment")
      )
    ]);
    allFailures.push(...paymentResult.failures);
    allFailures.push(...billPaymentResult.failures);

    checkpoint(8);

    // Phase 9: Adjustments (parallel — all three are independent)
    progress(9, "Creating adjustments...");
    const [creditMemoResult, refundReceiptResult, vendorCreditResult] = await settleAll([
      loadCreditMemos(
        client,
        plan,
        master.customerIdByName,
        itemIdByName,
        signal,
        (msg) => progress(9, msg),
        track("creditmemo")
      ),
      loadRefundReceipts(
        client,
        plan,
        master.customerIdByName,
        itemIdByName,
        accts.checkingAccount.Id,
        signal,
        (msg) => progress(9, msg),
        track("refundreceipt")
      ),
      loadVendorCredits(
        client,
        plan,
        master.vendorIdByName,
        accts.expenseAccountMap,
        signal,
        (msg) => progress(9, msg),
        track("vendorcredit")
      )
    ]);
    allFailures.push(...creditMemoResult.failures);
    allFailures.push(...refundReceiptResult.failures);
    allFailures.push(...vendorCreditResult.failures);

    checkpoint(9);

    // Phase 10: Banking (parallel — deposits and transfers are independent)
    progress(10, "Creating bank transactions...");
    const [depositResult, transferResult] = await settleAll([
      loadDeposits(
        client,
        plan,
        paymentResult.createdIds,
        salesReceiptResult.createdIds,
        accts.checkingAccount.Id,
        accts.savingsAccount.Id,
        signal,
        (msg) => progress(10, msg),
        track("deposit")
      ),
      loadTransfers(
        client,
        plan,
        accts.checkingAccount.Id,
        accts.savingsAccount.Id,
        signal,
        (msg) => progress(10, msg),
        track("transfer")
      )
    ]);
    allFailures.push(...depositResult.failures);
    allFailures.push(...transferResult.failures);

    checkpoint(10);

    // Phase 11: Journal entries
    progress(11, "Creating journal entries...");
    const journalEntryResult = await loadJournalEntries(
      client,
      plan,
      accts,
      signal,
      (msg) => progress(11, msg),
      track("journalentry")
    );
    allFailures.push(...journalEntryResult.failures);
    checkpoint(11);

    return {
      counts: {
        ...master.counts,
        serviceItemsLoaded: itemIdByName.size,
        estimatesCreated: estimateResult.count,
        purchaseOrdersCreated: poResult.count,
        invoicesCreated: invoiceResult.count,
        billsCreated: billResult.count,
        payrollCreated: payrollResult.count,
        salesReceiptsCreated: salesReceiptResult.count,
        directExpensesCreated: directExpenseResult.count,
        paymentsCreated: paymentResult.count,
        billPaymentsCreated: billPaymentResult.count,
        creditMemosCreated: creditMemoResult.count,
        refundReceiptsCreated: refundReceiptResult.count,
        vendorCreditsCreated: vendorCreditResult.count,
        depositsCreated: depositResult.count,
        transfersCreated: transferResult.count,
        journalEntriesCreated: journalEntryResult.count
      },
      failures: allFailures,
      ledger: ledger.toJSON()
    };
  } catch (err) {
    ledger.markFailed(null, err.message);
    err.ledger = ledger.toJSON();
    throw err;
  }
}
