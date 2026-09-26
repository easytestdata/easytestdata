import ora from "ora";
import chalk from "chalk";

export function createProgressRenderer() {
  let spinner = null;
  let startTime = Date.now();

  function elapsed() {
    const seconds = Math.floor((Date.now() - startTime) / 1000);
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  }

  return {
    start(message) {
      startTime = Date.now();
      spinner = ora({ text: message, color: "cyan" }).start();
    },

    update({ step, totalSteps, message }) {
      if (!spinner) return;
      const progress = chalk.dim(`[${step}/${totalSteps}]`);
      const time = chalk.dim(`(${elapsed()})`);
      spinner.text = `${progress} ${message} ${time}`;
    },

    succeed(message) {
      if (spinner) {
        spinner.succeed(`${message} ${chalk.dim(`(${elapsed()})`)}`);
        spinner = null;
      }
    },

    fail(message) {
      if (spinner) {
        spinner.fail(message);
        spinner = null;
      }
    },

    warn(message) {
      if (spinner) {
        spinner.warn(message);
      } else {
        console.warn(chalk.yellow(message));
      }
    },

    info(message) {
      if (spinner) {
        spinner.info(message);
        spinner = ora({ color: "cyan" }).start();
      } else {
        console.log(chalk.blue(message));
      }
    }
  };
}
