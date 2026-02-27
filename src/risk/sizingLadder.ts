import { config } from "../config";
import { getBotState, setBotState } from "../db/db";
import { getStats } from "../db/queries";
import { logger } from "../utils/logger";

const KEY_SIZE = "ladder.current_size";
const KEY_STREAK = "ladder.consecutive_wins";
const KEY_LAST_WINDOW_MARK = "ladder.last_window_trade_mark";

function toNum(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export class SizingLadder {
  private currentSizeUsd: number;
  private consecutiveWins: number;
  private lastWindowTradeMark: number;

  constructor() {
    this.currentSizeUsd = toNum(getBotState(KEY_SIZE), config.ladderStartSizeUsd);
    this.consecutiveWins = toNum(getBotState(KEY_STREAK), 0);
    this.lastWindowTradeMark = toNum(getBotState(KEY_LAST_WINDOW_MARK), 0);
  }

  getCurrentSizeUsd(): number {
    return Math.max(config.ladderStartSizeUsd, this.currentSizeUsd);
  }

  onResolvedOutcome(outcome: "WIN" | "LOSS"): void {
    if (outcome === "LOSS") {
      this.currentSizeUsd = config.ladderStartSizeUsd;
      this.consecutiveWins = 0;
      this.persist();
      logger.warn("Sizing ladder reset after loss", { sizeUsd: this.currentSizeUsd });
      return;
    }

    this.consecutiveWins += 1;
    if (this.consecutiveWins >= config.ladderConsecutiveWinsStep) {
      this.currentSizeUsd += config.ladderStepUsd;
      this.consecutiveWins = 0;
      logger.info("Sizing ladder stepped up by consecutive wins", {
        sizeUsd: this.currentSizeUsd,
        winsStep: config.ladderConsecutiveWinsStep
      });
    }
    this.persist();
  }

  evaluateWindowStep(): void {
    const stats = getStats({ dryRun: true, stopNewTrades: false });
    if (stats.totalTrades < config.ladderTradesWindow) return;
    if (stats.totalTrades < this.lastWindowTradeMark + config.ladderTradesWindow) return;

    if (stats.winRate > config.ladderMinWinRate && stats.fillRate > config.ladderMinFillRate) {
      this.currentSizeUsd += config.ladderStepUsd;
      this.lastWindowTradeMark = stats.totalTrades;
      this.persist();
      logger.info("Sizing ladder stepped up by rolling performance window", {
        sizeUsd: this.currentSizeUsd,
        totalTrades: stats.totalTrades,
        winRate: stats.winRate,
        fillRate: stats.fillRate
      });
      return;
    }

    this.lastWindowTradeMark = stats.totalTrades;
    this.persist();
  }

  private persist(): void {
    setBotState(KEY_SIZE, String(this.currentSizeUsd));
    setBotState(KEY_STREAK, String(this.consecutiveWins));
    setBotState(KEY_LAST_WINDOW_MARK, String(this.lastWindowTradeMark));
  }
}
