/**
 * Keeps Redis runtime DID → tenant map aligned with Postgres `tenant_numbers`.
 * Postgres is the source of truth; Redis is derived for the voice runtime.
 */

import { normalizeE164 } from "./runtime/runtimeContract";
import {
  mapDidToTenant,
  unmapDid,
  listAllMappedDidKeysFromRedis,
} from "./runtime/runtimePublisher";

const DID_KEY_PREFIX = "tenantmap:did:";

function safeNormalizeDid(raw: string): string | null {
  try {
    return normalizeE164(String(raw || "").trim());
  } catch {
    return null;
  }
}

/** After `tenant_numbers` changes for one tenant, update Redis to match. */
export async function syncRedisDidMapAfterTenantNumbersChange(
  tenantId: string,
  previousNumbers: string[],
  nextNumbers: string[]
): Promise<void> {
  if (!process.env.REDIS_URL) return;

  const prev = new Set(
    previousNumbers.map(safeNormalizeDid).filter((x): x is string => Boolean(x))
  );
  const next = new Set(
    nextNumbers.map(safeNormalizeDid).filter((x): x is string => Boolean(x))
  );

  try {
    for (const p of prev) {
      if (!next.has(p)) {
        await unmapDid(p);
      }
    }
    for (const n of next) {
      await mapDidToTenant(n, tenantId);
    }
  } catch (err) {
    console.error(
      "[did-sync] Redis sync failed after tenant_numbers update — Postgres is updated but runtime DID map may be stale until Redis is reachable or you restart the control plane.",
      { tenantId, err }
    );
  }
}

/**
 * On startup: push every DID from Postgres into Redis, then remove Redis DID keys
 * that are not present in Postgres (fixes drift from legacy dual-path config).
 */
export async function reconcileDidMapsWithPostgres(
  rows: { tenant_id: string; number: string }[]
): Promise<void> {
  if (!process.env.REDIS_URL) return;

  const inDb = new Map<string, string>();
  for (const row of rows) {
    const did = safeNormalizeDid(row.number);
    if (did) inDb.set(did, row.tenant_id);
  }

  try {
    for (const [did, tid] of inDb) {
      await mapDidToTenant(did, tid);
    }

    const keys = await listAllMappedDidKeysFromRedis();
    for (const key of keys) {
      if (!key.startsWith(DID_KEY_PREFIX)) continue;
      const did = key.slice(DID_KEY_PREFIX.length);
      if (!inDb.has(did)) {
        await unmapDid(did);
      }
    }

    console.log(
      `[did-sync] Reconciled Redis DID map with Postgres (${inDb.size} DIDs).`
    );
  } catch (err) {
    console.error("[did-sync] reconcileDidMapsWithPostgres failed", err);
  }
}
