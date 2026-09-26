import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execSync } from "child_process";
import * as esbuild from "esbuild";
import {
  DEFAULTS,
  cliCommand,
  describePreset,
  describeTemplate,
  generatePlan,
  listPresets,
  listTemplates
} from "./src/playground/core-adapter.js";
import {
  chartLegend,
  chartSvg,
  escapeHtml,
  fmtInt,
  ledgerRowsHtml,
  monthlyTable,
  statTilesHtml,
  summarize
} from "./src/playground/render.js";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const SRC = path.join(ROOT, "src");
const DIST = path.join(ROOT, "dist");

// ---------------------------------------------------------------------------
// Site-wide constants. Each is exposed to pages and partials as a {{TOKEN}}.
// ---------------------------------------------------------------------------
const SITE_URL = "https://easytestdata.com";
/** The Cloud app (hosted apart from this site): every "Sign in"/"Get started" link points here. */
const APP_URL = (process.env.APP_URL || "https://app.easytestdata.com").replace(/\/+$/, "");
/** The ONE contact address used across the site (legal pages, contact, footer). */
const CONTACT_EMAIL = "support@easytestdata.com";
const GITHUB_URL = "https://github.com/easytestdata/easytestdata";
const DOCS_URL = `${GITHUB_URL}#readme`;
const OG_IMAGE_URL = `${SITE_URL}/og-image.png`;
const BUILD_DATE = new Date().toISOString().slice(0, 10);
/** The Cloud abuse limits, stated once and reused by the FAQ and the local-vs-Cloud comparison. */
const CLOUD_LIMITS =
  "Cloud limits exist only to prevent abuse of the shared service: 3 QBO connections, 10 loads " +
  "into QuickBooks per month (downloads and removals are free), 5,000 records per job and 5 " +
  "members per team. " +
  "Running it locally (npx easytestdata ui) has no limits.";

const GLOBAL_TOKENS = {
  APP_URL,
  CLOUD_LIMITS,
  CONTACT_EMAIL,
  GITHUB_URL,
  DOCS_URL,
  SITE_URL,
  OG_IMAGE_URL,
  YEAR: String(new Date().getUTCFullYear())
};

function applyGlobalTokens(html) {
  return html.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) =>
    Object.hasOwn(GLOBAL_TOKENS, key) ? GLOBAL_TOKENS[key] : match
  );
}

// ---------------------------------------------------------------------------
// 1. Clean
// ---------------------------------------------------------------------------
function clean() {
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIST, "blog"), { recursive: true });
  fs.mkdirSync(path.join(DIST, "legal"), { recursive: true });
  fs.mkdirSync(path.join(DIST, "marketing-assets"), { recursive: true });
}

// ---------------------------------------------------------------------------
// 2. Read partials
// ---------------------------------------------------------------------------
function loadPartials() {
  const dir = path.join(SRC, "partials");
  return {
    head: fs.readFileSync(path.join(dir, "head.html"), "utf8"),
    nav: fs.readFileSync(path.join(dir, "nav.html"), "utf8"),
    footer: fs.readFileSync(path.join(dir, "footer.html"), "utf8")
  };
}

// ---------------------------------------------------------------------------
// 3. Parse front-matter from HTML comment block
// ---------------------------------------------------------------------------
function parseFrontMatter(raw) {
  const match = raw.match(/^<!--\n([\s\S]*?)\n-->\s*/);
  if (!match) return { meta: {}, body: raw.trim() };

  const meta = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    meta[key] = val;
  }
  return { meta, body: raw.slice(match[0].length).trim() };
}

