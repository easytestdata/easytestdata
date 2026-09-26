/**
 * Pure helpers that turn a generated plan into summary numbers and HTML/SVG strings.
 * Shared by the browser bundles and by build.js (to pre-render real output into pages).
 * No DOM access in this module.
 */

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usd0 = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0
});
const usdCompact = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  minimumFractionDigits: 0,
  maximumFractionDigits: 1
});
const int = new Intl.NumberFormat("en-US");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const fmtMoney = (n) => usd.format(n);
export const fmtMoney0 = (n) => usd0.format(n);
export const fmtCompact = (n) => usdCompact.format(n);
export const fmtInt = (n) => int.format(n);

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function fmtDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

export const TRANSACTION_KEYS = [
  "invoices",
  "salesReceipts",
  "payments",
  "deposits",
  "estimates",
  "creditMemos",
  "refundReceipts",
  "bills",
  "billPayments",
  "purchaseOrders",
  "vendorCredits",
  "directExpenses",
  "payroll",
  "journalEntries",
  "transfers"
];

export function summarize(plan) {
  const m = plan.metrics;
  const buckets = new Map();
  const bucket = (date) => {
    const key = date.slice(0, 7);
    if (!buckets.has(key)) buckets.set(key, { key, revenue: 0, expenses: 0 });
    return buckets.get(key);
  };
  for (const inv of plan.invoices) bucket(inv.txnDate).revenue += inv.amount;
  for (const sr of plan.salesReceipts) bucket(sr.txnDate).revenue += sr.amount;
  for (const b of plan.bills) bucket(b.txnDate).expenses += b.amount;
  for (const de of plan.directExpenses) bucket(de.txnDate).expenses += de.amount;
  for (const p of plan.payroll) bucket(p.txnDate).expenses += p.totalAmount;
  const monthly = [...buckets.values()]
    .sort((a, b) => (a.key < b.key ? -1 : 1))
    .map((row) => {
      const [y, mo] = row.key.split("-").map(Number);
      return { ...row, label: `${MONTHS[mo - 1]} ${String(y).slice(2)}`, month: MONTHS[mo - 1] };
    });

  return {
    customers: plan.customers.length,
    vendors: plan.vendors.length,
    employees: plan.employees.length,
    invoices: plan.invoices.length,
    bills: plan.bills.length,
    payments: plan.payments.length,
    payrollRuns: plan.payroll.length,
    journalEntries: plan.journalEntries.length,
    transactions: TRANSACTION_KEYS.reduce((sum, key) => sum + plan[key].length, 0),
    revenue: m.totalRevenueGenerated,
    expenses: m.totalExpensesGenerated,
    netIncome: m.ebitdaGenerated,
    firstMonth: monthly[0]?.key,
    lastMonth: monthly[monthly.length - 1]?.key,
    monthly
  };
}

export function statTiles(s) {
  return [
    { label: "Customers", value: fmtInt(s.customers) },
    { label: "Vendors", value: fmtInt(s.vendors) },
    { label: "Invoices", value: fmtInt(s.invoices) },
    { label: "Bills", value: fmtInt(s.bills) },
    { label: "Payments", value: fmtInt(s.payments) },
    { label: "Payroll runs", value: fmtInt(s.payrollRuns) },
    { label: "Journal entries", value: fmtInt(s.journalEntries) },
    { label: "Total revenue", value: fmtCompact(s.revenue), title: fmtMoney(s.revenue) },
    { label: "Total expenses", value: fmtCompact(s.expenses), title: fmtMoney(s.expenses) },
    {
      // The generator hits this target before credits, refunds and adjustments, so QBO's
      // Profit and Loss for the same books will differ.
      label: "Target profit (before adjustments)",
      value: fmtCompact(s.netIncome),
      title: fmtMoney(s.netIncome)
    }
  ];
}

