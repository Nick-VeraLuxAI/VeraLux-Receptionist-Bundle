import crypto from 'crypto';

type ScenarioResult = {
  name: string;
  pass: boolean;
  status: number;
  body: unknown;
};

const runtimeBase = process.env.RUNTIME_BASE_URL ?? 'http://localhost:4001';
const webhookUrl = `${runtimeBase}/v1/telnyx/webhook`;
const webhookSecret = process.env.TELNYX_WEBHOOK_SECRET ?? 'test-secret';

function buildPayload(eventType: string, callControlId: string, eventId?: string): Record<string, unknown> {
  return {
    data: {
      event_type: eventType,
      id: eventId ?? `evt_${Math.random().toString(36).slice(2, 12)}`,
      occurred_at: new Date().toISOString(),
      payload: {
        call_control_id: callControlId,
        call_leg_id: `leg_${Math.random().toString(36).slice(2, 12)}`,
        call_session_id: `sess_${Math.random().toString(36).slice(2, 12)}`,
        from: '+15551234567',
        to: '+15557654321',
      },
    },
  };
}

function signPayload(timestamp: string, body: string): string {
  return crypto.createHmac('sha256', webhookSecret).update(`${timestamp}.${body}`).digest('hex');
}

async function postWebhook(payload: Record<string, unknown>, opts?: { signature?: string; timestamp?: string }) {
  const body = JSON.stringify(payload);
  const timestamp = opts?.timestamp ?? Math.floor(Date.now() / 1000).toString();
  const signature = opts?.signature ?? signPayload(timestamp, body);
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'telnyx-timestamp': timestamp,
      'telnyx-signature': signature,
    },
    body,
  });
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    parsed = await response.text();
  }
  return { status: response.status, body: parsed };
}

async function run(): Promise<void> {
  const callId = `pilot_${Date.now()}`;
  const duplicateEventId = `evt_dup_${Math.random().toString(36).slice(2, 12)}`;
  const results: ScenarioResult[] = [];

  const normal = await postWebhook(buildPayload('call.initiated', callId));
  results.push({ name: 'normal_initiated', pass: normal.status === 200, ...normal });

  const duplicateA = await postWebhook(buildPayload('call.initiated', callId, duplicateEventId));
  const duplicateB = await postWebhook(buildPayload('call.initiated', callId, duplicateEventId));
  results.push({
    name: 'duplicate_webhook_replay',
    pass: duplicateA.status === 200 && duplicateB.status === 200,
    status: duplicateB.status,
    body: duplicateB.body,
  });

  const staleTs = (Math.floor(Date.now() / 1000) - 10_000).toString();
  const stalePayload = buildPayload('call.answered', callId);
  const staleBody = JSON.stringify(stalePayload);
  const staleSig = signPayload(staleTs, staleBody);
  const stale = await postWebhook(stalePayload, { timestamp: staleTs, signature: staleSig });
  results.push({ name: 'stale_signature_rejected', pass: stale.status === 401, ...stale });

  const invalidSig = await postWebhook(buildPayload('call.hangup', callId), { signature: 'deadbeef' });
  results.push({ name: 'invalid_signature_rejected', pass: invalidSig.status === 401, ...invalidSig });

  const summary = {
    generated_at: new Date().toISOString(),
    runtime_base_url: runtimeBase,
    total: results.length,
    passed: results.filter((r) => r.pass).length,
    failed: results.filter((r) => !r.pass).length,
    results,
    launch_recommendation:
      results.every((r) => r.pass) ? 'pilot_pass' : 'pilot_blocked',
  };

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(summary, null, 2));
}

void run().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exitCode = 1;
});
