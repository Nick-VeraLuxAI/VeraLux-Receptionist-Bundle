/**
 * Owner authentication: phone-number + passcode login for business owners.
 *
 * Flow:
 *  1. Owner enters phone number → we resolve the tenant
 *  2. Owner enters passcode → we verify against owner_passcodes
 *  3. We issue a short-lived JWT scoped to that tenant
 *  4. The JWT is accepted by the existing adminGuard (OIDC/JWT path)
 *     which resolves tenant_memberships automatically
 */

import { createHash, timingSafeEqual } from "crypto";
import {
  getOwnerPasscodeHash,
  getOwnerPortalCredentialRow,
  getTenantIdByPortalEmail,
  upsertOwnerPasscode,
  upsertOwnerPortalCredentials,
  upsertUserBySub,
  upsertTenantMembership,
} from "./db";
import {
  hashPortalPassword,
  verifyPortalPassword,
  normalizePortalEmail,
  isValidPortalEmailShape,
  PORTAL_PASSWORD_MIN_LEN,
  PORTAL_PASSWORD_MAX_LEN,
} from "./portalPassword";

// ── Passcode hashing ────────────────────────────────

const LEGACY_SHA256_RE = /^[0-9a-f]{64}$/i;
const BCRYPT_PREFIX_RE = /^\$2[aby]\$/;

function legacyHashPasscode(passcode: string): string {
  return createHash("sha256").update(passcode.trim()).digest("hex");
}

