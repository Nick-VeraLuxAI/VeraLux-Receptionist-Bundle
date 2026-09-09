import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "crypto";
import { secretStore } from "../secretStore";
import { upsertFsmConnection } from "../nightDesk/db";

export const JOBBER_TOKEN_SECRET_KEY = "fsm_jobber_oauth_tokens";
export const JOBBER_LEGACY_TOKEN_SECRET_KEY = "fsm_jobber_token";

type JobberTokenSet = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  refreshExpiresAt?: string;
  scope?: string;
};

type OAuthState = {
  tenantId: string;
  nonce: string;
  expiresAt: number;
};

const TOKEN_URL = "https://api.getjobber.com/api/oauth/token";
const AUTHORIZE_URL = "https://api.getjobber.com/api/oauth/authorize";

function appCredentials(): { clientId: string; clientSecret: string } {
  const clientId = String(process.env.JOBBER_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.JOBBER_CLIENT_SECRET || "").trim();
  if (!clientId || !clientSecret) {
    throw new Error("jobber_oauth_not_configured");
  }
  return { clientId, clientSecret };
}

function stateSigningKey(): string {
  const key = String(
    process.env.ADMIN_JWT_SECRET ||
      process.env.JWT_SECRET ||
      process.env.SECRET_ENCRYPTION_KEY ||
      "",
  ).trim();
  if (key.length < 32) throw new Error("jobber_oauth_state_key_missing");
  return key;
}

function encodeState(value: OAuthState): string {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  const signature = createHmac("sha256", stateSigningKey())
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

function decodeState(raw: string): OAuthState {
  const [payload, signature] = String(raw || "").split(".");
  if (!payload || !signature) throw new Error("jobber_oauth_state_invalid");
  const expected = createHmac("sha256", stateSigningKey())
    .update(payload)
    .digest();
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("jobber_oauth_state_invalid");
  }
  const parsed = JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  ) as OAuthState;
  if (
    !parsed.tenantId ||
    !parsed.nonce ||
    !Number.isFinite(parsed.expiresAt) ||
    parsed.expiresAt < Date.now()
  ) {
    throw new Error("jobber_oauth_state_expired");
  }
  return parsed;
}

function pkceKey(nonce: string): string {
  return `fsm_jobber_pkce_${nonce}`;
}

function parseTokenSet(raw: string | undefined): JobberTokenSet | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<JobberTokenSet>;
    if (!value.accessToken) return null;
    return value as JobberTokenSet;
  } catch {
    return null;
  }
}

async function saveTokenSet(
  tenantId: string,
  token: JobberTokenSet,
): Promise<void> {
  await secretStore.setSecret(
    tenantId,
    JOBBER_TOKEN_SECRET_KEY,
    JSON.stringify(token),
  );
  await secretStore.deleteSecret(
    tenantId,
    JOBBER_LEGACY_TOKEN_SECRET_KEY,
  ).catch(() => undefined);
  await upsertFsmConnection(tenantId, "jobber", "connected", undefined, {
    scopes: String(token.scope || "")
      .split(/\s+/)
      .filter(Boolean),
    tokenExpiresAt: token.expiresAt,
    refreshExpiresAt: token.refreshExpiresAt,
  });
}

async function verifyJobberAccount(
  accessToken: string,
): Promise<{ id?: string; name?: string }> {
  const response = await fetch("https://api.getjobber.com/api/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "X-JOBBER-GRAPHQL-VERSION":
        process.env.JOBBER_GRAPHQL_VERSION || "2025-04-16",
    },
    body: JSON.stringify({ query: "{ account { id name } }" }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => ({}))) as {
    data?: { account?: { id?: string; name?: string } };
    errors?: Array<{ message?: string }>;
  };
  if (!response.ok || body.errors?.length) {
    throw new Error(
      body.errors?.[0]?.message || `jobber_verify_http_${response.status}`,
    );
  }
  return body.data?.account || {};
}

