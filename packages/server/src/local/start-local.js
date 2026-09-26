import { spawn } from "node:child_process";

/** Opens `url` in the default browser; any failure (no browser, headless machine) is ignored. */
function openBrowser(url) {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Opening the browser is a convenience; the URL is printed anyway.
  }
}

/**
 * Starts the app in local mode; resolves { url, close() }. With `handleSignals`, Ctrl+C / SIGTERM
 * stop it cleanly from the moment startup begins (a signal during first-run migrations waits for
 * startup, then closes); a second signal exits at once (start.js handleShutdownSignals).
 */
export async function startLocalServer({
  port = 28080,
  dataDir,
  open = true,
  handleSignals = false
} = {}) {
  process.env.DEPLOYMENT = "local";
  delete process.env.DATABASE_URL; // an inherited Cloud URL must never be used locally
  process.env.NODE_ENV ||= "production";
  // A terminal app, not a server log: warnings and errors only (the web app polls every 2 s while
  // a job runs). LOG_LEVEL still overrides.
  process.env.LOG_LEVEL ||= "warn";
  process.env.PORT = String(port);
  if (dataDir) process.env.EASYTESTDATA_DATA_DIR = dataDir;
  // config reads env at import time
  const { bootstrap, handleShutdownSignals } = await import("../start.js");
  const starting = bootstrap();
  if (handleSignals) handleShutdownSignals(() => starting.then(({ close }) => close()));
  const { close } = await starting;
  const url = `http://localhost:${port}`;
  if (open) openBrowser(url);
  return { url, close };
}
