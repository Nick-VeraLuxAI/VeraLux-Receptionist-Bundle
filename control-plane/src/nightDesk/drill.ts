import { secretStore } from "../secretStore";
import {
  completeOncallDrill,
  insertOncallDrill,
  setOncallDrillCallId,
} from "./db";
import {
  TENANT_TELNYX_API_KEY,
  TENANT_TELNYX_CONNECTION_ID,
  TENANT_TELNYX_PHONE_NUMBER,
} from "./sms";

export async function startVoiceOncallDrill(input: {
  tenantId: string;
  e164: string;
  timeoutSecs?: number;
}) {
  const drill = await insertOncallDrill(
    input.tenantId,
    input.e164,
    0,
    false,
    "pending",
  );
  const [tenantKey, tenantConnection, tenantFrom] = await Promise.all([
    secretStore.getSecret(input.tenantId, TENANT_TELNYX_API_KEY),
    secretStore.getSecret(input.tenantId, TENANT_TELNYX_CONNECTION_ID),
    secretStore.getSecret(input.tenantId, TENANT_TELNYX_PHONE_NUMBER),
  ]);
  const apiKey = tenantKey || process.env.TELNYX_API_KEY;
  let connectionId =
    tenantConnection || process.env.TELNYX_CONNECTION_ID;
  const from = tenantFrom || process.env.TELNYX_PHONE_NUMBER;
  if (apiKey && from && !connectionId) {
    try {
      const response = await fetch(
        `https://api.telnyx.com/v2/phone_numbers?filter[phone_number]=${encodeURIComponent(
          from,
        )}&page[size]=1`,
        {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(10_000),
        },
      );
      const body = (await response.json().catch(() => ({}))) as {
        data?: Array<{ connection_id?: string | null }>;
      };
      connectionId = body.data?.[0]?.connection_id || undefined;
    } catch {
      connectionId = undefined;
    }
  }
  if (!apiKey || !connectionId || !from) {
    await completeOncallDrill({
      tenantId: input.tenantId,
      id: drill.id,
      ok: false,
      reason: "telnyx_voice_not_configured",
    });
    return {
      drill: { ...drill, status: "failed" },
      dialed: false,
      error: "telnyx_voice_not_configured",
    };
  }
  const startedAt = Date.now();
  const clientState = Buffer.from(
    JSON.stringify({
      kind: "veralux_oncall_drill",
      tenantId: input.tenantId,
      tenant_id: input.tenantId,
      drillId: drill.id,
      startedAt,
    }),
  ).toString("base64");
  const body: Record<string, unknown> = {
    connection_id: connectionId,
    to: input.e164,
    from,
    timeout_secs: Math.min(
      120,
      Math.max(5, Math.round(input.timeoutSecs || 30)),
    ),
    time_limit_secs: 30,
    client_state: clientState,
  };
  if (process.env.ONCALL_DRILL_AUDIO_URL) {
    body.audio_url = process.env.ONCALL_DRILL_AUDIO_URL;
  }
  try {
    const response = await fetch("https://api.telnyx.com/v2/calls", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await response.json().catch(() => ({}))) as {
      data?: { call_control_id?: string };
      errors?: Array<{ detail?: string }>;
    };
    const callControlId = json.data?.call_control_id;
    if (!response.ok || !callControlId) {
      const error =
        json.errors?.[0]?.detail || `telnyx_dial_http_${response.status}`;
      await completeOncallDrill({
        tenantId: input.tenantId,
        id: drill.id,
        ok: false,
        reason: error,
      });
      return { drill, dialed: false, error };
    }
    await setOncallDrillCallId(
      input.tenantId,
      drill.id,
      callControlId,
    );
    return {
      drill: { ...drill, call_control_id: callControlId },
      dialed: true,
      callControlId,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await completeOncallDrill({
      tenantId: input.tenantId,
      id: drill.id,
      ok: false,
      reason,
    });
    return { drill, dialed: false, error: reason };
  }
}
