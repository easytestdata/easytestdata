import { readFileSync } from "fs";
import { Command } from "commander";
import { planCommand } from "./commands/plan.js";
import { generateCommand } from "./commands/generate.js";
import { loadCommand } from "./commands/load.js";
import { purgeCommand } from "./commands/purge.js";
import { templatesCommand } from "./commands/templates.js";
import { presetsCommand } from "./commands/presets.js";
import { authCommand } from "./commands/auth.js";
import { uiCommand } from "./commands/ui.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

export function createProgram() {
  const program = new Command();

  program
    .name("easytestdata")
    .description(
      "EasyTestData: realistic test data for QuickBooks Online sandboxes.\n\n" +
        "Generate financially coherent customers, vendors, invoices, bills, payments, payroll " +
        "and journal entries offline, or load them into a QuickBooks Online (QBO) sandbox company."
    )
    .version(version)
    .showHelpAfterError("(add --help for usage)")
    .addHelpText(
      "after",
      `
Examples:
  $ easytestdata generate --template saas --scenario rapid-growth --seed 42 --start-date 2025-09-01 --format csv --output ./sample-data
  $ easytestdata plan --template restaurant --revenue 1.5M
  $ easytestdata auth                      # connect a QBO sandbox company
  $ easytestdata load --scenario healthy-small
  $ easytestdata purge
  $ easytestdata ui                        # open the web app on this computer

Not installed globally? Prefix any command with npx: npx easytestdata generate ...

Docs: https://easytestdata.com`
    );

  program.addCommand(generateCommand());
  program.addCommand(planCommand());
  program.addCommand(templatesCommand());
  program.addCommand(presetsCommand());
  program.addCommand(authCommand());
  program.addCommand(loadCommand());
  program.addCommand(purgeCommand());
  program.addCommand(uiCommand());

  return program;
}

export function run(argv) {
  const program = createProgram();
  if (argv.length <= 2) {
    program.outputHelp();
    return;
  }
  program.parse(argv);
}