// ---------------------------------------------------------------------------
// 4. JSON-LD structured data
// ---------------------------------------------------------------------------
function stripTags(html) {
  return html
    .replace(/<\/(p|li|div|h[1-6])>/g, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&rarr;/g, "→")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function softwareApplicationSchema(description) {
  return {
    "@type": ["SoftwareApplication", "SoftwareSourceCode"],
    name: "EasyTestData",
    description,
    url: SITE_URL,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Web, Linux, macOS, Windows",
    codeRepository: GITHUB_URL,
    programmingLanguage: "JavaScript",
    license: "https://www.apache.org/licenses/LICENSE-2.0",
    isAccessibleForFree: true,
    image: OG_IMAGE_URL,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" }
  };
}

/** FAQPage entries are derived from the page's own <details>/<summary> markup. */
function faqSchema(body) {
  const mainEntity = [];
  const re = /<details[^>]*>\s*<summary[^>]*>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g;
  for (const [, q, a] of body.matchAll(re)) {
    const question = stripTags(q.replace(/<span[^>]*aria-hidden[^>]*>[\s\S]*?<\/span>/g, ""));
    mainEntity.push({
      "@type": "Question",
      name: question,
      acceptedAnswer: { "@type": "Answer", text: stripTags(a) }
    });
  }
  return { "@type": "FAQPage", mainEntity };
}

function blogPostingSchema(meta, canonicalUrl) {
  return {
    "@type": "BlogPosting",
    headline: meta.headline || meta.title.split(" | ")[0],
    description: meta.description || "",
    datePublished: meta.date,
    dateModified: meta.updated || meta.date,
    author: { "@type": "Organization", name: meta.author || "EasyTestData", url: SITE_URL },
    publisher: { "@type": "Organization", name: "EasyTestData", url: SITE_URL },
    image: OG_IMAGE_URL,
    mainEntityOfPage: canonicalUrl,
    url: canonicalUrl
  };
}

/** Home > section > page, from the canonical path (blog posts and use-case pages). */
function breadcrumbSchema(meta) {
  const SECTION_NAMES = { blog: "Blog", "use-cases": "Use cases" };
  const segments = (meta.canonical || "/").split("/").filter(Boolean);
  const items = [{ name: "Home", url: `${SITE_URL}/` }];
  let acc = "";
  segments.forEach((segment, i) => {
    acc += `/${segment}`;
    const last = i === segments.length - 1;
    items.push({
      name: last ? meta.headline || meta.title.split(" | ")[0] : SECTION_NAMES[segment] || segment,
      url: SITE_URL + acc
    });
  });
  return {
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      item: item.url
    }))
  };
}

function buildSchema(meta, body, canonicalUrl) {
  if (!meta.schema) return "";
  const graph = [];
  for (const type of meta.schema.split(",").map((s) => s.trim())) {
    if (type === "WebSite") {
      graph.push({ "@type": "WebSite", name: "EasyTestData", url: SITE_URL });
    } else if (type === "SoftwareApplication") {
      graph.push(softwareApplicationSchema(meta.description || ""));
    } else if (type === "FAQPage") {
      graph.push(faqSchema(body));
    } else if (type === "BlogPosting") {
      graph.push(blogPostingSchema(meta, canonicalUrl));
    } else if (type === "BreadcrumbList") {
      graph.push(breadcrumbSchema(meta));
    } else if (type === "Organization") {
      graph.push({
        "@type": "Organization",
        name: "EasyTestData",
        url: SITE_URL,
        email: CONTACT_EMAIL,
        sameAs: [GITHUB_URL]
      });
    } else {
      throw new Error(`Unknown schema type: ${type}`);
    }
  }
  const obj = { "@context": "https://schema.org", "@graph": graph };
  return `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, "\\u003c")}</script>`;
}

// ---------------------------------------------------------------------------
// 5. Assemble a full page
// ---------------------------------------------------------------------------
function assemblePage(meta, body, partials, cssPath, file) {
  const canonicalUrl = meta.canonical ? SITE_URL + meta.canonical : SITE_URL + "/";
  const description = meta.description || "";
  if (description.length > 160) {
    throw new Error(`${file}: meta description is ${description.length} chars (max 160)`);
  }

  const head = partials.head
    .replace(/\{\{TITLE\}\}/g, meta.title || "EasyTestData")
    .replace(/\{\{DESCRIPTION\}\}/g, description)
    .replace(/\{\{CANONICAL_URL\}\}/g, canonicalUrl)
    .replace(/\{\{OG_TYPE\}\}/g, meta.og_type || "website")
    .replace(/\{\{SCHEMA_JSON\}\}/g, buildSchema(meta, body, canonicalUrl))
    .replace(/\{\{CSS_PATH\}\}/g, cssPath);

  return applyGlobalTokens(`<!DOCTYPE html>
<html lang="en">
${head}
<body class="bg-white text-slate-900 leading-relaxed antialiased">
<a href="#main" class="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[70] focus:px-4 focus:py-2 focus:bg-white focus:text-slate-900 focus:rounded-lg">Skip to content</a>
${partials.nav}
${body.replace(/<main(?=[\s>])/, '<main id="main"')}
${partials.footer}
</body>
</html>`);
}