async function exchangeToken(
  fields: Record<string, string>,
): Promise<JobberTokenSet> {
  const { clientId, clientSecret } = appCredentials();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    ...fields,
  });
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    refresh_token_expires_in?: number;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !json.access_token) {
    throw new Error(
      json.error_description ||
        json.error ||
        `jobber_oauth_http_${response.status}`,
    );
  }
  const now = Date.now();
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: json.expires_in
      ? new Date(now + json.expires_in * 1000).toISOString()
      : undefined,
    refreshExpiresAt: json.refresh_token_expires_in
      ? new Date(now + json.refresh_token_expires_in * 1000).toISOString()
      : undefined,
    scope: json.scope,
  };
}

export async function beginJobberOAuth(
  tenantId: string,
  redirectUri: string,
): Promise<{ url: string; expiresAt: string }> {
  const { clientId } = appCredentials();
  const nonce = randomBytes(18).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256")
    .update(verifier)
    .digest("base64url");
  const expiresAt = Date.now() + 10 * 60_000;
  const state = encodeState({ tenantId, nonce, expiresAt });
  await secretStore.setSecret(
    tenantId,
    pkceKey(nonce),
    JSON.stringify({ verifier, redirectUri, expiresAt }),
  );
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return { url: url.toString(), expiresAt: new Date(expiresAt).toISOString() };
}

export async function completeJobberOAuth(
  rawState: string,
  code: string,
): Promise<{ tenantId: string }> {
  const state = decodeState(rawState);
  const rawPkce = await secretStore.getSecret(
    state.tenantId,
    pkceKey(state.nonce),
  );
  if (!rawPkce) throw new Error("jobber_oauth_pkce_missing");
  const pkce = JSON.parse(rawPkce) as {
    verifier: string;
    redirectUri: string;
    expiresAt: number;
  };
  if (!pkce.verifier || !pkce.redirectUri || pkce.expiresAt < Date.now()) {
    throw new Error("jobber_oauth_pkce_expired");
  }
  const tokens = await exchangeToken({
    grant_type: "authorization_code",
    code,
    redirect_uri: pkce.redirectUri,
    code_verifier: pkce.verifier,
  });
  const account = await verifyJobberAccount(tokens.accessToken);
  await saveTokenSet(state.tenantId, tokens);
  await upsertFsmConnection(
    state.tenantId,
    "jobber",
    "connected",
    account.name,
    {
      accountId: account.id,
      scopes: String(tokens.scope || "")
        .split(/\s+/)
        .filter(Boolean),
      tokenExpiresAt: tokens.expiresAt,
      refreshExpiresAt: tokens.refreshExpiresAt,
    },
  );
  await secretStore
    .deleteSecret(state.tenantId, pkceKey(state.nonce))
    .catch(() => undefined);
  return { tenantId: state.tenantId };
}

export async function getJobberAccessToken(
  tenantId: string,
): Promise<string | undefined> {
  const raw = await secretStore.getSecret(tenantId, JOBBER_TOKEN_SECRET_KEY);
  const token = parseTokenSet(raw);
  if (!token) {
    return secretStore.getSecret(tenantId, JOBBER_LEGACY_TOKEN_SECRET_KEY);
  }
  const expiresAt = token.expiresAt
    ? new Date(token.expiresAt).getTime()
    : Number.POSITIVE_INFINITY;
  if (expiresAt > Date.now() + 120_000) return token.accessToken;
  if (!token.refreshToken) return token.accessToken;
  try {
    const refreshed = await exchangeToken({
      grant_type: "refresh_token",
      refresh_token: token.refreshToken,
    });
    await saveTokenSet(tenantId, {
      ...refreshed,
      refreshToken: refreshed.refreshToken || token.refreshToken,
      refreshExpiresAt:
        refreshed.refreshExpiresAt || token.refreshExpiresAt,
    });
    return refreshed.accessToken;
  } catch (error) {
    await upsertFsmConnection(
      tenantId,
      "jobber",
      "reauthorization_required",
      error instanceof Error ? error.message : String(error),
    );
    return undefined;
  }
}

export async function disconnectJobber(tenantId: string): Promise<void> {
  await Promise.all([
    secretStore
      .deleteSecret(tenantId, JOBBER_TOKEN_SECRET_KEY)
      .catch(() => undefined),
    secretStore
      .deleteSecret(tenantId, JOBBER_LEGACY_TOKEN_SECRET_KEY)
      .catch(() => undefined),
  ]);
  await upsertFsmConnection(tenantId, "jobber", "disconnected");
}
