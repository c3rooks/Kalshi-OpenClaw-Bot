import crypto from "node:crypto";
import { getDb } from "../db/db";
import { logger } from "../utils/logger";

const SERVICE_NAME = "openclaw-kalshi-bot";

function getMasterKey(): Buffer {
  const key = process.env.LOCAL_MASTER_KEY;
  if (!key || key.length < 16) {
    throw new Error("LOCAL_MASTER_KEY is required for encrypted secret fallback");
  }
  return crypto.createHash("sha256").update(key).digest();
}

function encrypt(value: string): string {
  const key = getMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

function decrypt(payload: string): string {
  const b = Buffer.from(payload, "base64");
  const iv = b.subarray(0, 12);
  const tag = b.subarray(12, 28);
  const data = b.subarray(28);
  const key = getMasterKey();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

async function tryLoadKeytar(): Promise<any | null> {
  try {
    // Avoid compile-time dependency on keytar; load dynamically when installed.
    const dyn = new Function("m", "return import(m)");
    const m: any = await dyn("keytar");
    return m?.default ?? m;
  } catch {
    return null;
  }
}

function ensureSecretsTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS secrets (
      name TEXT PRIMARY KEY,
      encrypted_value TEXT NOT NULL,
      updated_ts INTEGER NOT NULL
    );
  `);
}

export async function setSecret(name: string, value: string): Promise<void> {
  const keytar = await tryLoadKeytar();
  if (keytar) {
    await keytar.setPassword(SERVICE_NAME, name, value);
    return;
  }

  ensureSecretsTable();
  const db = getDb();
  const encrypted = encrypt(value);
  db.prepare(
    `INSERT INTO secrets(name, encrypted_value, updated_ts) VALUES(?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET encrypted_value=excluded.encrypted_value, updated_ts=excluded.updated_ts`
  ).run(name, encrypted, Date.now());
}

export async function getSecret(name: string): Promise<string | null> {
  const keytar = await tryLoadKeytar();
  if (keytar) {
    const v = await keytar.getPassword(SERVICE_NAME, name);
    return v ?? null;
  }

  ensureSecretsTable();
  const db = getDb();
  const row = db.prepare(`SELECT encrypted_value FROM secrets WHERE name=?`).get(name) as
    | { encrypted_value: string }
    | undefined;
  if (!row) return null;
  try {
    return decrypt(row.encrypted_value);
  } catch (err) {
    logger.error("Failed decrypting local secret", { name, error: (err as Error).message });
    return null;
  }
}

export async function deleteSecret(name: string): Promise<void> {
  const keytar = await tryLoadKeytar();
  if (keytar) {
    await keytar.deletePassword(SERVICE_NAME, name);
    return;
  }

  ensureSecretsTable();
  const db = getDb();
  db.prepare(`DELETE FROM secrets WHERE name=?`).run(name);
}

export async function getSecretMask(name: string): Promise<string | null> {
  const s = await getSecret(name);
  if (!s) return null;
  const suffix = s.slice(-4);
  return `••••••${suffix}`;
}
