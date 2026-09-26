const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["hour", 3600],
  ["minute", 60],
  ["second", 1]
];

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export function timeAgo(date: string | Date): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const diffSec = Math.round((d.getTime() - Date.now()) / 1000);
  const absDiff = Math.abs(diffSec);

  // Older than 24h — fall back to locale string
  if (absDiff >= 86400) {
    return d.toLocaleString();
  }

  for (const [unit, secs] of UNITS) {
    if (absDiff >= secs) {
      return rtf.format(Math.round(diffSec / secs), unit);
    }
  }

  return rtf.format(0, "second");
}

const currencyFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0
});

export function formatCurrency(value: number | undefined | null): string {
  if (value == null) return "-";
  return currencyFmt.format(value);
}

const numberFmt = new Intl.NumberFormat("en-US");

export function formatNumber(value: number | undefined | null): string {
  if (value == null) return "-";
  return numberFmt.format(value);
}

export function formatDuration(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt || !completedAt) return "-";
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (ms < 0) return "-";
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
}

export function formatDateRange(
  startDate: string | undefined | null,
  endDate: string | undefined | null
): string {
  if (!startDate && !endDate) return "-";
  // Date-only strings parse as UTC midnight; format in UTC too, or "2025-09-01" reads as
  // "Aug 2025" anywhere west of Greenwich.
  const fmt = (d: string) =>
    new Date(d).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
  if (startDate && endDate) return `${fmt(startDate)} - ${fmt(endDate)}`;
  if (startDate) return `From ${fmt(startDate)}`;
  return `Until ${fmt(endDate!)}`;
}

const COUNTRY_NAMES: Record<string, string> = {
  US: "United States",
  CA: "Canada",
  GB: "United Kingdom",
  AU: "Australia",
  IN: "India",
  FR: "France",
  DE: "Germany"
};

export function countryName(code: string | undefined | null): string {
  if (!code) return "-";
  return COUNTRY_NAMES[code] ?? code;
}

const TEMPLATE_WORDS: Record<string, string> = { saas: "SaaS" };

/** "professional-services" -> "Professional Services", "saas" -> "SaaS". */
export function formatTemplateName(id: string): string {
  return id
    .split("-")
    .map((w) => TEMPLATE_WORDS[w] ?? w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
