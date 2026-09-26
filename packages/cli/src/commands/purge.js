import { Command, Option } from "commander";
import chalk from "chalk";
import inquirer from "inquirer";
import { QboClient, purgeTransactions } from "@easytestdata/qbo-client";
import { loadConfig, requireConnection, persistRefreshToken } from "../config-loader.js";
import { createProgressRenderer } from "../progress.js";
import { withErrors } from "../errors.js";

export function purgeCommand() {
  return new Command("purge")
    .description("Delete generated data from your QBO sandbox company")
    .addOption(
      new Option(
        "--mode <mode>",
        "generated: only records carrying --tag; all: every transaction in the company"
      )
        .choices(["generated", "all"])
        .default("generated", "generated")
    )
    .addOption(
      new Option("--tag <tag>", "tag used when the data was loaded").default("EZTD", "EZTD")
    )
    .option("--connection <name>", "named connection from .easytestdata.json")
    .option("-y, --yes", "skip the confirmation prompt")
    .addHelpText(
      "after",
      `
Transactions are deleted; customers, vendors, employees and items are inactivated (QBO does
not allow deleting them). Generated records are identified by their tag field, not by name.`
    )
    .action(
      withErrors(async (opts) => {
        const fileConfig = loadConfig();
        const connCfg = requireConnection(fileConfig, opts.connection);

        if (!opts.yes) {
          if (!process.stdin.isTTY) {
            throw new Error("Refusing to purge without confirmation. Re-run with --yes.");
          }
          const what =
            opts.mode === "all"
              ? "ALL transactions (generated or not)"
              : `records tagged "${opts.tag}"`;
          const { confirmed } = await inquirer.prompt([
            {
              type: "confirm",
              name: "confirmed",
              message: `Delete ${what} from the QBO sandbox company? This cannot be undone.`,
              default: false
            }
          ]);
          if (!confirmed) {
            console.log(chalk.dim("Purge cancelled."));
            return;
          }
        }

        const abortController = new AbortController();
        process.on("SIGINT", () => {
          console.log(chalk.yellow("\nCancelling... waiting for the current operation to finish."));
          abortController.abort();
        });

        const client = new QboClient({
          ...connCfg,
          // Once Ctrl+C aborts, the client sends no further request.
          signal: abortController.signal,
          onTokenRefresh: (tokens) => persistRefreshToken(fileConfig, opts.connection, tokens)
        });
        const progress = createProgressRenderer();
        client.onRateLimitWait = (msg) => progress.warn(msg);

        progress.start("Purging data from QuickBooks Online...");
        let report;
        try {
          report = await purgeTransactions(
            client,
            { mode: opts.mode, tag: opts.tag },
            (event) => progress.update(event),
            abortController.signal
          );
        } catch (err) {
          progress.fail("Purge failed.");
          throw err;
        }
        progress.succeed("Purge complete.");

        console.log(chalk.bold("\nDeleted:"));
        for (const [entity, count] of Object.entries(report.deletedByEntity)) {
          if (count > 0) console.log(`  ${entity}: ${count}`);
        }
        console.log(chalk.bold(`  Total: ${report.deletedTotal}`));

        if (report.masterData) {
          console.log(chalk.bold("\nInactivated:"));
          for (const [key, count] of Object.entries(report.masterData)) {
            if (count > 0) console.log(`  ${key}: ${count}`);
          }
        }

        if (report.failureCount > 0) {
          console.log(chalk.yellow(`\n${report.failureCount} records could not be purged.`));
        }
      })
    );
}
