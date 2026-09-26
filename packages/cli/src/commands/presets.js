import { Command } from "commander";
import chalk from "chalk";
import { requireScenarioPreset, listScenarioPresets } from "@easytestdata/core";
import { withErrors } from "../errors.js";

export function presetsCommand() {
  // `scenarios` matches the --scenario flag; `presets` stays for existing scripts.
  return new Command("scenarios")
    .alias("presets")
    .description("List the scenarios (the --scenario ids)")
    .option("--inspect <id>", "show details for one scenario")
    .option("--json", "output as JSON")
    .action(
      withErrors((opts) => {
        if (opts.inspect) {
          const preset = requireScenarioPreset(opts.inspect);
          if (opts.json) {
            console.log(JSON.stringify(preset, null, 2));
            return;
          }

          console.log(chalk.bold(`\n${preset.name}`));
          console.log(chalk.dim(preset.description));

          console.log(chalk.bold("\nParameters:"));
          for (const [key, val] of Object.entries(preset.request || {})) {
            console.log(`  ${key}: ${val}`);
          }

          if (preset.ratioOverrides && Object.keys(preset.ratioOverrides).length > 0) {
            console.log(chalk.bold("\nRatio overrides:"));
            for (const [key, val] of Object.entries(preset.ratioOverrides)) {
              console.log(`  ${key}: ${val}`);
            }
          }
          return;
        }

        const presets = listScenarioPresets();
        if (opts.json) {
          console.log(JSON.stringify(presets, null, 2));
          return;
        }

        console.log(chalk.bold("\nScenarios\n"));
        for (const preset of presets) {
          console.log(`  ${chalk.cyan(preset.id.padEnd(20))} ${preset.name}`);
          console.log(`  ${"".padEnd(20)} ${chalk.dim(preset.description)}`);
        }
        console.log(
          chalk.dim(
            "\nDetails: easytestdata scenarios --inspect cash-crisis. Use with -p/--scenario <id>;\n" +
              "explicit flags such as --revenue still win over the preset."
          )
        );
      })
    );
}
