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

function isConfigured(): boolean {
  return !!(env.CONTROL_PLANE_URL && env.CONTROL_PLANE_API_KEY);
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