export function statTilesHtml(s, { dark = false, limit } = {}) {
  const tiles = limit ? statTiles(s).slice(0, limit) : statTiles(s);
  const card = dark ? "bg-white/5 border border-white/10" : "bg-white border border-slate-200";
  const labelCls = dark ? "text-slate-400" : "text-slate-500";
  const valueCls = dark ? "text-white" : "text-slate-900";
  return tiles
    .map(
      (t) =>
        `<div class="${card} rounded-xl px-4 py-3"><div class="text-xs font-medium ${labelCls}">${t.label}</div><div class="mt-0.5 text-xl sm:text-2xl font-extrabold tabular-nums ${valueCls}"${t.title ? ` title="${t.title}"` : ""}>${t.value}</div></div>`
    )
    .join("");
}

export function monthlyTable(monthly) {
  const th = "px-3 py-1.5 text-xs font-semibold uppercase text-slate-600";
  const td = "px-3 py-1.5 text-right tabular-nums";
  const rows = monthly
    .map(
      (m) =>
        `<tr class="border-t border-slate-100"><th scope="row" class="px-3 py-1.5 text-left font-medium text-slate-900 whitespace-nowrap">${escapeHtml(m.label)}</th><td class="${td}">${fmtMoney(m.revenue)}</td><td class="${td}">${fmtMoney(m.expenses)}</td><td class="${td}">${fmtMoney(m.revenue - m.expenses)}</td></tr>`
    )
    .join("");
  return `<table class="w-full text-sm text-slate-700"><thead><tr><th scope="col" class="${th} text-left">Month</th><th scope="col" class="${th} text-right">Revenue</th><th scope="col" class="${th} text-right">Expenses</th><th scope="col" class="${th} text-right">Net</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function niceStep(raw) {
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return nice * pow;
}

function barPath(x, y, w, h, r) {
  const base = y + h;
  const rr = Math.max(0, Math.min(r, h, w / 2));
  return `M${x},${base}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${base}Z`;
}

export const SERIES = {
  revenue: { label: "Revenue", color: "#2563eb" },
  expenses: { label: "Expenses", color: "#ea580c" }
};

/**
 * Grouped bar chart of monthly revenue vs expenses as an inline SVG string.
 * Each month has a transparent hit area carrying data-* attributes for tooltips.
 */
export function chartSvg(monthly, { width = 720, height = 260, compact = false } = {}) {
  const pad = { top: 12, right: 8, bottom: 26, left: compact ? 44 : 56 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const max = Math.max(1, ...monthly.flatMap((m) => [m.revenue, m.expenses]));
  const step = niceStep(max / 4);
  const top = Math.ceil(max / step) * step;
  const y = (v) => pad.top + innerH - (v / top) * innerH;
  const band = innerW / Math.max(1, monthly.length);
  const gap = 2;
  const barW = Math.max(2, Math.min(18, (band * 0.72 - gap) / 2));
  const labelEvery = monthly.length > 12 ? 3 : monthly.length > 8 && compact ? 2 : 1;

  const parts = [];
  for (let v = 0; v <= top + 1e-6; v += step) {
    const yy = y(v).toFixed(1);
    parts.push(
      `<line x1="${pad.left}" x2="${width - pad.right}" y1="${yy}" y2="${yy}" stroke="currentColor" stroke-opacity="${v === 0 ? 0.35 : 0.12}" />`,
      `<text x="${pad.left - 8}" y="${yy}" dy="0.32em" text-anchor="end" font-size="11" fill="currentColor" fill-opacity="0.7">${fmtCompact(v)}</text>`
    );
  }
  monthly.forEach((m, i) => {
    const cx = pad.left + band * i + band / 2;
    const x1 = cx - gap / 2 - barW;
    const x2 = cx + gap / 2;
    const hr = pad.top + innerH - y(m.revenue);
    const he = pad.top + innerH - y(m.expenses);
    parts.push(
      `<path d="${barPath(x1, y(m.revenue), barW, hr, 3)}" fill="${SERIES.revenue.color}" />`,
      `<path d="${barPath(x2, y(m.expenses), barW, he, 3)}" fill="${SERIES.expenses.color}" />`
    );
    if (i % labelEvery === 0) {
      parts.push(
        `<text x="${cx.toFixed(1)}" y="${height - 8}" text-anchor="middle" font-size="11" fill="currentColor" fill-opacity="0.7">${escapeHtml(labelEvery > 1 || !compact ? m.label : m.month)}</text>`
      );
    }
    parts.push(
      `<rect class="chart-hit" x="${(pad.left + band * i).toFixed(1)}" y="${pad.top}" width="${band.toFixed(1)}" height="${innerH}" fill="transparent" data-label="${escapeHtml(m.label)}" data-revenue="${m.revenue.toFixed(2)}" data-expenses="${m.expenses.toFixed(2)}"><title>${escapeHtml(m.label)}: revenue ${fmtMoney0(m.revenue)}, expenses ${fmtMoney0(m.expenses)}</title></rect>`
    );
  });

  const first = monthly[0]?.label ?? "";
  const last = monthly[monthly.length - 1]?.label ?? "";
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="Monthly revenue and expenses, ${escapeHtml(first)} to ${escapeHtml(last)}" style="display:block;height:auto;overflow:visible">${parts.join("")}</svg>`;
}

