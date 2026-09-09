import fs from 'fs/promises';
import { randomUUID } from 'crypto';

import { env } from '../env';
import { log } from '../log';
import { TelnyxClient } from '../telnyx/telnyxClient';
import { buildMediaStreamUrl } from '../telnyx/mediaStreamUrl';
import { claimStreamingStart, releaseStreamingStart } from '../telnyx/streamStartGuard';
import { sendMediaWsJson, waitForMediaWs } from '../media/mediaWsBridge';
import {
  buildRtpClearEvent,
  buildRtpMarkEvent,
  buildRtpMediaEvent,
  localWavPathFromPublicUrl,
  wavToL16Pcm16k,
} from '../media/bidirectionalRtp';
import type { AudioIngest, AudioPlayback, PlaybackInput, TransferOptions, TransportSession } from './types';

class PstnAudioIngest implements AudioIngest {
  private onFrameCb?: (frame: Buffer) => void;

  start(): void {
    // no-op: Telnyx media WS drives ingest
  }

  stop(): void {
    // no-op
  }

  onFrame(cb: (frame: Buffer) => void): void {
    this.onFrameCb = cb;
  }

  pushFrame(frame: Buffer): void {
    this.onFrameCb?.(frame);
  }
}

class PstnAudioPlayback implements AudioPlayback {
  private readonly telnyx: TelnyxClient;
  private readonly callControlId: string;
  private readonly logContext: Record<string, unknown>;
  private readonly isActive?: () => boolean;
  /** When true, allow playback_start even if call is inactive (e.g. late-final response). */
  private readonly allowPlaybackWhenInactive?: () => boolean;
  private readonly playbackEndCallbacks: Array<() => void> = [];

  constructor(options: {
    telnyx: TelnyxClient;
    callControlId: string;
    logContext: Record<string, unknown>;
    isActive?: () => boolean;
    allowPlaybackWhenInactive?: () => boolean;
  }) {
    this.telnyx = options.telnyx;
    this.callControlId = options.callControlId;
    this.logContext = options.logContext;
    this.isActive = options.isActive;
    this.allowPlaybackWhenInactive = options.allowPlaybackWhenInactive;
  }

  onPlaybackEnd(cb: () => void): void {
    this.playbackEndCallbacks.push(cb);
  }

  notifyPlaybackEnded(): void {
    for (const cb of this.playbackEndCallbacks) {
      try {
        cb();
      } catch (error) {
        log.warn({ err: error, ...this.logContext }, 'playback end callback failed');
      }
    }
  }

  async play(input: PlaybackInput): Promise<void> {
    if (this.shouldSkipTelnyxAction('playback_start')) {
      return;
    }
    if (input.kind !== 'url') {
      log.warn({ event: 'playback_buffer_unsupported', ...this.logContext }, 'pstn playback expects url');
      return;
    }

    const connected = await waitForMediaWs(this.callControlId, 2500);
    if (connected) {
      try {
        const localPath = localWavPathFromPublicUrl(input.url);
        if (!localPath) {
          throw new Error('l16_tts_url_unreadable');
        }
        const wav = await fs.readFile(localPath);
        const pcm = wavToL16Pcm16k(wav);
        const markName = `tts-${randomUUID()}`;
        const sentMedia = sendMediaWsJson(this.callControlId, buildRtpMediaEvent(pcm));
        const sentMark = sentMedia && sendMediaWsJson(this.callControlId, buildRtpMarkEvent(markName));
        if (sentMedia && sentMark) {
          log.info(
            {
              event: 'tts_rtp_l16_sent',
              stream_codec: 'L16',
              sample_rate_hz: 16000,
              pcm_bytes: pcm.length,
              duration_ms: Math.round((pcm.length / 2 / 16000) * 1000),
              mark_name: markName,
              audio_url: input.url,
              ...this.logContext,
            },
            'TTS sent as L16 16 kHz RTP on Telnyx media WebSocket',
          );
          return;
        }
        log.warn(
          {
            event: 'tts_rtp_ws_send_failed_using_playback_start',
            audio_url: input.url,
            ...this.logContext,
          },
          'L16 RTP send failed; using Telnyx playback_start',
        );
      } catch (error) {
        log.warn(
          {
            event: 'tts_rtp_encode_failed_using_playback_start',
            err: error,
            audio_url: input.url,
            ...this.logContext,
          },
          'L16 RTP encode failed; using Telnyx playback_start',
        );
      }
    } else {
      log.warn(
        {
          event: 'tts_rtp_ws_unavailable_using_playback_start',
          audio_url: input.url,
          ...this.logContext,
        },
        'media WebSocket not ready; using Telnyx playback_start',
      );
    }

    await this.telnyx.playAudio(this.callControlId, input.url);
  }

