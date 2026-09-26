import pino from "pino";
import { config } from "./config.js";

/**
 * JSON logs everywhere; human-readable ones only with LOG_PRETTY=1 (set by the server's dev
 * script), since pino-pretty is a devDependency and is not installed with the published package.
 */
export function loggerOptions(env = process.env, nodeEnv = config.nodeEnv) {
  return {
    level: env.LOG_LEVEL || (nodeEnv !== "production" ? "debug" : "info"),
    ...(env.LOG_PRETTY === "1" && {
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          ignore: "pid,hostname",
          translateTime: "HH:MM:ss"
        }
      }
    })
  };
}

export const logger = pino(loggerOptions());