function safeLegacyCompare(stored: string, incoming: string): boolean {
  const a = Buffer.from(stored.trim().toLowerCase(), "utf8");
  const b = Buffer.from(legacyHashPasscode(incoming).toLowerCase(), "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function getArgon2(): Promise<any | null> {
  try {
    const importer = new Function("m", "return import(m)") as (m: string) => Promise<any>;
    return await importer("argon2");
  } catch {
    return null;
  }
}

async function hashPasscodeModern(passcode: string): Promise<string> {
  const normalized = passcode.trim();
  const argon2 = await getArgon2();
  if (argon2) {
    const timeCost = Number.parseInt(process.env.OWNER_PASSCODE_ARGON2_TIME_COST || "3", 10);
    const memoryCost = Number.parseInt(process.env.OWNER_PASSCODE_ARGON2_MEMORY_KB || "65536", 10);
    const parallelism = Number.parseInt(process.env.OWNER_PASSCODE_ARGON2_PARALLELISM || "1", 10);
    return argon2.hash(normalized, {
      type: argon2.argon2id,
      timeCost,
      memoryCost,
      parallelism,
    });
  }

  const bcryptjs = await import("bcryptjs");
  const rounds = Number.parseInt(process.env.OWNER_PASSCODE_BCRYPT_ROUNDS || "12", 10);
  const salt = await bcryptjs.genSalt(rounds);
  return bcryptjs.hash(normalized, salt);
}

async function verifyModernPasscode(stored: string, passcode: string): Promise<boolean> {
  if (stored.startsWith("$argon2")) {
    const argon2 = await getArgon2();
    if (!argon2) return false;
    try {
      return await argon2.verify(stored, passcode.trim());
    } catch {
      return false;
    }
  }

  if (BCRYPT_PREFIX_RE.test(stored)) {
    try {
      const bcryptjs = await import("bcryptjs");
      return await bcryptjs.compare(passcode.trim(), stored);
    } catch {
      return false;
    }
  }

  return false;
}

export async function hashPasscode(passcode: string): Promise<string> {
  return hashPasscodeModern(passcode);
}

export async function verifyOwnerPasscode(
  tenantId: string,
  passcode: string
): Promise<boolean> {
  const stored = await getOwnerPasscodeHash(tenantId);
  if (!stored) return false;
  const normalized = stored.trim();

  if (LEGACY_SHA256_RE.test(normalized)) {
    const ok = safeLegacyCompare(normalized, passcode);
    if (ok) {
      const upgraded = await hashPasscodeModern(passcode);
      await upsertOwnerPasscode(tenantId, upgraded);
    }
    return ok;
  }

  return verifyModernPasscode(normalized, passcode);
}

export async function setOwnerPasscode(
  tenantId: string,
  passcode: string
): Promise<void> {
  await upsertOwnerPasscode(tenantId, await hashPasscodeModern(passcode));
}

// ── JWT signing ─────────────────────────────────────

async function getJose() {
  const importer = new Function("m", "return import(m)") as (
    m: string
  ) => Promise<any>;
  return (await importer("jose")) as typeof import("jose");
}

function getSigningSecret(): Uint8Array {
  const secret =
    process.env.ADMIN_JWT_SECRET ||
    process.env.JWT_SECRET ||
    "";
  if (!secret) {
    throw new Error("JWT_SECRET or ADMIN_JWT_SECRET must be set for owner auth");
  }
  return new TextEncoder().encode(secret);
}

export async function issueOwnerJwt(params: {
  tenantId: string;
  tenantName: string;
  /** Real email when using portal email+password login */
  ownerEmail?: string | null;
}): Promise<string> {
  const { SignJWT } = await getJose();
  const sub = `owner:${params.tenantId}`;
  const emailForUser =
    typeof params.ownerEmail === "string" && params.ownerEmail.trim()
      ? params.ownerEmail.trim()
      : `owner@${params.tenantId}`;

  // Ensure user + membership exist so adminGuard's JWT path works
  const user = await upsertUserBySub({
    idpSub: sub,
    email: emailForUser,
  });
  await upsertTenantMembership({
    tenantId: params.tenantId,
    userId: user.id,
    role: "admin",
  });

  const jwt = await new SignJWT({
    sub,
    role: "admin",
    name: params.tenantName,
    email: emailForUser,
    tenant_id: params.tenantId,
    owner_console: true,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("24h")
    .sign(getSigningSecret());

  return jwt;
}

/** Full superadmin console session (Neural Operations /admin) — not tenant-scoped. */
export async function issueInstallerConsoleJwt(params: {
  email: string;
}): Promise<string> {
  const { SignJWT } = await getJose();
  const email = params.email.trim() || "console@veralux.local";

  const jwt = await new SignJWT({
    sub: "installer:console",
    role: "admin",
    name: "Console operator",
    email,
    veralux_console: true,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("24h")
    .sign(getSigningSecret());

  return jwt;
}

const OWNER_PASSCODE_MAX_LEN = 200;

/**
 * Verifies a portal session JWT from issueOwnerJwt. Returns tenant id or null.
 */
export async function verifyOwnerPortalToken(
  rawToken: string
): Promise<{ tenantId: string } | null> {
  const token = rawToken?.trim();
  if (!token || token.split(".").length !== 3) return null;

  let secret: Uint8Array;
  try {
    secret = getSigningSecret();
  } catch {
    return null;
  }

  const { jwtVerify } = await getJose();
  try {
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ["HS256"],
    });
    const sub = typeof payload.sub === "string" ? payload.sub : "";
    const tenantId =
      typeof (payload as { tenant_id?: unknown }).tenant_id === "string"
        ? (payload as { tenant_id: string }).tenant_id
        : "";
    if (!tenantId || sub !== `owner:${tenantId}`) return null;
    return { tenantId };
  } catch {
    return null;
  }
}

export type ChangeOwnerPasscodeError =
  | "invalid_current"
  | "passcode_too_short"
  | "passcode_too_long";

/**
 * Updates owner portal passcode after verifying the current one.
 */
export type ChangeOwnerPortalPasswordError =
  | "invalid_current"
  | "password_too_short"
  | "password_too_long"
  | "no_email_login";

/**
 * Updates portal password (email login) after verifying the current password.
 */
export async function changeOwnerPortalPasswordIfValid(
  tenantId: string,
  currentPassword: string,
  newPassword: string
): Promise<
  { ok: true } | { ok: false; error: ChangeOwnerPortalPasswordError }
> {
  const row = await getOwnerPortalCredentialRow(tenantId);
  if (!row) return { ok: false, error: "no_email_login" };
  const next = (newPassword || "").trim();
  if (next.length < PORTAL_PASSWORD_MIN_LEN) {
    return { ok: false, error: "password_too_short" };
  }
  if (next.length > PORTAL_PASSWORD_MAX_LEN) {
    return { ok: false, error: "password_too_long" };
  }
  if (!verifyPortalPassword((currentPassword || "").trim(), row.passwordHash)) {
    return { ok: false, error: "invalid_current" };
  }
  await upsertOwnerPortalCredentials({
    tenantId,
    emailNorm: row.emailNorm,
    passwordHash: hashPortalPassword(next),
  });
  return { ok: true };
}

export type ChangeOwnerPortalEmailError =
  | "invalid_current"
  | "invalid_email"
  | "no_email_login"
  | "email_already_registered";

export async function changeOwnerPortalEmailIfValid(
  tenantId: string,
  currentPassword: string,
  newEmailRaw: string
): Promise<
  { ok: true; email: string } | { ok: false; error: ChangeOwnerPortalEmailError }
> {
  const row = await getOwnerPortalCredentialRow(tenantId);
  if (!row) return { ok: false, error: "no_email_login" };
  const next = normalizePortalEmail(newEmailRaw);
  if (!next || !isValidPortalEmailShape(next)) {
    return { ok: false, error: "invalid_email" };
  }
  if (!verifyPortalPassword((currentPassword || "").trim(), row.passwordHash)) {
    return { ok: false, error: "invalid_current" };
  }
  if (next === row.emailNorm) return { ok: true, email: next };

  const taken = await getTenantIdByPortalEmail(next);
  if (taken && taken !== tenantId) {
    return { ok: false, error: "email_already_registered" };
  }

  try {
    await upsertOwnerPortalCredentials({
      tenantId,
      emailNorm: next,
      passwordHash: row.passwordHash,
    });
  } catch (e: unknown) {
    const code = (e as { code?: string })?.code;
    if (code === "23505") {
      return { ok: false, error: "email_already_registered" };
    }
    throw e;
  }

  await upsertUserBySub({ idpSub: `owner:${tenantId}`, email: next });
  return { ok: true, email: next };
}

export async function changeOwnerPasscodeIfValid(
  tenantId: string,
  currentPasscode: string,
  newPasscode: string
): Promise<{ ok: true } | { ok: false; error: ChangeOwnerPasscodeError }> {
  const next = (newPasscode || "").trim();
  if (next.length < 4) return { ok: false, error: "passcode_too_short" };
  if (next.length > OWNER_PASSCODE_MAX_LEN) {
    return { ok: false, error: "passcode_too_long" };
  }
  const cur = (currentPasscode || "").trim();
  if (!(await verifyOwnerPasscode(tenantId, cur))) {
    return { ok: false, error: "invalid_current" };
  }
  await setOwnerPasscode(tenantId, next);
  return { ok: true };
}
