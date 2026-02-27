import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config";
import { getRuntimeBotConfig } from "../settings/runtimeConfig";
import { logger } from "../utils/logger";

const execFileAsync = promisify(execFile);

export interface Notifier {
  notify(message: string): Promise<void>;
}

class ConsoleNotifier implements Notifier {
  async notify(message: string): Promise<void> {
    logger.info(`[notify] ${message}`);
  }
}

class OpenClawNotifier implements Notifier {
  constructor(
    private readonly cmdPath: string,
    private readonly target: string
  ) {}

  async notify(message: string): Promise<void> {
    try {
      await execFileAsync(this.cmdPath, [
        "message",
        "send",
        "--channel",
        "telegram",
        "--target",
        this.target,
        "--message",
        message
      ]);
      logger.info("Notification sent via OpenClaw command", { cmd: this.cmdPath });
    } catch (err) {
      logger.error("OpenClaw notifier command failed; falling back to log", {
        error: (err as Error).message
      });
      logger.info("[notify-fallback] message delivery failed");
    }
  }
}

export function createNotifier(): Notifier {
  const runtime = getRuntimeBotConfig();
  if (
    runtime.notificationsEnabled &&
    runtime.openclawSendMode === "cli" &&
    runtime.openclawTelegramTarget.trim()
  ) {
    return new OpenClawNotifier(runtime.openclawBinaryPath || "openclaw", runtime.openclawTelegramTarget.trim());
  }
  if (config.telegramNotify && config.openclawSendCmd) {
    return new OpenClawNotifier(config.openclawSendCmd, runtime.openclawTelegramTarget.trim() || "telegram");
  }
  return new ConsoleNotifier();
}

export async function sendOpenClawTestMessage(
  cmdPath: string,
  target: string,
  message: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    await execFileAsync(cmdPath, [
      "message",
      "send",
      "--channel",
      "telegram",
      "--target",
      target,
      "--message",
      message
    ]);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