export function chartLegend() {
  return Object.values(SERIES)
    .map(
      (s) =>
        `<span class="inline-flex items-center gap-1.5"><span aria-hidden="true" class="inline-block w-3 h-3 rounded-sm" style="background:${s.color}"></span>${s.label}</span>`
    )
    .join("");
}

export function ledgerRowsHtml(plan, limit = 8) {
  return sampleLedger(plan, limit)
    .map((r) => {
      const color =
        r.sign > 0 ? "text-emerald-400" : r.sign < 0 ? "text-orange-300" : "text-slate-200";
      const amount = `${r.sign < 0 ? "−" : ""}${fmtMoney(r.amount)}`;
      return `<tr class="border-t border-white/5"><td class="py-2 pr-3 text-slate-400 whitespace-nowrap">${fmtDate(r.date)}</td><td class="py-2 pr-3 text-slate-200 whitespace-nowrap">${r.type}</td><td class="hidden sm:table-cell py-2 pr-3 text-slate-300">${escapeHtml(r.name)}</td><td class="py-2 text-right tabular-nums font-semibold whitespace-nowrap ${color}">${amount}</td></tr>`;
    })
    .join("");
}

/** A chronological sample of mixed transaction types for the homepage preview. */
export function sampleLedger(plan, limit = 8) {
  const docByInvoice = (i) => plan.invoices[i]?.docNumber ?? "";
  const pick = [
    ["Invoice", plan.invoices.find((x) => x.amount > 0), (x) => x.customerName, 1],
    ["Sales receipt", plan.salesReceipts[0], (x) => x.customerName, 1],
    ["Bill", plan.bills.find((x) => x.amount > 0), (x) => x.vendorName, -1],
    ["Payment", plan.payments[0], (x) => `${x.customerName} · ${docByInvoice(x.invoiceIndex)}`, 1],
    ["Payroll", plan.payroll[0], () => "Salaries, taxes & benefits", -1],
    ["Credit memo", plan.creditMemos[0], (x) => x.customerName, -1],
    ["Expense", plan.directExpenses[0], (x) => x.vendorName, -1],
    ["Journal entry", plan.journalEntries[0], (x) => x.memo, 0],
    ["Estimate", plan.estimates[0], (x) => x.customerName, 0],
    ["Deposit", plan.deposits[0], () => "Undeposited funds → Checking", 0]
  ];
  return pick
    .filter(([, row]) => row)
    .map(([type, row, name, sign]) => ({
      type,
      date: row.txnDate,
      name: name(row),
      amount: row.amount ?? row.totalAmount,
      sign
    }))
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .slice(0, limit);
}
