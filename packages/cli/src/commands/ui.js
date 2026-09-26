import { Command, InvalidArgumentError } from "commander";

function portNumber(value) {
  const port = Number(value);
  if (!/^\d+$/.test(value) || port < 1 || port > 65535) {
    throw new InvalidArgumentError("Use a port number from 1 to 65535.");
  }
  return port;
}

export function uiCommand() {
  return new Command("ui")
    .description("Open the EasyTestData app on this computer (no account needed)")
    .option("--port <n>", "port to listen on", portNumber, 28080)
    .option("--data-dir <path>", "where to keep data (default ~/.easytestdata)")
    .option("--no-open", "do not open the browser")
    .action(async (opts) => {
      // Loaded only here, so the other commands never pay for the server's dependencies.
      const { startLocalServer } = await import("@easytestdata/server/local");
      let server;
      try {
        server = await startLocalServer({
          port: opts.port,
          dataDir: opts.dataDir,
          open: opts.open,
          // Ctrl+C stops cleanly (jobs drained, database closed), even during startup.
          handleSignals: true
        });
      } catch (err) {
        console.error(`Could not start EasyTestData: ${err.message}`);
        process.exit(1);
      }
      console.log(`EasyTestData is running at ${server.url}  (Ctrl+C to stop)`);
    });
}
