export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function nowTs(): number {
  return Date.now();
}

export function toIso(ts: number): string {
  return new Date(ts).toISOString();
}

export function secToMs(sec: number): number {
  return sec * 1000;
}

export function startOfUtcDay(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
