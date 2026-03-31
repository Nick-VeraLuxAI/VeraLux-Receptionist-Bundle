/**
 * Scrypt-based password hashing for the client portal (email + password).
 */
import { randomBytes, scryptSync, timingSafeEqual } from "crypto";

const KEYLEN = 64;
const SALT_LEN = 16;

const SCRYPT_OPTS = {
  N: 16384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
} as const;

export const PORTAL_PASSWORD_MIN_LEN = 8;
export const PORTAL_PASSWORD_MAX_LEN = 256;

export function normalizePortalEmail(raw: string): string {
  return String(raw || "")
    .trim()
    .toLowerCase();
}

/** Basic sanity check — not full RFC 5322 validation. */
export function isValidPortalEmailShape(emailNorm: string): boolean {
  if (emailNorm.length < 3 || emailNorm.length > 254) return false;
  const at = emailNorm.indexOf("@");
  if (at <= 0 || at === emailNorm.length - 1) return false;
  const local = emailNorm.slice(0, at);
  const domain = emailNorm.slice(at + 1);
  if (!local.length || !domain.includes(".")) return false;
  return true;
}

export function hashPortalPassword(password: string): string {
  const salt = randomBytes(SALT_LEN);
  const hash = scryptSync(password, salt, KEYLEN, SCRYPT_OPTS);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPortalPassword(password: string, stored: string): boolean {
  if (!stored || typeof stored !== "string" || !stored.startsWith("scrypt$")) {
    return false;
  }
  const parts = stored.split("$");
  if (parts.length !== 3) return false;
  try {
    const salt = Buffer.from(parts[1], "base64");
    const expected = Buffer.from(parts[2], "base64");
    const hash = scryptSync(password, salt, KEYLEN, SCRYPT_OPTS);
    if (hash.length !== expected.length) return false;
    return timingSafeEqual(hash, expected);
  } catch {
    return false;
  }
}
