import chalk from "chalk";

/** Wrap a command action: print a one-line error (stack only with DEBUG=1) and exit 1. */
export function withErrors(action) {
  return async (...args) => {
    try {
      await action(...args);
    } catch (err) {
      console.error(chalk.red(`Error: ${err.message}`));
      if (process.env.DEBUG) console.error(err.stack);
      process.exitCode = 1;
    }
  };
}
