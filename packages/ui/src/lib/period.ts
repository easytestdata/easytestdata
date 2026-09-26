/**
 * The default generation period: the 12 full calendar months before today's month, the same
 * default core's resolvePeriod() uses (so the data lands in QuickBooks' "last 12 months"
 * reports and never in the future). Replicated here to keep the generation engine out of the
 * web bundle; keep it in step with core (web tests pin the same examples).
 */
export function defaultPeriod(today: Date = new Date(), months = 12) {
  const y = today.getFullYear();
  const m = today.getMonth();
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return {
    startDate: iso(Date.UTC(y, m - months, 1)),
    endDate: iso(Date.UTC(y, m, 1) - 24 * 60 * 60 * 1000)
  };
}
