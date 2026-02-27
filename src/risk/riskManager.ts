import { getDailyPnl, getOpenPositionCount } from "../db/queries";
import { getTodayOrderCount } from "../db/queries";

export type RiskInput = {
  maxOpenPositions: number;
  dailyLossLimitUsd: number;
  maxOrdersPerDay: number;
  stopNewTrades: boolean;
};

export class RiskManager {
  constructor(private readonly input: RiskInput) {}

  canOpenNewPosition(): { ok: boolean; reason?: string } {
    if (this.input.stopNewTrades) {
      return { ok: false, reason: "STOP_NEW_TRADES is enabled" };
    }

    const open = getOpenPositionCount();
    if (open >= this.input.maxOpenPositions) {
      return { ok: false, reason: `max open positions reached (${open}/${this.input.maxOpenPositions})` };
    }

    const todayPnl = getDailyPnl();
    if (todayPnl <= -Math.abs(this.input.dailyLossLimitUsd)) {
      return {
        ok: false,
        reason: `daily loss limit breached: ${todayPnl.toFixed(2)} <= -${Math.abs(
          this.input.dailyLossLimitUsd
        ).toFixed(2)}`
      };
    }

    const orderCountToday = getTodayOrderCount();
    if (orderCountToday >= this.input.maxOrdersPerDay) {
      return { ok: false, reason: `max orders/day reached (${orderCountToday}/${this.input.maxOrdersPerDay})` };
    }

    return { ok: true };
  }

  setStopNewTrades(stop: boolean): void {
    this.input.stopNewTrades = stop;
  }

  getStopNewTrades(): boolean {
    return this.input.stopNewTrades;
  }
}
