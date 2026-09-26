import { Command, Option } from "commander";
import fs from "fs";
import path from "path";
import chalk from "chalk";
import { exportToJson, exportToCsv } from "@easytestdata/core";
import { loadConfig } from "../config-loader.js";
import { addGenerationOptions, planFromOptions, GENERATION_HELP } from "../options.js";
import { formatPlanSummary } from "../summary.js";
import { withErrors } from "../errors.js";

export const DEFAULT_OUTPUT_DIR = "easytestdata-output";

function writeJson(json, output) {
  const target =
    output.endsWith("/") || (fs.existsSync(output) && fs.statSync(output).isDirectory())
      ? path.join(output, "plan.json")
      : output;
  fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  fs.writeFileSync(target, json, "utf8");
  return target;
}

function displayPath(p) {
  return path.isAbsolute(p) || p.startsWith(".") ? p : `./${p}`;
}

function writeCsv(tables, dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, csv] of Object.entries(tables)) {
    fs.writeFileSync(path.join(dir, `${name}.csv`), csv, "utf8");
  }
  return Object.keys(tables).length;
}

export function generateCommand() {
  return addGenerationOptions(
    new Command("generate").description(
      "Generate a synthetic dataset and save it as JSON or CSV (no QBO connection needed)"
    )
  )
    .addOption(
      new Option("-f, --format <format>", "output format")
        .choices(["json", "csv"])
        .default("json", "json")
    )
    .option(
      "-o, --output <path>",
      `JSON file or CSV directory (default: ./${DEFAULT_OUTPUT_DIR}/; JSON goes to stdout when piped)`
    )
    .addHelpText(
      "after",
      `${GENERATION_HELP}

Examples:
  $ easytestdata generate --template saas --scenario rapid-growth --seed 42 --start-date 2025-09-01 --format csv --output ./sample-data
  $ easytestdata generate -t restaurant -m 6 --revenue 1.5M --profit -50k
  $ easytestdata generate --seed 1 --start-date 2025-01-01 --months 12 | jq '.metrics'`
    )
    .action(
      withErrors(async (opts) => {
        const { plan, seedGiven } = planFromOptions(opts, loadConfig());
        const streamJson = opts.format === "json" && !opts.output && !process.stdout.isTTY;
        // Keep stdout clean for the JSON stream: messages go to stderr in that case.
        const log = streamJson ? console.error : console.log;

        if (streamJson) {
          process.stdout.on("error", (err) => {
            if (err.code === "EPIPE") process.exit(0);
            throw err;
          });
          process.stdout.write(exportToJson(plan) + "\n");
        } else if (opts.format === "csv") {
          const dir = opts.output || DEFAULT_OUTPUT_DIR;
          const count = writeCsv(exportToCsv(plan), dir);
          log(chalk.green(`Wrote ${count} CSV files to ${displayPath(dir).replace(/\/?$/, "/")}`));
        } else {
          const target = writeJson(
            exportToJson(plan) + "\n",
            opts.output || path.join(DEFAULT_OUTPUT_DIR, "plan.json")
          );
          log(chalk.green(`Wrote ${displayPath(target)}`));
        }
        log(`\n${formatPlanSummary(plan, { seedGiven })}`);
      })
    );
}
