import {
  DEFAULTS,
  MONTH_OPTIONS,
  cliCommand,
  generatePlan,
  listPresets,
  listTemplates,
  partyName,
  planToCsv,
  planToJson
} from "./core-adapter.js";
import {
  chartSvg,
  escapeHtml,
  fmtDate,
  fmtInt,
  fmtMoney,
  monthlyTable,
  statTilesHtml,
  summarize
} from "./render.js";

const ROW_LIMIT = 50;
const $ = (id) => document.getElementById(id);

const form = $("pg-form");
const els = {
  template: $("pg-template"),
  preset: $("pg-preset"),
  seed: $("pg-seed"),
  status: $("pg-status"),
  error: $("pg-error"),
  stats: $("pg-stats"),
  chart: $("pg-chart"),
  tooltip: $("pg-tooltip"),
  monthly: $("pg-monthly"),
  table: $("pg-table"),
  tableNote: $("pg-table-note"),
  panel: $("pg-panel"),
  command: $("pg-command"),
  copy: $("pg-copy"),
  copyStatus: $("pg-copy-status"),
  dlJson: $("pg-dl-json"),
  jsonSize: $("pg-json-size"),
  dlCsv: $("pg-dl-csv")
};

const templateIds = new Set(listTemplates().map((t) => t.id));
const presetIds = new Set(["none", ...listPresets().map((p) => p.id)]);

let current = null; // { params, plan }
let activeTab = "customers";

// ---------------------------------------------------------------------------
// Params <-> form <-> URL
// ---------------------------------------------------------------------------

function readForm() {
  const months = Number(new FormData(form).get("months")) || DEFAULTS.months;
  const seedRaw = els.seed.value.trim();
  const seed = /^\d+$/.test(seedRaw) ? Math.min(Number(seedRaw), 2147483647) : DEFAULTS.seed;
  return { template: els.template.value, preset: els.preset.value, seed, months };
}

function writeForm(params) {
  els.template.value = params.template;
  els.preset.value = params.preset;
  els.seed.value = String(params.seed);
  for (const input of form.querySelectorAll('input[name="months"]')) {
    input.checked = Number(input.value) === params.months;
  }
}

function paramsFromUrl() {
  const q = new URLSearchParams(window.location.search);
  const template = templateIds.has(q.get("template")) ? q.get("template") : DEFAULTS.template;
  const preset = presetIds.has(q.get("preset")) ? q.get("preset") : DEFAULTS.preset;
  const seed = /^\d+$/.test(q.get("seed") || "") ? Number(q.get("seed")) : DEFAULTS.seed;
  const months = MONTH_OPTIONS.includes(Number(q.get("months")))
    ? Number(q.get("months"))
    : DEFAULTS.months;
  return { template, preset, seed, months };
}

