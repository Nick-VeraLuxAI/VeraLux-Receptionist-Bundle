/**
 * Staff console (/admin) email + password.
 * Env INSTALLER_* is bootstrap; first in-app save writes hashed credentials to Postgres.
 */
import { timingSafeEqual } from "crypto";
import {
  getConsoleCredentialRow,
  getTenantIdByPortalEmail,
  upsertConsoleCredentials,
} from "./db";
import {
  hashPortalPassword,
  isValidPortalEmailShape,
  normalizePortalEmail,
  PORTAL_PASSWORD_MAX_LEN,
  PORTAL_PASSWORD_MIN_LEN,
  verifyPortalPassword,
} from "./portalPassword";

export function timingSafeTextEqual(a: string, b: string): boolean {
  const left = Buffer.from(String(a), "utf8");
  const right = Buffer.from(String(b), "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function getInstallerUsername(): string {
  return (process.env.INSTALLER_USERNAME || "VeraLux").trim() || "VeraLux";
}

export function getAdminConsoleEmail(): string {
  return (process.env.ADMIN_CONSOLE_EMAIL || "").trim().toLowerCase();
}

/** Matches docker-compose: INSTALLER_PASSWORD defaults empty; then ADMIN_API_KEY. */
export function getInstallerPassword(): string {
  return (
    (process.env.INSTALLER_PASSWORD || "").trim() ||
    (process.env.ADMIN_API_KEY || "").trim() ||
    ""
  );
}

export function installerConsoleLoginIdOk(email: string): boolean {
  const raw = String(email || "").trim();
  if (!raw) return false;
  if (timingSafeTextEqual(raw, getInstallerUsername())) return true;
  const configured = getAdminConsoleEmail();
  if (configured && timingSafeTextEqual(raw.toLowerCase(), configured)) {
    return true;
  }
  return false;
}

export type ConsoleLoginResult =
  | { ok: true; email: string; source: "database" | "environment" }
  | { ok: false; error: "invalid_credentials" | "console_login_not_configured" };

export async function verifyConsoleLogin(
  emailRaw: string,
  password: string
): Promise<ConsoleLoginResult> {
  const email = String(emailRaw || "").trim();
  const pass = String(password || "");
  if (!email || !pass) {
    return { ok: false, error: "invalid_credentials" };
  }

  const db = await getConsoleCredentialRow();
  const emailNorm = normalizePortalEmail(email);

  if (db && emailNorm === db.emailNorm) {
    return verifyPortalPassword(pass, db.passwordHash)
      ? { ok: true, email: db.emailNorm, source: "database" }
      : { ok: false, error: "invalid_credentials" };
  }

  const envPass = getInstallerPassword();
  if (!envPass && !db) {
    return { ok: false, error: "console_login_not_configured" };
  }
  if (!envPass || !installerConsoleLoginIdOk(email)) {
    return { ok: false, error: "invalid_credentials" };
  }
  if (!timingSafeTextEqual(pass, envPass)) {
    return { ok: false, error: "invalid_credentials" };
  }
  return { ok: true, email: emailNorm || email, source: "environment" };
}

export type ConsoleAccountSnapshot = {
  email: string;
  source: "database" | "environment";
  emailIsPlaceholder: boolean;
  updatedAt: string | null;
  passwordMinLength: number;
};

export async function describeConsoleAccount(): Promise<ConsoleAccountSnapshot> {
  const db = await getConsoleCredentialRow();
  const email =
    db?.emailNorm || getAdminConsoleEmail() || getInstallerUsername();
  return {
    email,
    source: db ? "database" : "environment",
    emailIsPlaceholder: !isValidPortalEmailShape(normalizePortalEmail(email)),
    updatedAt: db?.updatedAt ?? null,
    passwordMinLength: PORTAL_PASSWORD_MIN_LEN,
  };
}

export type ChangeConsoleCredentialsError =
  | "current_password_required"
  | "email_or_password_required"
  | "invalid_current_password"
  | "invalid_email"
  | "email_required"
  | "email_already_registered"
  | "password_too_short"
  | "password_too_long"
  | "console_login_not_configured";

export async function changeConsoleCredentials(params: {
  currentPassword: string;
  email?: string;
  newPassword?: string;
}): Promise<
  | { ok: true; email: string }
  | { ok: false; error: ChangeConsoleCredentialsError }
> {
  const current = String(params.currentPassword || "");
  const nextEmailRaw =
    typeof params.email === "string" ? params.email.trim() : "";
  const nextPass =
    typeof params.newPassword === "string" ? params.newPassword : "";

  if (!current) {
    return { ok: false, error: "current_password_required" };
  }
  if (!nextEmailRaw && !nextPass) {
    return { ok: false, error: "email_or_password_required" };
  }

  const db = await getConsoleCredentialRow();
  const envPass = getInstallerPassword();
  let currentOk = false;
  if (db) {
    currentOk = verifyPortalPassword(current, db.passwordHash);
  } else if (envPass) {
    currentOk = timingSafeTextEqual(current, envPass);
  } else {
    return { ok: false, error: "console_login_not_configured" };
  }
  if (!currentOk) {
    return { ok: false, error: "invalid_current_password" };
  }

  const nextEmail = nextEmailRaw
    ? normalizePortalEmail(nextEmailRaw)
    : db?.emailNorm || getAdminConsoleEmail();
  if (!nextEmail || !isValidPortalEmailShape(nextEmail)) {
    return { ok: false, error: nextEmailRaw ? "invalid_email" : "email_required" };
  }

  if (nextPass) {
    if (nextPass.length < PORTAL_PASSWORD_MIN_LEN) {
      return { ok: false, error: "password_too_short" };
    }
    if (nextPass.length > PORTAL_PASSWORD_MAX_LEN) {
      return { ok: false, error: "password_too_long" };
    }
  }

  const taken = await getTenantIdByPortalEmail(nextEmail);
  if (taken) {
    return { ok: false, error: "email_already_registered" };
  }

  const passwordHash = nextPass
    ? hashPortalPassword(nextPass)
    : db?.passwordHash || hashPortalPassword(current);

  try {
    await upsertConsoleCredentials({ emailNorm: nextEmail, passwordHash });
  } catch (e: unknown) {
    const code = (e as { code?: string })?.code;
    if (code === "23505") {
      return { ok: false, error: "email_already_registered" };
    }
    throw e;
  }

  return { ok: true, email: nextEmail };
}
