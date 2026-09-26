import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

function htmlFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return htmlFiles(path);
    return entry.name.endsWith(".html") ? [path] : [];
  });
}

// The marketing site is hosted apart from the app (Cloudflare Pages), so a relative /login link
// would 404: every link into the app goes through {{APP_URL}}, set at build time.
describe("links into the app", () => {
  it("never link to the app with a relative URL in the sources", () => {
    for (const file of htmlFiles(join(root, "src"))) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/href="\/(login|home|settings)/);
    }
  });

  it("point at the absolute APP_URL (default https://app.easytestdata.com) in the built pages", () => {
    const index = join(root, "dist", "index.html");
    expect(existsSync(index), "run the marketing build first").toBe(true);
    const html = readFileSync(index, "utf8");
    // The exact host depends on APP_URL at build time, which this test may not see.
    expect(html).toMatch(/href="https?:\/\/[^"/]+(\/[^"]*)?\/login/);
    expect(html).not.toMatch(/href="\/login/);
    expect(html).not.toContain("{{APP_URL}}");
  });
});
