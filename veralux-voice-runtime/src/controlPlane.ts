/**
 * Control Plane integration for the voice runtime.
 * Reports call events (start, end with transcript) to the control plane
 * so the workflow automation engine can trigger on call events.
 */

import { env } from './env';
import pino from 'pino';
import { fetchWithTimeoutRetry } from './httpClient';

const log = pino({ name: 'control-plane' });

interface CallTranscriptTurn {
  role: string;
  content: string;
  timestamp?: string;
}

interface ReportCallEndParams {
  tenantId: string;
  callId: string;
  callerId?: string;
  durationMs?: number;
  turns: CallTranscriptTurn[];
  transcript: string;
  lead?: Record<string, any>;
}

export async function lookupCallerCid(
  tenantId: string,
  phone: string,
): Promise<{
  name?: string;
  openJobs?: Array<{ id: string; title?: string }>;
  membership?: string;
  warranty?: string;
} | null> {
  if (!isConfigured() || !phone) return null;
  try {
    const url = `${env.CONTROL_PLANE_URL}/api/runtime/cid-lookup?tenantId=${encodeURIComponent(tenantId)}&phone=${encodeURIComponent(phone)}`;
    const resp = await fetchWithTimeoutRetry(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${env.CONTROL_PLANE_API_KEY}` },
      timeoutMs: 4_000,
      retries: 0,
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as { match?: { name?: string; openJobs?: Array<{ id: string; title?: string }>; membership?: string; warranty?: string } };
    return json.match || null;
  } catch {
    return null;
  }
}

export async function pageOnCall(params: { tenantId: string; callerId?: string; e164?: string; text?: string }): Promise<{
  sent: boolean;
  to?: string;
  timeoutSecs?: number;
}> {
  if (!isConfigured()) return { sent: false };
  try {
    const resp = await fetchWithTimeoutRetry(`${env.CONTROL_PLANE_URL}/api/runtime/oncall-page`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.CONTROL_PLANE_API_KEY!}`,
      },
      body: JSON.stringify(params),
      timeoutMs: 8_000,
      retries: 0,
    });
    if (!resp.ok) return { sent: false };
    return (await resp.json()) as { sent: boolean; to?: string; timeoutSecs?: number };
  } catch {
    return { sent: false };
  }
}

export type NightDeskGateResponse = {
  text: string;
  decision: 'allow' | 'refuse' | 'hold' | 'escalate';
  reason: string;
  completion?: 'booked' | 'approval_held' | 'on_call_paged' | 'tasked' | 'refused';
  persisted: boolean;
  transfer?: { to: string; timeoutSecs: number; pageId?: string };
};

export async function evaluateNightDeskTurn(params: {
  tenantId: string;
  callId: string;
  callerId?: string;
  utterance: string;
  proposedReply: string;
  transcript?: string;
  lead?: Record<string, unknown>;
  afterHours?: boolean;
  existingOpenJobs?: number;
  membership?: string;
}): Promise<NightDeskGateResponse | null> {
  if (!isConfigured()) return null;
  try {
    const response = await fetchWithTimeoutRetry(
      `${env.CONTROL_PLANE_URL}/api/runtime/night-desk/evaluate`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.CONTROL_PLANE_API_KEY!}`,
        },
        body: JSON.stringify(params),
        timeoutMs: 15_000,
        retries: 0,
      },
    );
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      log.error(
        {
          event: 'night_desk_gate_failed',
          status: response.status,
          body: body.slice(0, 300),
          call_id: params.callId,
          tenant_id: params.tenantId,
        },
        'night desk gate failed',
      );
      return null;
    }
    return (await response.json()) as NightDeskGateResponse;
  } catch (error) {
    log.error(
      {
        event: 'night_desk_gate_error',
        err: error,
        call_id: params.callId,
        tenant_id: params.tenantId,
      },
      'night desk gate error',
    );
    return null;
  }
}

export async function reportOncallOutcome(params: {
  tenantId: string;
  callId: string;
  transferCallControlId?: string;
  status: 'initiated' | 'answered' | 'failed';
  reason?: string;
}): Promise<void> {
  if (!isConfigured()) return;
  try {
    const response = await fetchWithTimeoutRetry(
      `${env.CONTROL_PLANE_URL}/api/runtime/oncall-outcome`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.CONTROL_PLANE_API_KEY!}`,
        },
        body: JSON.stringify(params),
        timeoutMs: 8_000,
        retries: 1,
      },
    );
    if (!response.ok) {
      log.warn(
        {
          event: 'oncall_outcome_failed',
          status: response.status,
          call_id: params.callId,
          tenant_id: params.tenantId,
        },
        'on-call outcome report failed',
      );
    }
  } catch (error) {
    log.warn(
      {
        event: 'oncall_outcome_error',
        err: error,
        call_id: params.callId,
        tenant_id: params.tenantId,
      },
      'on-call outcome report error',
    );
  }
}