// ---------------------------------------------------------------------------
// 5b. Move inline scripts into hashed files. The production Content-Security-Policy is
//     `script-src 'self' ...` without 'unsafe-inline', so inline <script> blocks would be
//     blocked. External classic scripts still run in document order, like inline ones did.
// ---------------------------------------------------------------------------
const INLINE_SCRIPT_RE = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g;

function externalizeInlineScripts(html) {
  return html.replace(INLINE_SCRIPT_RE, (tag, attrs, code) => {
    if (/application\/ld\+json/.test(attrs) || !code.trim()) return tag;
    const hash = crypto.createHash("sha256").update(code).digest("hex").slice(0, 10);
    const name = `inline-${hash}.js`;
    const file = path.join(DIST, "marketing-assets", name);
    if (!fs.existsSync(file)) fs.writeFileSync(file, code.trim() + "\n");
    return `<script${attrs} src="/marketing-assets/${name}"></script>`;
  });
}

// ---------------------------------------------------------------------------
// 6. Collect blog posts for the blog index listing
// ---------------------------------------------------------------------------
function collectBlogPosts() {
  const blogDir = path.join(SRC, "blog");
  const posts = [];
  for (const file of fs.readdirSync(blogDir)) {
    if (!file.endsWith(".html")) continue;
    const raw = fs.readFileSync(path.join(blogDir, file), "utf8");
    const { meta } = parseFrontMatter(raw);
    posts.push({
      slug: file.replace(/\.html$/, ""),
      title: meta.headline || meta.title || file,
      date: meta.date || "",
      excerpt: meta.excerpt || meta.description || "",
      tags: meta.tags ? meta.tags.split(",").map((t) => t.trim()) : []
    });
  }
  // Sort by date descending, then title for stability
  posts.sort((a, b) =>
    b.date === a.date ? a.title.localeCompare(b.title) : b.date > a.date ? 1 : -1
  );
  return posts;
}

function buildBlogListing(posts) {
  if (posts.length === 0) return "<p>No posts yet.</p>";
  return posts
    .map(
      (
        p
      ) => `<article class="bg-white border border-slate-200 rounded-2xl p-6 sm:p-8 transition-all duration-200 hover:shadow-lg hover:-translate-y-0.5">
  <div class="flex flex-wrap items-center gap-3 mb-3">
    <time datetime="${p.date}" class="text-sm text-slate-500 font-medium">${formatDate(p.date)}</time>
    ${p.tags.map((t) => `<span class="inline-flex px-2 py-0.5 bg-blue-50 text-blue-700 text-xs font-medium rounded-full">${t}</span>`).join("")}
  </div>
  <h2 class="text-xl font-bold text-slate-900 mb-2"><a href="/blog/${p.slug}" class="hover:text-blue-600 no-underline">${p.title}</a></h2>
  <p class="text-sm text-slate-600 leading-relaxed">${p.excerpt}</p>
  <a href="/blog/${p.slug}" class="inline-flex items-center mt-4 text-sm font-semibold text-blue-700 hover:text-blue-800 no-underline" aria-label="Read: ${p.title.replace(/"/g, "&quot;")}">Read the post</a>
</article>`
    )
    .join("\n");
}

function formatDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00Z");
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC"
  });
}

// ---------------------------------------------------------------------------
// 7. Build CSS with Tailwind
// ---------------------------------------------------------------------------
function hashFile(filePath) {
  return crypto.createHash("md5").update(fs.readFileSync(filePath)).digest("hex").slice(0, 8);
}

function buildCss() {
  const inputCss = path.join(SRC, "css", "input.css");
  const outputCss = path.join(DIST, "marketing-assets", "style.css");

  try {
    execSync(`npx @tailwindcss/cli -i ${inputCss} -o ${outputCss} --minify 2>&1`, {
      cwd: ROOT,
      stdio: "pipe"
    });
  } catch (err) {
    console.error("CSS build failed:", err.stdout?.toString() || err.message);
    process.exit(1);
  }

  const hashedName = `style.${hashFile(outputCss)}.css`;
  fs.renameSync(outputCss, path.join(DIST, "marketing-assets", hashedName));
  return `/marketing-assets/${hashedName}`;
}