function syncUrl(params) {
  const q = new URLSearchParams({
    template: params.template,
    preset: params.preset,
    seed: String(params.seed),
    months: String(params.months)
  });
  try {
    history.replaceState(null, "", `${window.location.pathname}?${q}`);
  } catch {
    // ignore (e.g. sandboxed previews)
  }
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

function statusBadge(paid, amount) {
  if (amount <= 0) return `<span class="text-slate-500">—</span>`;
  if (paid >= amount - 0.005)
    return `<span class="inline-flex px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700">Paid</span>`;
  if (paid > 0)
    return `<span class="inline-flex px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-50 text-amber-800">Partial</span>`;
  return `<span class="inline-flex px-2 py-0.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-700">Open</span>`;
}

function sumBy(rows, keyFn, valFn) {
  const map = new Map();
  for (const r of rows) map.set(keyFn(r), (map.get(keyFn(r)) || 0) + valFn(r));
  return map;
}

const num = "text-right tabular-nums whitespace-nowrap";

function tableDefs(plan) {
  const invoicePaid = sumBy(
    plan.payments,
    (p) => p.invoiceIndex,
    (p) => p.amount
  );
  const billPaid = sumBy(
    plan.billPayments,
    (p) => p.billIndex,
    (p) => p.amount
  );
  return {
    customers: {
      label: "customers",
      total: plan.customers.length,
      columns: [
        ["Customer", ""],
        ["Invoices", num],
        ["Invoiced", num],
        ["Collected", num],
        ["Open balance", num]
      ],
      rows: () => {
        const count = sumBy(
          plan.invoices,
          (i) => i.customerName,
          () => 1
        );
        const invoiced = sumBy(
          plan.invoices,
          (i) => i.customerName,
          (i) => i.amount
        );
        const collected = sumBy(
          plan.payments,
          (p) => p.customerName,
          (p) => p.amount
        );
        const credited = sumBy(
          plan.creditMemos,
          (c) => c.customerName,
          (c) => c.amount
        );
        return plan.customers.slice(0, ROW_LIMIT).map((party) => {
          const name = partyName(party);
          const inv = invoiced.get(name) || 0;
          const col = collected.get(name) || 0;
          const open = Math.max(0, inv - col - (credited.get(name) || 0));
          return [
            escapeHtml(name),
            fmtInt(count.get(name) || 0),
            fmtMoney(inv),
            fmtMoney(col),
            fmtMoney(open)
          ];
        });
      }
    },
    invoices: {
      label: "invoices",
      total: plan.invoices.length,
      columns: [
        ["No.", "whitespace-nowrap"],
        ["Customer", ""],
        ["Date", "whitespace-nowrap"],
        ["Due", "whitespace-nowrap"],
        ["Lines", num],
        ["Amount", num],
        ["Status", ""]
      ],
      rows: () =>
        plan.invoices
          .slice(0, ROW_LIMIT)
          .map((inv, i) => [
            escapeHtml(inv.docNumber),
            escapeHtml(inv.customerName),
            fmtDate(inv.txnDate),
            fmtDate(inv.dueDate),
            fmtInt(inv.lines.length),
            fmtMoney(inv.amount),
            statusBadge(invoicePaid.get(i) || 0, inv.amount)
          ])
    },
    bills: {
      label: "bills",
      total: plan.bills.length,
      columns: [
        ["No.", "whitespace-nowrap"],
        ["Vendor", ""],
        ["Date", "whitespace-nowrap"],
        ["Expense categories", ""],
        ["Amount", num],
        ["Status", ""]
      ],
      rows: () =>
        plan.bills
          .slice(0, ROW_LIMIT)
          .map((bill, i) => [
            escapeHtml(bill.docNumber),
            escapeHtml(bill.vendorName),
            fmtDate(bill.txnDate),
            escapeHtml(bill.lines.map((l) => l.expenseCategory.replace(/^EZTD /, "")).join(", ")),
            fmtMoney(bill.amount),
            statusBadge(billPaid.get(i) || 0, bill.amount)
          ])
    },
    payments: {
      label: "payments",
      total: plan.payments.length,
      columns: [
        ["Date", "whitespace-nowrap"],
        ["Customer", ""],
        ["Applied to", "whitespace-nowrap"],
        ["Invoice amount", num],
        ["Payment", num]
      ],
      rows: () =>
        plan.payments.slice(0, ROW_LIMIT).map((p) => {
          const inv = plan.invoices[p.invoiceIndex];
          return [
            fmtDate(p.txnDate),
            escapeHtml(p.customerName),
            escapeHtml(inv?.docNumber ?? ""),
            fmtMoney(inv?.amount ?? 0),
            fmtMoney(p.amount)
          ];
        })
    },
    journalEntries: {
      label: "journal entries",
      total: plan.journalEntries.length,
      columns: [
        ["Date", "whitespace-nowrap"],
        ["Type", ""],
        ["Memo", ""],
        ["Amount", num]
      ],
      rows: () =>
        plan.journalEntries
          .slice(0, ROW_LIMIT)
          .map((je) => [
            fmtDate(je.txnDate),
            escapeHtml(je.type.charAt(0).toUpperCase() + je.type.slice(1)),
            escapeHtml(je.memo),
            fmtMoney(je.amount)
          ])
    }
  };
}

function renderTable() {
  if (!current) return;
  const def = tableDefs(current.plan)[activeTab];
  const head = def.columns
    .map(
      ([label, cls]) =>
        `<th scope="col" class="sticky top-0 px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-slate-600 bg-slate-50 ${cls.includes("text-right") ? "text-right" : "text-left"}">${label}</th>`
    )
    .join("");
  const body = def
    .rows()
    .map(
      (cells) =>
        `<tr class="border-t border-slate-100 hover:bg-slate-50">${cells
          .map(
            (c, i) =>
              `<td class="px-4 py-2 whitespace-nowrap text-slate-700 ${def.columns[i][1]}${i === 0 ? " font-medium text-slate-900" : ""}">${c}</td>`
          )
          .join("")}</tr>`
    )
    .join("");
  els.table.innerHTML = `<table class="w-full text-sm"><caption class="sr-only">Generated ${def.label}, first ${Math.min(ROW_LIMIT, def.total)} rows</caption><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  els.tableNote.textContent =
    def.total > ROW_LIMIT
      ? `Showing the first ${ROW_LIMIT} of ${fmtInt(def.total)} ${def.label}. Download the JSON or CSV for everything.`
      : `Showing all ${fmtInt(def.total)} ${def.label}.`;
}

// Accessible tabs: roving tabindex, arrow keys, Home/End.
const tabs = [...document.querySelectorAll(".pg-tab")];
function selectTab(tab, focus) {
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
    t.classList.toggle("border-blue-600", on);
    t.classList.toggle("text-blue-700", on);
    t.classList.toggle("border-transparent", !on);
    t.classList.toggle("text-slate-600", !on);
  }
  els.panel.setAttribute("aria-labelledby", tab.id);
  activeTab = tab.dataset.tab;
  if (focus) tab.focus();
  renderTable();
}
for (const tab of tabs) {
  tab.addEventListener("click", () => selectTab(tab, false));
  tab.addEventListener("keydown", (e) => {
    const i = tabs.indexOf(tab);
    let next = null;
    if (e.key === "ArrowRight") next = tabs[(i + 1) % tabs.length];
    else if (e.key === "ArrowLeft") next = tabs[(i - 1 + tabs.length) % tabs.length];
    else if (e.key === "Home") next = tabs[0];
    else if (e.key === "End") next = tabs[tabs.length - 1];
    if (next) {
      e.preventDefault();
      selectTab(next, true);
    }
  });
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

function baseName(params) {
  const preset = params.preset === "none" ? "custom" : params.preset;
  return `easytestdata-${params.template}-${preset}-seed${params.seed}`;
}

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

els.dlJson.addEventListener("click", () => {
  if (!current) return;
  download(`${baseName(current.params)}.json`, planToJson(current.plan), "application/json");
});

els.dlCsv.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-section]");
  if (!btn || !current) return;
  const sections = planToCsv(current.plan);
  const name = btn.dataset.section;
  download(`${baseName(current.params)}-${name}.csv`, sections[name], "text/csv");
});

function renderDownloads(plan) {
  const bytes = new Blob([planToJson(plan)]).size;
  els.jsonSize.textContent = `(${(bytes / 1024 / 1024).toFixed(1)} MB)`;
  const sections = Object.keys(planToCsv(plan));
  els.dlCsv.innerHTML = sections
    .map(
      (name) =>
        `<button type="button" data-section="${escapeHtml(name)}" class="inline-flex items-center h-8 px-2.5 rounded-md border border-slate-300 bg-white text-xs font-mono text-slate-700 hover:bg-slate-50 hover:border-slate-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600">${escapeHtml(name)}.csv</button>`
    )
    .join("");
}

// ---------------------------------------------------------------------------
// Copy command
// ---------------------------------------------------------------------------

els.copy.addEventListener("click", async () => {
  const text = els.command.textContent;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const range = document.createRange();
    range.selectNodeContents(els.command);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand?.("copy");
  }
  els.copy.textContent = "Copied";
  els.copyStatus.textContent = "Command copied to clipboard";
  setTimeout(() => {
    els.copy.textContent = "Copy";
    els.copyStatus.textContent = "";
  }, 1800);
});

// ---------------------------------------------------------------------------
// Chart tooltip
// ---------------------------------------------------------------------------

els.chart.addEventListener("pointermove", (e) => {
  const hit = e.target.closest?.(".chart-hit");
  if (!hit) {
    els.tooltip.classList.add("hidden");
    return;
  }
  const rev = Number(hit.dataset.revenue);
  const exp = Number(hit.dataset.expenses);
  els.tooltip.innerHTML = `<div class="font-semibold mb-1">${escapeHtml(hit.dataset.label)}</div><div>Revenue <span class="tabular-nums">${fmtMoney(rev)}</span></div><div>Expenses <span class="tabular-nums">${fmtMoney(exp)}</span></div>`;
  const box = els.chart.getBoundingClientRect();
  const r = hit.getBoundingClientRect();
  els.tooltip.classList.remove("hidden");
  const tw = els.tooltip.offsetWidth;
  let left = r.left - box.left + r.width / 2 - tw / 2;
  left = Math.max(0, Math.min(left, box.width - tw));
  els.tooltip.style.left = `${left}px`;
  els.tooltip.style.top = `${Math.max(0, e.clientY - box.top - els.tooltip.offsetHeight - 12)}px`;
});
els.chart.addEventListener("pointerleave", () => els.tooltip.classList.add("hidden"));

// ---------------------------------------------------------------------------
// Generate
// ---------------------------------------------------------------------------

function run() {
  const params = readForm();
  els.error.classList.add("hidden");
  try {
    const t0 = performance.now();
    const plan = generatePlan(params);
    const ms = Math.max(1, Math.round(performance.now() - t0));
    current = { params, plan };
    const s = summarize(plan);
    els.stats.innerHTML = statTilesHtml(s);
    els.chart.innerHTML = chartSvg(
      s.monthly,
      window.innerWidth < 640 ? { width: 380, height: 240, compact: true } : {}
    );
    els.monthly.innerHTML = monthlyTable(s.monthly);
    // Report the seed the engine actually used (a blank or invalid seed falls back to the
    // default), and reflect it in the form and the copied command.
    params.seed = plan.meta.seed ?? params.seed;
    if (els.seed.value.trim() !== String(params.seed)) els.seed.value = String(params.seed);
    els.command.textContent = cliCommand("load", params);
    els.status.textContent = `Generated ${fmtInt(s.transactions)} transactions and ${fmtInt(
      s.customers + s.vendors + s.employees
    )} customers, vendors and employees for ${fmtDate(`${s.firstMonth}-01`).replace(/ \d+,/, "")} – ${fmtDate(`${s.lastMonth}-01`).replace(/ \d+,/, "")} with seed ${params.seed} in ${ms} ms.`;
    renderTable();
    renderDownloads(plan);
    syncUrl(params);
  } catch (err) {
    els.error.textContent = err.message || "Generation failed.";
    els.error.classList.remove("hidden");
  }
}

let debounce = null;
form.addEventListener("submit", (e) => {
  e.preventDefault();
  run();
});
form.addEventListener("change", () => run());
els.seed.addEventListener("input", () => {
  clearTimeout(debounce);
  debounce = setTimeout(run, 350);
});
$("pg-shuffle").addEventListener("click", () => {
  els.seed.value = String(Math.floor(Math.random() * 100000));
  run();
});

writeForm(paramsFromUrl());
run();