export async function reportOncallDrillOutcome(params: {
  tenantId: string;
  drillId: string;
  callControlId?: string;
  status: 'answered' | 'failed';
  latencyMs?: number;
  reason?: string;
}): Promise<void> {
  if (!isConfigured()) return;
  try {
    await fetchWithTimeoutRetry(
      `${env.CONTROL_PLANE_URL}/api/runtime/oncall-drill-outcome`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.CONTROL_PLANE_API_KEY!}`,
        },
        body: JSON.stringify(params),
        timeoutMs: 8_000,
        retries: 1,
      },
    );
  } catch (error) {
    log.warn(
      {
        event: 'oncall_drill_outcome_error',
        err: error,
        tenant_id: params.tenantId,
        drill_id: params.drillId,
      },
      'on-call drill outcome report error',
    );
  }
}

export async function reportCallRecording(params: {
  tenantId: string;
  callId: string;
  recordingUrl: string;
}): Promise<void> {
  if (!isConfigured()) return;
  try {
    await fetchWithTimeoutRetry(
      `${env.CONTROL_PLANE_URL}/api/runtime/call-recording`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.CONTROL_PLANE_API_KEY!}`,
        },
        body: JSON.stringify(params),
        timeoutMs: 8_000,
        retries: 1,
      },
    );
  } catch (error) {
    log.warn(
      {
        event: 'call_recording_report_error',
        err: error,
        tenant_id: params.tenantId,
        call_id: params.callId,
      },
      'call recording report error',
    );
  }
}

function isConfigured(): boolean {
  return !!(env.CONTROL_PLANE_URL && env.CONTROL_PLANE_API_KEY);
}

export async function reportCallStart(params: {
  tenantId: string;
  callId: string;
  callerId?: string;
}): Promise<void> {
  if (!isConfigured()) return;
  try {
    const response = await fetchWithTimeoutRetry(
      `${env.CONTROL_PLANE_URL}/api/runtime/calls`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.CONTROL_PLANE_API_KEY!}`,
        },
        body: JSON.stringify({
          tenantId: params.tenantId,
          callId: params.callId,
          action: 'start',
          callState: { callerId: params.callerId },
        }),
        timeoutMs: 8_000,
        retries: 1,
      },
    );
    if (!response.ok) {
      log.warn(
        {
          event: 'control_plane_call_start_failed',
          status: response.status,
          call_id: params.callId,
          tenant_id: params.tenantId,
        },
        'control plane call start failed',
      );
    }
  } catch (error) {
    log.warn(
      {
        event: 'control_plane_call_start_error',
        err: error,
        call_id: params.callId,
        tenant_id: params.tenantId,
      },
      'control plane call start error',
    );
  }
}

/**
 * Report a call end event (with full transcript) to the control plane.
 * This fires asynchronously and never throws — errors are logged only.
 */
export async function notifyDiagnosticsSessionStarted(tenantId: string): Promise<void> {
  if (!isConfigured()) return;
  const url = `${env.CONTROL_PLANE_URL}/api/runtime/tenants/${encodeURIComponent(tenantId)}/diagnostics/consume-next-call-arm`;
  const apiKey = env.CONTROL_PLANE_API_KEY!;
  try {
    const resp = await fetchWithTimeoutRetry(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({}),
      timeoutMs: 10_000,
      retries: 1,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      log.warn(
        {
          event: 'control_plane_diagnostics_consume_failed',
          status: resp.status,
          body: body.slice(0, 200),
          tenant_id: tenantId,
        },
        'control plane diagnostics consume failed',
      );
    }
  } catch (err) {
    log.warn({ err, event: 'control_plane_diagnostics_consume_error', tenant_id: tenantId }, 'diagnostics consume error');
  }
}

export async function reportCallQualitySummary(params: {
  tenantId: string;
  callControlId: string;
  summary: unknown;
}): Promise<void> {
  if (!isConfigured()) return;
  const url = `${env.CONTROL_PLANE_URL}/api/runtime/call-quality-summary`;
  const apiKey = env.CONTROL_PLANE_API_KEY!;
  try {
    const resp = await fetchWithTimeoutRetry(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        tenantId: params.tenantId,
        callControlId: params.callControlId,
        summary: params.summary,
      }),
      timeoutMs: 10_000,
      retries: 1,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      log.warn(
        {
          event: 'control_plane_quality_summary_failed',
          status: resp.status,
          body: body.slice(0, 200),
          call_id: params.callControlId,
        },
        'control plane quality summary write failed',
      );
    }
  } catch (err) {
    log.warn(
      { err, event: 'control_plane_quality_summary_error', call_id: params.callControlId },
      'control plane quality summary error',
    );
  }
}

export async function reportCallEnd(params: ReportCallEndParams): Promise<void> {
  if (!isConfigured()) return;

  const url = `${env.CONTROL_PLANE_URL}/api/runtime/calls`;
  const apiKey = env.CONTROL_PLANE_API_KEY!;

  try {
    const resp = await fetchWithTimeoutRetry(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        tenantId: params.tenantId,
        callId: params.callId,
        action: 'end',
        transcript: params.transcript,
        callState: {
          callerId: params.callerId,
          stage: 'end',
          lead: params.lead,
          history: params.turns,
        },
      }),
      timeoutMs: 10_000,
      retries: 1,
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      log.warn(
        {
          event: 'control_plane_report_failed',
          status: resp.status,
          body: body.slice(0, 200),
          call_id: params.callId,
        },
        'control plane report call end failed',
      );
    } else {
      log.info(
        {
          event: 'control_plane_report_ok',
          call_id: params.callId,
          tenant_id: params.tenantId,
        },
        'call end reported to control plane',
      );
    }
  } catch (err) {
    log.warn(
      { err, event: 'control_plane_report_error', call_id: params.callId },
      'control plane report call end error',
    );
  }
}
