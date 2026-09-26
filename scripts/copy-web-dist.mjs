// Copies the built web app into the server package before `pnpm pack` (prepack).
import { cpSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const from = fileURLToPath(new URL("../packages/web/dist", import.meta.url));
const to = fileURLToPath(new URL("../packages/server/web-dist", import.meta.url));
if (!existsSync(`${from}/index.html`)) {
  console.error("packages/web/dist is missing: run `pnpm --filter @easytestdata/web build` first");
  process.exit(1);
}
rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true });
