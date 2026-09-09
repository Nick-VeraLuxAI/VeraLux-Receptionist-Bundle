import { env } from '../env';
import { log } from '../log';
import { diagnosticsEnabled } from '../diagnostics/audioProbe';
import { TelnyxRequestOptions } from './types';
import { incProviderCircuitOpen, incProviderTimeout } from '../metrics';
import { withCircuitBreaker } from '../providers/circuitBreaker';
import { telnyxApiKeyForCall } from './tenantCredentials';
import { buildTelnyxStreamingStartBody, TELNYX_WS_STREAM_CODEC } from './streamCodec';

export interface TelnyxPreparedRequest {
  url: string;
  options: TelnyxRequestOptions & { headers: Record<string, string>; method: string };
}

const TELNYX_BASE_URL = 'https://api.telnyx.com/v2';
const TELNYX_TIMEOUT_MS = 8000;
const TELNYX_MAX_RETRIES = 2;

// Retry backoff tuning (keep small; call-control is latency-sensitive)
const TELNYX_RETRY_BASE_MS = 250;
const TELNYX_RETRY_MAX_MS = 1500;

function maskTelnyxKey(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 8) {
    return `${trimmed.slice(0, 2)}...${trimmed.slice(-2)}`;
  }
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

function shouldRetry(status: number): boolean {
  return status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number): number {
  // attempt: 0,1,2...
  const exp = Math.min(TELNYX_RETRY_MAX_MS, TELNYX_RETRY_BASE_MS * Math.pow(2, attempt));
  const jitter = Math.floor(Math.random() * 120); // small jitter
  return exp + jitter;
}

function truncateForLog(value: unknown, max = 800): string {
  try {
    const s = typeof value === 'string' ? value : JSON.stringify(value);
    if (s.length <= max) return s;
    return `${s.slice(0, max)}…(truncated)`;
  } catch {
    return '[unserializable]';
  }
}

function isCallEndedResponse(status: number, body: unknown): boolean {
  if (status !== 422) {
    return false;
  }
  try {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return /already ended|no longer active/i.test(text);
  } catch {
    return false;
  }
}

function attachCallControlErrorDetails(
  error: Error,
  status: number,
  body: unknown,
): Error & { status?: number; responseBody?: unknown } {
  (error as Error & { status?: number }).status = status;
  (error as Error & { responseBody?: unknown }).responseBody = body;
  return error as Error & { status?: number; responseBody?: unknown };
}

async function safeReadBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      return await response.json();
    } catch {
      // fall through to text
    }
  }
  try {
    return await response.text();
  } catch (e) {
    return `<<failed to read response body: ${String(e)}>>`;
  }
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || /aborted|AbortError/i.test(err.message))
  );
}

