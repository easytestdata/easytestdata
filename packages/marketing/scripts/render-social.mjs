// Renders the social cards from scripts/social-card.html with Playwright:
//   src/static/og-image.png        1200x630 (Open Graph / Twitter)
//   ../../.github/social-preview.png 1280x640 (GitHub repository social preview)
//
// Usage: node scripts/render-social.mjs [path/to/playwright/index.mjs]
// Playwright is not a dependency of this package; pass its module path or set PLAYWRIGHT_MODULE.
import fs from "fs";
import path from "path";
import { generatePlan } from "../src/playground/core-adapter.js";
import { fmtMoney } from "../src/playground/render.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const playwrightPath =
  process.argv[2] ||
  process.env.PLAYWRIGHT_MODULE ||
  "/opt/node22/lib/node_modules/playwright/index.mjs";
const { chromium } = await import(playwrightPath);

const plan = generatePlan({
  template: "saas",
  preset: "rapid-growth",
  seed: 42,
  months: 12,
  today: new Date("2026-09-24")
});
const paid = new Map();
for (const p of plan.payments) paid.set(p.invoiceIndex, (paid.get(p.invoiceIndex) || 0) + p.amount);
const rows = plan.invoices
  .slice(0, 7)
  .map((inv, i) => {
    const x = paid.get(i) || 0;
    const [cls, label] =
      x >= inv.amount - 0.005 ? ["paid", "Paid"] : x > 0 ? ["part", "Partial"] : ["open", "Open"];
    return `<tr><td class="doc">${inv.docNumber}</td><td>${inv.customerName}</td><td class="n">${fmtMoney(inv.amount)}</td><td><span class="st ${cls}">${label}</span></td></tr>`;
  })
  .join("\n");

const html = fs
  .readFileSync(path.join(ROOT, "scripts", "social-card.html"), "utf8")
  .replace("{{ROWS}}", rows);
const tmp = path.join(ROOT, "scripts", ".social-card.rendered.html");
fs.writeFileSync(tmp, html);

const targets = [
  { file: path.join(ROOT, "src", "static", "og-image.png"), width: 1200, height: 630 },
  { file: path.join(ROOT, "..", "..", ".github", "social-preview.png"), width: 1280, height: 640 }
];

// Fonts come from Google Fonts; honor an HTTPS proxy if the environment requires one.
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const browser = await chromium.launch(proxy ? { proxy: { server: proxy } } : {});
try {
  for (const t of targets) {
    const page = await browser.newPage({
      viewport: { width: t.width, height: t.height },
      ignoreHTTPSErrors: Boolean(proxy)
    });
    await page.goto(`file://${tmp}`, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    const hasInter = await page.evaluate(() => document.fonts.check('800 60px "Inter"'));
    if (!hasInter)
      throw new Error("Inter did not load from Google Fonts; re-run with network access.");
    fs.mkdirSync(path.dirname(t.file), { recursive: true });
    await page.screenshot({ path: t.file, type: "png" });
    await page.close();
    console.log(
      `Wrote ${path.relative(process.cwd(), t.file)} (${fs.statSync(t.file).size} bytes)`
    );
  }
} finally {
  await browser.close();
  fs.rmSync(tmp, { force: true });
}
