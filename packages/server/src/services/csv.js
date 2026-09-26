// CSV helpers for exports opened in spreadsheet apps. Cells that start with = + - @ tab or CR
// would be evaluated as formulas (CSV/formula injection), so they get a leading single quote;
// plain numbers (including negatives) are left alone. Every cell is RFC 4180 quoted as needed.

const FORMULA_PREFIX = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;

export function neutralizeFormula(value) {
  const str = value === null || value === undefined ? "" : String(value);
  if (FORMULA_PREFIX.test(str) && !PLAIN_NUMBER.test(str)) return `'${str}`;
  return str;
}

export function csvCell(value) {
  const str = neutralizeFormula(value instanceof Date ? value.toISOString() : value);
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

export function csvRow(values) {
  return values.map(csvCell).join(",");
}

export function toCsv(header, rows) {
  return [csvRow(header), ...rows.map(csvRow)].join("\n");
}