// ---------------------------------------------------------------------------
// 8. Bundle browser JS (packages/core runs client-side in the playground)
// ---------------------------------------------------------------------------
function buildJs() {
  const entries = {
    playground: path.join(SRC, "playground", "playground.js"),
    teaser: path.join(SRC, "playground", "teaser.js")
  };
  const result = esbuild.buildSync({
    entryPoints: entries,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["es2020"],
    minify: true,
    legalComments: "none",
    outdir: path.join(DIST, "marketing-assets"),
    entryNames: "[name].[hash]",
    metafile: true,
    logLevel: "silent"
  });

  const inputs = Object.keys(result.metafile.inputs);
  const forbidden = inputs.filter((p) => p.includes("validate-cli") || p.startsWith("node:"));
  if (forbidden.length > 0) {
    throw new Error(`Node-only modules leaked into the browser bundle: ${forbidden.join(", ")}`);
  }

  const urls = {};
  for (const [outFile, info] of Object.entries(result.metafile.outputs)) {
    if (!info.entryPoint) continue;
    const name = path.basename(info.entryPoint, ".js");
    urls[name] = `/marketing-assets/${path.basename(outFile)}`;
  }
  return urls;
}

// ---------------------------------------------------------------------------
// 9. Pre-render real generated output into pages (same engine as the CLI)
// ---------------------------------------------------------------------------
function buildGeneratedTokens(jsUrls) {
  const templates = listTemplates();
  const presets = listPresets();
  const option = (id, name, selected) =>
    `<option value="${id}"${selected ? " selected" : ""}>${escapeHtml(name)}</option>`;
  const templateOptions = templates
    .map((t) => option(t.id, t.name, t.id === DEFAULTS.template))
    .join("");
  const presetOptions = [
    option("none", "None (base: $500K revenue, 15 customers)", false),
    ...presets.map((p) => option(p.id, p.name, p.id === DEFAULTS.preset))
  ].join("");

  const plan = generatePlan(DEFAULTS);
  const s = summarize(plan);

  // Range of transaction counts across every template x preset (12 months, seed 42)
  const counts = [];
  for (const t of templates) {
    for (const p of ["none", ...presets.map((x) => x.id)]) {
      counts.push(
        summarize(generatePlan({ template: t.id, preset: p, seed: 42, months: 12 })).transactions
      );
    }
  }
  const round = (n, dir) => Math[dir](n / 50) * 50;

  return {
    PLAYGROUND_JS: jsUrls.playground,
    TEASER_JS: jsUrls.teaser,
    // Counts come from core, so adding a template or scenario updates every page.
    TEMPLATE_COUNT: String(templates.length),
    SCENARIO_COUNT: String(presets.length),
    TEMPLATE_OPTIONS: templateOptions,
    PRESET_OPTIONS: presetOptions,
    CHART_LEGEND: chartLegend(),
    PG_STATS: statTilesHtml(s),
    PG_CHART: chartSvg(s.monthly),
    PG_MONTHLY: monthlyTable(s.monthly),
    PG_COMMAND: cliCommand("load", DEFAULTS),
    PG_STATUS: `Generated ${fmtInt(s.transactions)} transactions.`,
    TEASER_STATS: statTilesHtml(s, { dark: true, limit: 4 }),
    TEASER_CHART: chartSvg(s.monthly, { width: 400, height: 200, compact: true }),
    TEASER_LEDGER: ledgerRowsHtml(plan, 6),
    TEASER_TOTAL: fmtInt(s.transactions),
    TEASER_SEED: String(DEFAULTS.seed),
    TXN_MIN: fmtInt(round(Math.min(...counts), "floor")),
    TXN_MAX: fmtInt(round(Math.max(...counts), "ceil")),
    TEMPLATE_CARDS: templateCards(),
    PRESET_CARDS: presetCards()
  };
}

// Short, honest blurbs; everything else on the cards (names, scenario details) comes from core.
const TEMPLATE_BLURBS = {
  "professional-services":
    "Consulting and advisory firms billing clients by invoice. The default template.",
  saas: "Software companies with subscription and usage invoices, quick collections and a payroll-heavy cost base.",
  restaurant: "Mostly cash sales receipts, food and beverage bills, and frequent purchase orders.",
  construction:
    "Estimates on most jobs, purchase orders for materials, slow and often partial customer payments.",
  retail: "Mostly cash sales, cost-of-goods bills and a higher refund rate.",
  healthcare: "Invoiced services with 30 to 90 day collections and frequent partial payments.",
  nonprofit: "Donations and grants, program and fundraising expenses.",
  "real-estate": "Rental and management-fee invoices with maintenance, tax and insurance costs."
};

