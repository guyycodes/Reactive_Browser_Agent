import pino from "pino";
import { env } from "./env.js";

const isDev = env.NODE_ENV === "development";

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: "agent" },
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      'headers["x-api-key"]',
      "ANTHROPIC_API_KEY",
      "*.ANTHROPIC_API_KEY",
      "*.password",
      "*.token",
    ],
    censor: "[REDACTED]",
  },
  ...(isDev
    ? {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:HH:MM:ss.l",
            ignore: "pid,hostname,service",
          },
        },
      }
    : {}),
});

export type Logger = typeof logger;
