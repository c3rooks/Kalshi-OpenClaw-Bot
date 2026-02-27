import fs from "node:fs";
import path from "node:path";
import { logger } from "../utils/logger";
import type { Notifier } from "./notifier";

export type CommandState = {
  stopNewTrades: boolean;
};

export class CommandListener {
  private watcher?: fs.FSWatcher;

  constructor(
    private readonly commandFilePath: string,
    private readonly state: CommandState,
    private readonly notifier: Notifier,
    private readonly onStatusRequest: () => Promise<string>
  ) {}

  start(): void {
    const abs = path.resolve(this.commandFilePath);
    const dir = path.dirname(abs);
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(abs)) {
      fs.writeFileSync(abs, "", "utf8");
    }

    const processCommand = async () => {
      try {
        const raw = fs.readFileSync(abs, "utf8").trim().toUpperCase();
        if (!raw) return;

        if (raw === "STOP") {
          this.state.stopNewTrades = true;
          await this.notifier.notify("CONFIRMED: STOP command applied. STOP_NEW_TRADES=true (existing positions still monitored).");
          logger.warn("Control command applied", { source: "commands_file", command: "STOP", stopNewTrades: true });
        } else if (raw === "START") {
          this.state.stopNewTrades = false;
          await this.notifier.notify("CONFIRMED: START command applied. STOP_NEW_TRADES=false (new entries allowed).");
          logger.info("Control command applied", { source: "commands_file", command: "START", stopNewTrades: false });
        } else if (raw === "STATUS") {
          const status = await this.onStatusRequest();
          await this.notifier.notify(`CONFIRMED: STATUS command. ${status}`);
          logger.info("Control command applied", { source: "commands_file", command: "STATUS" });
        } else {
          logger.warn("Unknown command in command file", { raw });
        }

        fs.writeFileSync(abs, "", "utf8");
      } catch (err) {
        logger.error("Failed processing command file", { error: (err as Error).message });
      }
    };

    this.watcher = fs.watch(abs, { persistent: true }, () => {
      void processCommand();
    });

    void processCommand();
    logger.info("Command listener started", { commandFilePath: abs });
  }

  stop(): void {
    this.watcher?.close();
  }
}