const pct = (n) => `${Math.round(n * 100)}%`;
const chip = (text, cls) =>
  `<span class="inline-flex px-2 py-0.5 rounded-md text-xs font-medium ${cls}">${escapeHtml(text)}</span>`;

function templateCards() {
  return listTemplates()
    .map(({ id }) => {
      const t = describeTemplate(id);
      const r = t.ratios;
      const facts = [
        `${pct(r.invoicedRevenueShare)} invoiced / ${pct(r.cashSalesShare)} cash sales`,
        `Paid in ${r.paymentDelayMinDays}&ndash;${r.paymentDelayMaxDays} days`,
        `${pct(r.estimateRate)} estimates &middot; ${pct(r.purchaseOrderRate)} POs`
      ];
      return `<article class="bg-white border border-slate-200 rounded-2xl p-6 flex flex-col">
  <h3 class="text-lg font-bold text-slate-900">${escapeHtml(t.name)}</h3>
  <p class="mt-1 text-xs font-mono text-slate-500">--template ${id}</p>
  <p class="mt-3 text-sm text-slate-600 leading-relaxed">${escapeHtml(TEMPLATE_BLURBS[id] || "")}</p>
  <ul class="mt-3 text-xs text-slate-600 space-y-1">${facts.map((f) => `<li>${f}</li>`).join("")}</ul>
  <p class="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-500">Service items</p>
  <div class="mt-1.5 flex flex-wrap gap-1.5">${t.serviceItems.map((s) => chip(s, "bg-blue-50 text-blue-800")).join("")}</div>
  <p class="mt-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Expense categories</p>
  <div class="mt-1.5 mb-5 flex flex-wrap gap-1.5">${t.expenseCategories.map((s) => chip(s, "bg-slate-100 text-slate-700")).join("")}</div>
  <a href="/playground?template=${id}" class="mt-auto pt-4 border-t border-slate-100 text-sm font-semibold text-blue-700 hover:text-blue-800 no-underline">Preview in the playground</a>
</article>`;
    })
    .join("\n");
}

function presetCards() {
  const money = (n) => (n >= 1e6 ? `$${n / 1e6}M` : `$${n / 1e3}K`);
  return listPresets()
    .map(({ id }) => {
      const p = describePreset(id);
      const q = p.request;
      return `<article class="bg-white border border-slate-200 rounded-2xl p-6">
  <h3 class="text-lg font-bold text-slate-900">${escapeHtml(p.name)}</h3>
  <p class="mt-1 text-xs font-mono text-slate-500">--scenario ${id}</p>
  <p class="mt-3 text-sm text-slate-600 leading-relaxed">${escapeHtml(p.description)}</p>
  <dl class="mt-4 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-600">
    <dt>Revenue</dt><dd class="text-right font-semibold text-slate-900">${money(q.totalRevenue)}</dd>
    <dt>Target profit</dt><dd class="text-right font-semibold text-slate-900">${money(q.targetEbitda)}</dd>
    <dt>Customers</dt><dd class="text-right font-semibold text-slate-900">${q.customerCount}</dd>
    <dt>Employees</dt><dd class="text-right font-semibold text-slate-900">${q.employeeCount}</dd>
  </dl>
</article>`;
    })
    .join("\n");
}

function applyPageTokens(content, tokens) {
  return content.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) =>
    Object.hasOwn(tokens, key) ? tokens[key] : match
  );
}

// ---------------------------------------------------------------------------
// 10. Copy static assets
// ---------------------------------------------------------------------------
function copyStatic() {
  const staticDir = path.join(SRC, "static");
  if (!fs.existsSync(staticDir)) return;
  for (const file of fs.readdirSync(staticDir)) {
    const from = path.join(staticDir, file);
    if (file === "og-image.png" && fs.statSync(from).size === 0) {
      throw new Error("static/og-image.png is empty");
    }
    fs.copyFileSync(from, path.join(DIST, file));
  }
}

// ---------------------------------------------------------------------------
// 11. Generate sitemap
// ---------------------------------------------------------------------------
const gitDateCache = new Map();