  async stop(): Promise<void> {
    sendMediaWsJson(this.callControlId, buildRtpClearEvent());
    if (this.shouldSkipTelnyxAction('playback_stop')) {
      return;
    }
    await this.telnyx.stopPlayback(this.callControlId);
  }

  private shouldSkipTelnyxAction(action: string): boolean {
    if (!this.isActive || this.isActive()) {
      return false;
    }
    if (action === 'playback_start' && this.allowPlaybackWhenInactive?.()) {
      return false;
    }

    const event = action === 'playback_stop' ? 'playback_stop_skipped' : 'telnyx_action_skipped_inactive';
    log.warn({ event, action, ...this.logContext }, 'skipping telnyx action - call inactive');
    return true;
  }
}

export class PstnTelnyxTransportSession implements TransportSession {
  public readonly id: string;
  public readonly mode = 'pstn' as const;
  public readonly ingest: PstnAudioIngest;
  public readonly playback: PstnAudioPlayback;
  public readonly audioInput = {
    codec: 'pcm16le' as const,
    sampleRateHz: env.TELNYX_TARGET_SAMPLE_RATE, // import env here
  };

  private readonly telnyx: TelnyxClient;
  private readonly logContext: Record<string, unknown>;
  private readonly isActive?: () => boolean;
  private readonly allowPlaybackWhenInactive?: () => boolean;
  private _answered = false;

  constructor(options: {
    callControlId: string;
    tenantId?: string;
    requestId?: string;
    isActive?: () => boolean;
    allowPlaybackWhenInactive?: () => boolean;
    /** When true, start() will not call Telnyx answer (call already live). */
    alreadyAnswered?: boolean;
  }) {
    this.id = options.callControlId;
    this.logContext = {
      call_control_id: options.callControlId,
      tenant_id: options.tenantId,
      requestId: options.requestId,
    };
    this.isActive = options.isActive;
    this.allowPlaybackWhenInactive = options.allowPlaybackWhenInactive;
    this._answered = Boolean(options.alreadyAnswered);
    this.telnyx = new TelnyxClient(this.logContext);
    this.ingest = new PstnAudioIngest();
    this.playback = new PstnAudioPlayback({
      telnyx: this.telnyx,
      callControlId: options.callControlId,
      logContext: this.logContext,
      isActive: this.isActive,
      allowPlaybackWhenInactive: this.allowPlaybackWhenInactive,
    });
  }

  async start(): Promise<void> {
    if (this._answered) {
      return;
    }
    if (this.shouldSkipTelnyxAction('answer')) {
      return;
    }
    await this.telnyx.answerCall(this.id);
    this._answered = true;
    if (claimStreamingStart(this.id)) {
      try {
        await this.telnyx.startStreaming(this.id, buildMediaStreamUrl(this.id));
      } catch (error) {
        releaseStreamingStart(this.id);
        log.warn(
          { err: error, event: 'telnyx_streaming_start_after_answer_failed', ...this.logContext },
          'streaming start after answer failed',
        );
      }
    }
  }

  async stop(reason?: string): Promise<void> {
    if (this.shouldSkipTelnyxAction('hangup')) {
      return;
    }
    try {
      log.info(
        {
          event: 'telnyx_hangup_requested',
          reason: reason ?? 'unspecified',
          ...this.logContext,
        },
        'telnyx hangup requested (transport.stop)',
      );
      await this.telnyx.hangupCall(this.id);
    } catch (error) {
      log.error({ err: error, reason, ...this.logContext }, 'telnyx hangup failed');
    }
  }

  async transfer(to: string, options?: TransferOptions): Promise<void> {
    if (this.shouldSkipTelnyxAction('transfer')) {
      return;
    }
    await this.telnyx.transferCall(this.id, to, {
      from: options?.from,
      timeoutSecs: options?.timeoutSecs,
      audioUrl: options?.audioUrl,
      targetLegClientState: options?.targetLegClientState,
      commandId: options?.commandId,
    });
  }

  pushFrame(frame: Buffer): void {
    this.ingest.pushFrame(frame);
  }

  notifyPlaybackEnded(): void {
    this.playback.notifyPlaybackEnded();
  }

  private shouldSkipTelnyxAction(action: string): boolean {
    if (!this.isActive || this.isActive()) {
      return false;
    }

    const event = action === 'playback_stop' ? 'playback_stop_skipped' : 'telnyx_action_skipped_inactive';
    log.warn({ event, action, ...this.logContext }, 'skipping telnyx action - call inactive');
    return true;
  }
}