async function callControlRequest(
  callControlId: string,
  action: string,
  body: Record<string, unknown> | undefined,
  attempt: number,
  logContext: Record<string, unknown>,
  apiKey: string,
): Promise<unknown> {
  const url = `${TELNYX_BASE_URL}/calls/${callControlId}/actions/${action}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TELNYX_TIMEOUT_MS);
  const startedAt = Date.now();

  const keyFingerprint = maskTelnyxKey(apiKey);

  log.info(
    {
      event: 'telnyx_call_control_request',
      action,
      call_control_id: callControlId,
      telnyx_api_key_fingerprint: keyFingerprint,
      attempt,
      ...logContext,
    },
    'telnyx call-control request',
  );

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
      'User-Agent': 'veralux-voice-runtime/0.1.0',
    };

    let payload: string | undefined;
    if (body && Object.keys(body).length > 0) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    const response = await withCircuitBreaker({
      key: 'telnyx_call_control',
      failureThreshold: 4,
      openMs: 15_000,
      onOpen: () => incProviderCircuitOpen('telnyx_call_control'),
      action: () =>
        fetch(url, {
          method: 'POST',
          headers,
          body: payload,
          signal: controller.signal,
        }),
    });

    const responseBody = await safeReadBody(response);
    const durationMs = Date.now() - startedAt;

    if (!response.ok) {
      const logBody = truncateForLog(responseBody, 1000);

      if (isCallEndedResponse(response.status, responseBody)) {
        log.warn(
          {
            event: 'telnyx_call_control_ignored_post_end',
            action,
            call_control_id: callControlId,
            status: response.status,
            duration_ms: durationMs,
            body: logBody,
            ...logContext,
          },
          'telnyx call-control ignored post end',
        );
        return responseBody;
      }

      if (shouldRetry(response.status) && attempt < TELNYX_MAX_RETRIES) {
        const waitMs = backoffMs(attempt);
        log.warn(
          {
            event: 'telnyx_call_control_retry',
            action,
            call_control_id: callControlId,
            status: response.status,
            duration_ms: durationMs,
            wait_ms: waitMs,
            attempt,
            body: logBody,
            ...logContext,
          },
          'telnyx call-control retry',
        );
        await sleep(waitMs);
        return callControlRequest(
          callControlId,
          action,
          body,
          attempt + 1,
          logContext,
          apiKey,
        );
      }

      log.error(
        {
          event: 'telnyx_call_control_failed',
          action,
          call_control_id: callControlId,
          status: response.status,
          duration_ms: durationMs,
          body: logBody,
          ...logContext,
        },
        'telnyx call-control failed',
      );

      throw attachCallControlErrorDetails(
        new Error(
          `Telnyx call-control ${action} failed: ${response.status} ${truncateForLog(responseBody, 1200)}`,
        ),
        response.status,
        responseBody,
      );
    }

    log.info(
      {
        event: 'telnyx_call_control_completed',
        action,
        call_control_id: callControlId,
        status: response.status,
        duration_ms: durationMs,
        ...logContext,
      },
      'telnyx call-control completed',
    );

    return responseBody;
  } catch (error) {
    if (isAbortError(error)) {
      incProviderTimeout('telnyx_call_control');
    }
    const errorStatus = (error as { status?: number }).status;
    const errorBody = (error as { responseBody?: unknown }).responseBody;
    if (errorStatus === 422 && isCallEndedResponse(errorStatus, errorBody ?? error)) {
      log.warn(
        {
          event: 'telnyx_call_control_ignored_post_end',
          action,
          call_control_id: callControlId,
          status: errorStatus,
          err: error,
          ...logContext,
        },
        'telnyx call-control ignored post end',
      );
      return errorBody;
    }

    // Abort should NOT be retried aggressively (usually means Telnyx API is slow or our timeout too low)
    if (!isAbortError(error) && attempt < TELNYX_MAX_RETRIES) {
      const waitMs = backoffMs(attempt);
      log.warn(
        {
          event: 'telnyx_call_control_error_retry',
          action,
          call_control_id: callControlId,
          attempt,
          wait_ms: waitMs,
          err: error,
          ...logContext,
        },
        'telnyx call-control error retry',
      );
      await sleep(waitMs);
      return callControlRequest(
        callControlId,
        action,
        body,
        attempt + 1,
        logContext,
        apiKey,
      );
    }

    log.error(
      {
        event: 'telnyx_call_control_error',
        action,
        call_control_id: callControlId,
        err: error,
        ...logContext,
      },
      'telnyx call-control error',
    );
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function telnyxCallControl(
  callControlId: string,
  action: string,
  body?: Record<string, unknown>,
  logContext: Record<string, unknown> = {},
  apiKey = env.TELNYX_API_KEY,
): Promise<unknown> {
  let normalizedBody = body;
  if (action === 'answer' && body) {
    const hasStreamUrl = Object.prototype.hasOwnProperty.call(body, 'stream_url');
    const hasStreamTrack = Object.prototype.hasOwnProperty.call(body, 'stream_track');
    if (hasStreamUrl || hasStreamTrack) {
      const { media_format: _mediaFormat, ...rest } = body;
      normalizedBody = {
        ...rest,
        ...buildTelnyxStreamingStartBody({
          streamUrl: typeof rest.stream_url === 'string' ? rest.stream_url : '',
          streamTrack:
            typeof rest.stream_track === 'string' ? rest.stream_track : env.TELNYX_STREAM_TRACK,
        }),
      };
    }
  }
  return callControlRequest(
    callControlId,
    action,
    normalizedBody,
    0,
    logContext,
    apiKey,
  );
}

export class TelnyxClient {
  private readonly apiKey: string;
  private readonly baseUrl = TELNYX_BASE_URL;
  private readonly timeoutMs = TELNYX_TIMEOUT_MS;
  private readonly maxRetries = TELNYX_MAX_RETRIES;
  private readonly logContext: Record<string, unknown>;

  constructor(context: Record<string, unknown> = {}) {
    this.logContext = context;
    this.apiKey = telnyxApiKeyForCall(context.call_control_id);
  }

  public buildRequest(path: string, options: TelnyxRequestOptions = {}): TelnyxPreparedRequest {
    const url = new URL(path, this.baseUrl).toString();

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
      'User-Agent': 'veralux-voice-runtime/0.1.0',
      ...options.headers,
    };

    // Only set JSON content-type if the caller provided a body (and didn’t override)
    if (options.body && !('Content-Type' in headers) && !('content-type' in headers)) {
      headers['Content-Type'] = 'application/json';
    }

    return {
      url,
      options: {
        ...options,
        method: options.method ?? 'GET',
        headers,
      },
    };
  }

  public async request<T>(path: string, options: TelnyxRequestOptions = {}): Promise<T> {
    return this.requestWithRetry<T>(path, options, 0);
  }

  public async answerCall(callControlId: string): Promise<void> {
    await telnyxCallControl(
      callControlId,
      'answer',
      undefined,
      this.logContext,
      this.apiKey,
    );
    log.info(
      { event: 'telnyx_answer_call', call_control_id: callControlId, ...this.logContext },
      'telnyx call answered',
    );
  }

  public async playAudio(callControlId: string, audioUrl: string): Promise<void> {
    await telnyxCallControl(
      callControlId,
      'playback_start',
      { audio_url: audioUrl },
      this.logContext,
      this.apiKey,
    );
    log.info(
      {
        event: 'telnyx_play_audio',
        call_control_id: callControlId,
        audio_url: audioUrl,
        ...this.logContext,
      },
      'telnyx playback started',
    );
  }

  public async stopPlayback(callControlId: string): Promise<void> {
    await telnyxCallControl(
      callControlId,
      'playback_stop',
      undefined,
      this.logContext,
      this.apiKey,
    );
    log.info(
      {
        event: 'telnyx_playback_stop',
        call_control_id: callControlId,
        ...this.logContext,
      },
      'telnyx playback stop requested',
    );
  }

  public async startStreaming(
    callControlId: string,
    streamUrl: string,
    options: { streamCodec?: string; streamTrack?: string } = {},
  ): Promise<void> {
    const normalizeStreamTrack = (track: string): 'inbound_track' | 'outbound_track' | 'both_tracks' => {
      switch (track) {
        case 'inbound':
          return 'inbound_track';
        case 'outbound':
          return 'outbound_track';
        case 'both':
          return 'both_tracks';
        default:
          return track as 'inbound_track' | 'outbound_track' | 'both_tracks';
      }
    };

    const streamTrack = normalizeStreamTrack(options.streamTrack ?? env.TELNYX_STREAM_TRACK);
    const requestedCodec = options.streamCodec ?? env.TELNYX_STREAM_CODEC ?? TELNYX_WS_STREAM_CODEC;
    if (requestedCodec !== TELNYX_WS_STREAM_CODEC) {
      log.warn(
        {
          event: 'telnyx_stream_codec_coerced_to_l16',
          call_control_id: callControlId,
          requested_codec: requestedCodec,
          selected_codec: TELNYX_WS_STREAM_CODEC,
        },
        'WebSocket stream codec coerced to L16 (AMR-WB fallback disabled)',
      );
    }
    const requestBody = buildTelnyxStreamingStartBody({ streamUrl, streamTrack });
    log.info(
      {
        event: 'telnyx_stream_start',
        call_control_id: callControlId,
        stream_codec: requestBody.stream_codec,
        stream_bidirectional_mode: requestBody.stream_bidirectional_mode,
        stream_bidirectional_codec: requestBody.stream_bidirectional_codec,
        stream_bidirectional_sampling_rate: requestBody.stream_bidirectional_sampling_rate,
        stream_track: requestBody.stream_track,
        sip_accept_codecs: env.TELNYX_ACCEPT_CODECS,
      },
      'Telnyx stream start (requested codec)',
    );
    if (diagnosticsEnabled()) {
      log.info(
        {
          event: 'audio_codec_info',
          direction: 'tx.telnyx_stream_request',
          call_control_id: callControlId,
          stream_codec: requestBody.stream_codec,
          stream_bidirectional_mode: requestBody.stream_bidirectional_mode,
          stream_bidirectional_codec: requestBody.stream_bidirectional_codec,
          stream_bidirectional_sampling_rate: requestBody.stream_bidirectional_sampling_rate,
          stream_track: requestBody.stream_track,
        },
        'audio codec info',
      );
    }
    const redactedStreamUrl = (() => {
      try {
        const parsed = new URL(streamUrl);
        if (parsed.searchParams.has('token')) {
          parsed.searchParams.set('token', '[redacted]');
        }
        return parsed.toString();
      } catch {
        return streamUrl.replace(/token=[^&]+/g, 'token=[redacted]');
      }
    })();
    log.info(
      {
        event: 'telnyx_streaming_start_request',
        call_control_id: callControlId,
        request_body: {
          ...requestBody,
          stream_url: redactedStreamUrl,
        },
        ...this.logContext,
      },
      'telnyx streaming start request',
    );

    await telnyxCallControl(
      callControlId,
      'streaming_start',
      requestBody,
      this.logContext,
      this.apiKey,
    );

    log.info(
      {
        event: 'telnyx_streaming_start',
        call_control_id: callControlId,
        stream_url: redactedStreamUrl,
        ...this.logContext,
      },
      'telnyx streaming start requested',
    );
  }

  public async hangupCall(callControlId: string): Promise<void> {
    await telnyxCallControl(
      callControlId,
      'hangup',
      undefined,
      this.logContext,
      this.apiKey,
    );
    log.info(
      { event: 'telnyx_hangup_call', call_control_id: callControlId, ...this.logContext },
      'telnyx call hangup',
    );
  }

  public async startRecording(
    callControlId: string,
    clientState?: string,
  ): Promise<void> {
    await telnyxCallControl(
      callControlId,
      'record_start',
      {
        channels: 'single',
        format: 'mp3',
        ...(clientState ? { client_state: clientState } : {}),
      },
      this.logContext,
      this.apiKey,
    );
    log.info(
      {
        event: 'telnyx_recording_started',
        call_control_id: callControlId,
        ...this.logContext,
      },
      'Telnyx call recording started',
    );
  }

  public async speakText(
    callControlId: string,
    text: string,
  ): Promise<void> {
    await telnyxCallControl(
      callControlId,
      'speak',
      {
        payload: text.slice(0, 3000),
        payload_type: 'text',
        voice: 'Telnyx.KokoroTTS.af',
        language: 'en-US',
      },
      this.logContext,
      this.apiKey,
    );
  }

  /**
   * Transfer an active call to another destination (E.164 number or SIP URI).
   * Call must be answered first. On success Telnyx bridges the call and sends call.bridged;
   * on failure you get call.hangup on the B leg; original leg stays active.
   */
  public async transferCall(
    callControlId: string,
    to: string,
    options: {
      from?: string;
      timeoutSecs?: number;
      audioUrl?: string;
      targetLegClientState?: string;
      commandId?: string;
    } = {},
  ): Promise<void> {
    const body: Record<string, unknown> = { to };
    if (options.from != null) body.from = options.from;
    if (options.timeoutSecs != null) body.timeout_secs = options.timeoutSecs;
    if (options.audioUrl != null) body.audio_url = options.audioUrl;
    if (options.targetLegClientState != null) {
      body.target_leg_client_state = options.targetLegClientState;
    }
    if (options.commandId != null) body.command_id = options.commandId;

    await telnyxCallControl(
      callControlId,
      'transfer',
      body,
      this.logContext,
      this.apiKey,
    );
    log.info(
      {
        event: 'telnyx_transfer_call',
        call_control_id: callControlId,
        to,
        ...this.logContext,
      },
      'telnyx call transfer',
    );
  }

  private async requestWithRetry<T>(
    path: string,
    options: TelnyxRequestOptions,
    attempt: number,
  ): Promise<T> {
    const prepared = this.buildRequest(path, options);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const startedAt = Date.now();

    try {
      const response = await fetch(prepared.url, {
        method: prepared.options.method,
        headers: prepared.options.headers,
        body: prepared.options.body,
        signal: controller.signal,
      });

      const body = await safeReadBody(response);
      const durationMs = Date.now() - startedAt;

      if (!response.ok) {
        const logBody = truncateForLog(body, 1000);

        if (shouldRetry(response.status) && attempt < this.maxRetries) {
          const waitMs = backoffMs(attempt);
          log.warn(
            {
              event: 'telnyx_request_retry',
              url: prepared.url,
              status: response.status,
              attempt,
              wait_ms: waitMs,
              duration_ms: durationMs,
              body: logBody,
              ...this.logContext,
            },
            'telnyx request retry',
          );
          await sleep(waitMs);
          return this.requestWithRetry<T>(path, options, attempt + 1);
        }

        log.error(
          {
            event: 'telnyx_request_failed',
            url: prepared.url,
            status: response.status,
            duration_ms: durationMs,
            body: logBody,
            ...this.logContext,
          },
          'telnyx request failed',
        );
        throw new Error(`Telnyx request failed: ${response.status} ${logBody}`);
      }

      log.info(
        {
          event: 'telnyx_request_completed',
          url: prepared.url,
          status: response.status,
          duration_ms: durationMs,
          ...this.logContext,
        },
        'telnyx request completed',
      );

      return body as T;
    } catch (error) {
      if (!isAbortError(error) && attempt < this.maxRetries) {
        const waitMs = backoffMs(attempt);
        log.warn(
          {
            event: 'telnyx_request_error_retry',
            url: prepared.url,
            attempt,
            wait_ms: waitMs,
            err: error,
            ...this.logContext,
          },
          'telnyx request error retry',
        );
        await sleep(waitMs);
        return this.requestWithRetry<T>(path, options, attempt + 1);
      }

      log.error(
        { event: 'telnyx_request_error', url: prepared.url, err: error, ...this.logContext },
        'telnyx request error',
      );
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
