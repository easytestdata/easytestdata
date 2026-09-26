import { Command, Option } from "commander";
import chalk from "chalk";
import inquirer from "inquirer";
import { loadConfig, saveConnection, CONFIG_FILE } from "../config-loader.js";
import { runOAuthFlow, DEFAULT_OAUTH_PORT } from "../oauth.js";
import { wholeNumber } from "../options.js";
import { withErrors } from "../errors.js";

/** Ask for any missing Intuit app credentials (interactive terminals only). */
export async function promptForAppCredentials({ clientId, clientSecret }) {
  if (clientId && clientSecret) return { clientId, clientSecret };
  if (!process.stdin.isTTY) {
    throw new Error(
      "Client ID and secret are required. Pass --client-id/--client-secret or set " +
        "QBO_CLIENT_ID/QBO_CLIENT_SECRET."
    );
  }
  console.log(
    chalk.dim("Find these at developer.intuit.com > your app > Keys & credentials > Development.\n")
  );
  const answers = await inquirer.prompt([
    {
      type: "input",
      name: "clientId",
      message: "Intuit app Client ID (Development):",
      when: !clientId,
      validate: (v) => v.trim().length > 0 || "Required"
    },
    {
      type: "password",
      name: "clientSecret",
      message: "Intuit app Client Secret (Development):",
      mask: "*",
      when: !clientSecret,
      validate: (v) => v.trim().length > 0 || "Required"
    }
  ]);
  return {
    clientId: clientId || answers.clientId.trim(),
    clientSecret: clientSecret || answers.clientSecret.trim()
  };
}

/** Run the browser OAuth flow and save the resulting connection to .easytestdata.json. */
export async function connectSandbox({ config, connection, clientId, clientSecret, port }) {
  const tokens = await runOAuthFlow({ clientId, clientSecret, port });
  saveConnection(config, connection, {
    clientId,
    clientSecret,
    realmId: tokens.realmId,
    refreshToken: tokens.refreshToken,
    accessToken: tokens.accessToken
  });
  console.log(chalk.green(`\nConnection "${connection}" saved to ${CONFIG_FILE}.`));
  console.log(chalk.dim(`Keep ${CONFIG_FILE} out of version control: it contains credentials.`));
  console.log(
    `Next: ${chalk.bold("easytestdata load --template saas --dry-run")} to preview, then drop --dry-run.`
  );
}

export function authCommand() {
  return new Command("auth")
    .description(
      "Connect a QBO sandbox company via OAuth (prints the Intuit consent URL to open in your browser)"
    )
    .option("--client-id <id>", "Intuit app client ID (or QBO_CLIENT_ID)")
    .option("--client-secret <secret>", "Intuit app client secret (or QBO_CLIENT_SECRET)")
    .option("--port <port>", "local callback port", wholeNumber(1, 65535), DEFAULT_OAUTH_PORT)
    .addOption(
      new Option("--connection <name>", "name to save the connection under").default(
        "default",
        "default"
      )
    )
    .action(
      withErrors(async (opts) => {
        const config = loadConfig();
        const { clientId, clientSecret } = await promptForAppCredentials({
          clientId: opts.clientId || process.env.QBO_CLIENT_ID,
          clientSecret: opts.clientSecret || process.env.QBO_CLIENT_SECRET
        });
        await connectSandbox({
          config,
          connection: opts.connection,
          clientId,
          clientSecret,
          port: opts.port
        });
      })
    );
}
