import { insertEvent } from "../db/db";

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

function ts(): string {
  return new Date().toISOString();
}

function scrubSecrets(payload: string): string {
  return payload
    .replace(/(PRIVATE_KEY=)([^\s]+)/gi, "$1[REDACTED]")
    .replace(/(KALSHI_PRIVATE_KEY_PEM=)([^\s]+)/gi, "$1[REDACTED]")
    .replace(/(KALSHI-ACCESS-SIGNATURE["']?\s*[:=]\s*["']?)([^"'\s]+)/gi, "$1[REDACTED]")
    .replace(/(KALSHI-ACCESS-KEY["']?\s*[:=]\s*["']?)([^"'\s]+)/gi, "$1[REDACTED]")
    .replace(/(Authorization:\s*Bearer\s+)([^\s]+)/gi, "$1[REDACTED]");
}

export function log(level: LogLevel, message: string, data?: unknown): void {
  const line = `[${ts()}] ${level} ${message}`;
  const safeLine = scrubSecrets(line);
  const safeJson = data == null ? undefined : scrubSecrets(JSON.stringify(data));
  if (safeJson) {
    // eslint-disable-next-line no-console
    console.log(safeLine, safeJson);
  } else {
    // eslint-disable-next-line no-console
    console.log(safeLine);
  }
  try {
    insertEvent(level, message, data);
  } catch {
    // logger is non-fatal during bootstrap
  }
}

export const logger = {
  debug: (msg: string, data?: unknown) => log("DEBUG", msg, data),
  info: (msg: string, data?: unknown) => log("INFO", msg, data),
  warn: (msg: string, data?: unknown) => log("WARN", msg, data),
  error: (msg: string, data?: unknown) => log("ERROR", msg, data)
};
