import { Command } from "commander";
import chalk from "chalk";
import { QboClient, loadPlanIntoQbo, purgeTransactions } from "@easytestdata/qbo-client";
import { loadConfig, requireConnection, persistRefreshToken } from "../config-loader.js";
import { createProgressRenderer } from "../progress.js";
import { addGenerationOptions, planFromOptions, GENERATION_HELP } from "../options.js";
import { formatPlanSummary } from "../summary.js";
import { withErrors } from "../errors.js";

export function loadCommand() {
  return addGenerationOptions(
    new Command("load").description("Generate a dataset and load it into your QBO sandbox company")
  )
    .option("--connection <name>", "named connection from .easytestdata.json")
    .option("--dry-run", "generate and summarize the plan without touching QBO")
    .option("--clear-first", "purge previously generated data (same tag) before loading")
    .addHelpText(
      "after",
      `${GENERATION_HELP}

Requires a connected QBO sandbox company: run \`easytestdata auth\` first.`
    )
    .action(
      withErrors(async (opts) => {
        const fileConfig = loadConfig();
        const connCfg = opts.dryRun ? null : requireConnection(fileConfig, opts.connection);
        const { plan, seedGiven } = planFromOptions(opts, fileConfig);
        console.log(formatPlanSummary(plan, { seedGiven }));

        if (opts.dryRun) {
          console.log(chalk.dim("\nDry run: nothing was sent to QBO."));
          return;
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

        try {
          console.log();
          if (opts.clearFirst) {
            progress.start(`Purging previously generated data tagged ${plan.tag}...`);
            await purgeTransactions(
              client,
              { mode: "generated", tag: plan.tag },
              (event) => progress.update(event),
              abortController.signal
            );
            progress.succeed("Previously generated data purged.");
          }

          progress.start("Loading into QuickBooks Online...");
          // config: null lets the loader derive accounts/items from plan.meta.industry.
          const result = await loadPlanIntoQbo(
            client,
            plan,
            null,
            (event) => progress.update(event),
            abortController.signal
          );
          progress.succeed("Load complete.");

          console.log(chalk.bold("\nCreated in QBO:"));
          for (const [key, value] of Object.entries(result.counts)) {
            if (value > 0) console.log(`  ${key}: ${value}`);
          }
          if (result.failures.length > 0) {
            console.log(chalk.yellow(`\n${result.failures.length} records failed to load:`));
            for (const f of result.failures.slice(0, 10)) {
              console.log(chalk.dim(`  ${f.type || f.entity}: ${f.message}`));
            }
            if (result.failures.length > 10) {
              console.log(chalk.dim(`  ... and ${result.failures.length - 10} more`));
            }
          }
          console.log(chalk.dim(`\nRemove it again with: easytestdata purge --tag ${plan.tag}`));
        } catch (err) {
          progress.fail("Load failed.");
          throw err;
        }
      })
    );
}
