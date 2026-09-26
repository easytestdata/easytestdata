import { Command } from "commander";
import { loadConfig } from "../config-loader.js";
import { addGenerationOptions, planFromOptions, GENERATION_HELP } from "../options.js";
import { formatPlanSummary } from "../summary.js";
import { withErrors } from "../errors.js";

export function planCommand() {
  return addGenerationOptions(
    new Command("plan").description(
      "Preview what would be generated: counts and totals (no QBO connection needed)"
    )
  )
    .option("--json", "print the plan metrics as JSON")
    .addHelpText("after", GENERATION_HELP)
    .action(
      withErrors(async (opts) => {
        const { plan, seedGiven } = planFromOptions(opts, loadConfig());
        if (opts.json) {
          console.log(JSON.stringify({ meta: plan.meta, metrics: plan.metrics }, null, 2));
          return;
        }
        console.log(formatPlanSummary(plan, { seedGiven }));
      })
    );
}
