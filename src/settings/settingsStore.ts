import { getDb } from "../db/db";

export type SettingValue = unknown;

function ensureSettingsTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_ts INTEGER NOT NULL
    );
  `);
}

export function setSetting(key: string, value: SettingValue): void {
  ensureSettingsTable();
  const db = getDb();
  const text = value == null ? null : JSON.stringify(value);
  db.prepare(
    `INSERT INTO settings(key, value, updated_ts) VALUES(?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_ts=excluded.updated_ts`
  ).run(key, text, Date.now());
}

export function getSetting<T = unknown>(key: string, fallback?: T): T | undefined {
  ensureSettingsTable();
  const db = getDb();
  const row = db.prepare(`SELECT value FROM settings WHERE key=?`).get(key) as { value: string | null } | undefined;
  if (!row || row.value == null) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function getSettings(prefix?: string): Record<string, unknown> {
  ensureSettingsTable();
  const db = getDb();
  let rows: Array<{ key: string; value: string | null }> = [];
  if (prefix) {
    rows = db.prepare(`SELECT key, value FROM settings WHERE key LIKE ? ORDER BY key ASC`).all(`${prefix}%`) as Array<{
      key: string;
      value: string | null;
    }>;
  } else {
    rows = db.prepare(`SELECT key, value FROM settings ORDER BY key ASC`).all() as Array<{ key: string; value: string | null }>;
  }

  const out: Record<string, unknown> = {};
  for (const r of rows) {
    try {
      out[r.key] = r.value == null ? null : JSON.parse(r.value);
    } catch {
      out[r.key] = r.value;
    }
  }
  return out;
}