/** YYYY-MM-DD of the file's last commit, or "" outside a git checkout / for uncommitted files. */
function lastCommitDate(file) {
  if (!gitDateCache.has(file)) {
    let date = "";
    try {
      date = execSync(`git log -1 --format=%cs -- "${file}"`, {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "ignore"]
      })
        .toString()
        .trim();
    } catch {
      // Not a git checkout (e.g. a source tarball): fall back to the build date.
    }
    gitDateCache.set(file, /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "");
  }
  return gitDateCache.get(file);
}

/** Sitemap lastmod: the page's own `updated:` front-matter, else its last commit, else today. */
function pageLastmod(meta, file) {
  return meta.updated || lastCommitDate(file) || BUILD_DATE;
}

function generateSitemap(pages) {
  const urls = pages
    .map(
      (p) => `  <url>
    <loc>${SITE_URL}${p.url}</loc>
    <lastmod>${p.lastmod}</lastmod>
  </url>`
    )
    .join("\n");

  const sitemap0 = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;

  const sitemapIndex = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>${SITE_URL}/sitemap-0.xml</loc>
    <lastmod>${BUILD_DATE}</lastmod>
  </sitemap>
</sitemapindex>
`;

  fs.writeFileSync(path.join(DIST, "sitemap-0.xml"), sitemap0);
  fs.writeFileSync(path.join(DIST, "sitemap-index.xml"), sitemapIndex);
}

// ---------------------------------------------------------------------------
// Main build
// ---------------------------------------------------------------------------
function build() {
  const start = Date.now();
  console.log("Building marketing site...");

  clean();
  const partials = loadPartials();

  console.log("  Building CSS...");
  const cssPath = buildCss();

  console.log("  Bundling JS...");
  const jsUrls = buildJs();
  const pageTokens = buildGeneratedTokens(jsUrls);

  const blogPosts = collectBlogPosts();
  pageTokens.BLOG_LISTING = buildBlogListing(blogPosts);

  const builtPages = [];
  const pagesDir = path.join(SRC, "pages");

  function processDir(dir, outDir, urlPrefix) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const subOut = path.join(outDir, entry.name);
        fs.mkdirSync(subOut, { recursive: true });
        processDir(path.join(dir, entry.name), subOut, `${urlPrefix}${entry.name}/`);
        continue;
      }
      if (!entry.name.endsWith(".html")) continue;

      const raw = fs.readFileSync(path.join(dir, entry.name), "utf8");
      const { meta, body } = parseFrontMatter(raw);
      const content = applyPageTokens(body, pageTokens);
      const html = externalizeInlineScripts(
        assemblePage(meta, content, partials, cssPath, entry.name)
      );
      fs.writeFileSync(path.join(outDir, entry.name), html);

      const urlPath =
        entry.name === "index.html"
          ? urlPrefix || "/"
          : `${urlPrefix}${entry.name.replace(/\.html$/, "")}`;
      builtPages.push({ url: urlPath, lastmod: pageLastmod(meta, path.join(dir, entry.name)) });
      console.log(`  Page: ${urlPath}`);
    }
  }

  processDir(pagesDir, DIST, "/");

  const blogDir = path.join(SRC, "blog");
  if (fs.existsSync(blogDir)) {
    for (const file of fs.readdirSync(blogDir)) {
      if (!file.endsWith(".html")) continue;
      const raw = fs.readFileSync(path.join(blogDir, file), "utf8");
      const { meta, body } = parseFrontMatter(raw);
      const html = externalizeInlineScripts(
        assemblePage(meta, applyPageTokens(body, pageTokens), partials, cssPath, file)
      );
      fs.writeFileSync(path.join(DIST, "blog", file), html);
      const slug = file.replace(/\.html$/, "");
      builtPages.push({
        url: `/blog/${slug}`,
        lastmod: pageLastmod(meta, path.join(blogDir, file))
      });
      console.log(`  Blog: /blog/${slug}`);
    }
  }

  copyStatic();
  generateSitemap(builtPages);

  const elapsed = Date.now() - start;
  console.log(`\nDone! Built ${builtPages.length} pages in ${elapsed}ms → dist/`);
}

// ---------------------------------------------------------------------------
// Watch mode
// ---------------------------------------------------------------------------
if (process.argv.includes("--watch")) {
  build();
  console.log("\nWatching for changes...");
  let debounce = null;
  fs.watch(SRC, { recursive: true }, () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      console.log("\nRebuilding...");
      try {
        build();
      } catch (err) {
        console.error("Build error:", err.message);
      }
    }, 200);
  });
} else {
  build();
}
