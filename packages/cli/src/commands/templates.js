import { Command } from "commander";
import chalk from "chalk";
import { requireIndustryTemplate, listIndustryTemplates } from "@easytestdata/core";
import { withErrors } from "../errors.js";

export function templatesCommand() {
  return new Command("templates")
    .description("List the industry templates")
    .option("--inspect <name>", "show details for one template")
    .option("--json", "output as JSON")
    .action(
      withErrors((opts) => {
        if (opts.inspect) {
          const template = requireIndustryTemplate(opts.inspect);
          if (opts.json) {
            console.log(JSON.stringify(template, null, 2));
            return;
          }

          console.log(chalk.bold(`\n${template.name}`));
          console.log(chalk.dim(template.description));

          console.log(chalk.bold("\nService items:"));
          for (const item of template.serviceItems || []) {
            console.log(`  ${item.suffix} (${(item.weight * 100).toFixed(0)}%)`);
          }

          console.log(chalk.bold("\nExpense categories:"));
          for (const cat of template.expenseCategories || []) {
            console.log(`  ${cat.name} (${(cat.weight * 100).toFixed(0)}%)`);
          }

          if (template.ratios && Object.keys(template.ratios).length > 0) {
            console.log(chalk.bold("\nRatios:"));
            for (const [key, val] of Object.entries(template.ratios)) {
              console.log(`  ${key}: ${val}`);
            }
          }
          return;
        }

        const templates = listIndustryTemplates();
        if (opts.json) {
          console.log(JSON.stringify(templates, null, 2));
          return;
        }

        console.log(chalk.bold("\nIndustry templates\n"));
        for (const template of templates) {
          console.log(`  ${chalk.cyan(template.id.padEnd(25))} ${template.name}`);
          console.log(`  ${"".padEnd(25)} ${chalk.dim(template.description)}`);
        }
        console.log(
          chalk.dim(
            "\nDetails: easytestdata templates --inspect saas. Use with -t/--template <name>."
          )
        );
      })
    );
}
