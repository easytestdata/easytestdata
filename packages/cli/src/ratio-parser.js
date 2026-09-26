/**
 * Parse --ratio flags into a ratios override object.
 * Accepts an array of strings like ["invoicePaymentRate=0.8", "transfersPerMonth=2"]
 * Returns an object like { invoicePaymentRate: 0.8, transfersPerMonth: 2 } or null if empty.
 */
export function parseRatioFlags(ratioArgs) {
  if (!ratioArgs || ratioArgs.length === 0) return null;

  const ratios = {};
  for (const arg of ratioArgs) {
    const eqIndex = arg.indexOf("=");
    if (eqIndex === -1) {
      throw new Error(
        `Invalid --ratio format: "${arg}". Expected key=value (e.g. invoicePaymentRate=0.8)`
      );
    }
    const key = arg.slice(0, eqIndex).trim();
    const value = Number(arg.slice(eqIndex + 1).trim());
    if (!key || !Number.isFinite(value)) {
      throw new Error(
        `Invalid --ratio value: "${arg}". Key must be non-empty and value must be numeric.`
      );
    }
    ratios[key] = value;
  }
  return ratios;
}
