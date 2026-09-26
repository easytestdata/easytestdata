# EasyTestData Brand Style Guide

## 1. Brand Identity

EasyTestData is an open-source project that generates realistic test data for QuickBooks Online sandboxes, with an optional hosted service, EasyTestData Cloud. The brand conveys **trust**, **technical precision**, and **simplicity** through a blue-primary palette with slate neutrals and emerald green accents.

### Brand Name

- **Full**: EasyTestData (one word, PascalCase)
- **Short/CLI**: `easytestdata`

### Tagline

> Realistic test data for QuickBooks Online sandboxes.

### One-liner

> EasyTestData is an open-source generator that fills a QuickBooks Online sandbox with a year of
> financially coherent books (customers, invoices, bills, payments, payroll) and purges it cleanly
> when you're done.

### Terminology

| Use                           | Rule                                                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EasyTestData                  | Product name. One word, capital E, T, D.                                                                                                                |
| `easytestdata`                | CLI and npm package name.                                                                                                                               |
| EasyTestData Cloud            | The hosted service. Not "SaaS", "hosted service", or "managed Cloud".                                                                                   |
| run it locally, local mode    | For `npx easytestdata ui`. Say "run it locally", not "self-host".                                                                                       |
| QuickBooks Online (QBO)       | Spell out on first use per page, then "QBO".                                                                                                            |
| sandbox                       | Always say sandbox. EasyTestData never connects to production.                                                                                          |
| test data                     | In headlines. Use "synthetic" only to explain that the data is fake.                                                                                    |
| industry templates, scenarios | 8 templates, 8 scenarios. Say "scenario", not "preset" or "profile" (the CLI flag is `--scenario`).                                                     |
| profit                        | Say "target profit (before adjustments)", not "EBITDA" or "net income".                                                                                 |
| records                       | What EasyTestData creates in QBO. Not "entities".                                                                                                       |
| Remove test data / purge      | Deletes tagged transactions and makes created customers, vendors, employees and items inactive; accounts stay. Never "removes exactly what it created". |
| Apache-2.0                    | The license for everything in the repository.                                                                                                           |

---

## 2. Logo & Favicon

### Favicon

A document icon with staggered data rows, rendered in SVG at 32x32.

| Element       | Color                    | Notes                |
| ------------- | ------------------------ | -------------------- |
| Document body | `#2563eb`                | Primary blue         |
| Folded corner | `#93bbfd`                | Light blue highlight |
| Data row 1    | `#ffffff` at 90% opacity | Longest bar          |
| Data row 2    | `#ffffff` at 70% opacity | Short bar            |
| Data row 3    | `#ffffff` at 50% opacity | Medium bar           |

### App Logo (Login Page)

A 48x48 (`h-12 w-12`) rounded square (`rounded-xl`) with primary blue background and a white bold "E" letterform centered inside.

---

## 3. Colors

The design tokens are CSS custom properties in `packages/ui/src/styles/globals.css` (HSL values
without the `hsl()` wrapper, mapped to Tailwind colors there). That file is the source of truth;
this section only sets the intent.

| Role             | Value                   | Use                                          |
| ---------------- | ----------------------- | -------------------------------------------- |
| Primary          | `#2563eb` (`--primary`) | Buttons, links, focus rings, calls to action |
| Neutrals         | Tailwind slate          | Text, borders, backgrounds                   |
| Success / safety | Tailwind emerald        | Completed jobs, the sandbox-only reassurance |
| Warning          | Tailwind amber          | Partial results, rolled-back loads, limits   |
| Destructive      | `--destructive` (red)   | Failures and actions that delete data        |
| Sidebar          | `--sidebar` (dark navy) | Stays dark in both light and dark modes      |

Per-industry colors on template cards are decorative and are not part of the palette.

## 4. Typography

**Inter** is the only typeface in the web app, bundled with it (`@fontsource-variable/inter`), so
the app makes no request to a font service. The marketing site uses the system sans-serif stack
for a faster first paint. Text is rendered `antialiased`.

## 5. Do / Don't

**Do**

- Use the theme tokens (`bg-primary`, `text-muted-foreground`) for every theme-aware color
- Keep the sidebar dark in both light and dark modes
- Use emerald for success and safety signals and amber for warnings
- Say "sandbox" whenever a QuickBooks company is meant

**Don't**

- Hardcode a hex color where a token exists
- Use orange: it is not part of the palette
- Mix the marketing site's system font stack into the web app
- Use shadows heavier than `shadow-xl`; the design is flat-leaning
- Add a color to the theme without adding it to `globals.css` and this guide
