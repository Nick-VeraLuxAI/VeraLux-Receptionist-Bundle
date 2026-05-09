/**
 * Per-call audio + transcript forensics (opt-in via AUDIO_FORENSICS_ENABLED).
 * Default off. Never write secrets; PII redacted unless AUDIO_FORENSICS_ALLOW_PII=true.
 */

import fs from 'fs';
import path from 'path';
import { env } from '../env';
import { log } from '../log';
import { redactValue } from './redaction';

const sessions = new Map<string, AudioForensicsSession>();

export function isAudioForensicsEnabled(): boolean {
  return env.AUDIO_FORENSICS_ENABLED === true;
}

function safeCallId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function wavHeaderPcm16Mono(pcmDataBytes: number, sampleRateHz: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = sampleRateHz * blockAlign;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcmDataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRateHz, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcmDataBytes, 40);
  return header;
}

export function encodePcm16MonoWav(pcm16le: Buffer, sampleRateHz: number): Buffer {
  return Buffer.concat([wavHeaderPcm16Mono(pcm16le.length, sampleRateHz), pcm16le]);
}

export type ForensicsBaseEvent = {
  event: string;
  wallClockMs: number;
  audioClockMs?: number | null;
  callControlId: string;
  turnId?: string | null;
  utteranceId?: string | null;
  state?: string | null;
  playbackActive?: boolean | null;
  listening?: boolean | null;
  reason?: string | null;
  sampleRateHz?: number | null;
  sampleCount?: number | null;
  frameIndex?: number | null;
  chunkIndex?: number | null;
  seq?: number | null;
  timestamp?: number | null;
  streamId?: string | null;
  deltaFromPreviousFrameMs?: number | null;
  wallGapMs?: number | null;
  audioGapMs?: number | null;
  codec?: string | null;
  [key: string]: unknown;
};

export class AudioForensicsSession {
  public readonly callControlId: string;
  public readonly sessionDir: string;
  public readonly startedAtWallMs: number;
  private readonly timelinePath: string;
  private readonly manifestPath: string;
  private closed = false;
  /** Monotonic media-ingest audio clock (ms) for this call. */
  public mediaIngestAudioClockMs = 0;
  public mediaIngestFrameIndex = 0;
  public mediaIngestChunkIndex = 0;
  public mediaIngestLastWallMs = 0;
  /** Session ingress (post-decode to CallSession) */
  public sessionAudioClockMs = 0;
  public sessionFrameIndex = 0;
  public sessionLastWallMs = 0;
  /** ChunkedSTT ingest */
  public sttAudioClockMs = 0;
  public sttFrameIndex = 0;
  public sttLastWallMs = 0;
  public currentUtteranceId: string | null = null;
  /** Frames written as `004_session_stt_input_*.wav` (capped like emit frames). */
  public sessionSttInputFrameIndex = 0;
  private artifactSeq = 0;

  public constructor(callControlId: string, baseDir: string) {
    this.callControlId = callControlId;
    this.startedAtWallMs = Date.now();
    const stamp = new Date(this.startedAtWallMs).toISOString().replace(/[:.]/g, '-');
    this.sessionDir = path.join(baseDir, safeCallId(callControlId), stamp);
    this.timelinePath = path.join(this.sessionDir, 'timeline.jsonl');
    this.manifestPath = path.join(this.sessionDir, 'manifest.jsonl');
  }

  public async init(): Promise<void> {
    await fs.promises.mkdir(path.join(this.sessionDir, 'audio'), { recursive: true });
    await fs.promises.mkdir(path.join(this.sessionDir, 'transcripts'), { recursive: true });
    await fs.promises.mkdir(path.join(this.sessionDir, 'llm'), { recursive: true });
    await fs.promises.mkdir(path.join(this.sessionDir, 'tts'), { recursive: true });
    await fs.promises.mkdir(path.join(this.sessionDir, 'playback'), { recursive: true });
    const manifestLine = `${JSON.stringify({
      event: 'forensics_session_started',
      wallClockMs: this.startedAtWallMs,
      callControlId: this.callControlId,
      sessionDir: this.sessionDir,
      allowPii: env.AUDIO_FORENSICS_ALLOW_PII,
    })}\n`;
    await fs.promises.appendFile(this.manifestPath, manifestLine, 'utf8');
    await this.appendTimeline({
      event: 'forensics_session_started',
      wallClockMs: this.startedAtWallMs,
      audioClockMs: 0,
      callControlId: this.callControlId,
    });
  }

  public nextArtifactSeq(): number {
    this.artifactSeq += 1;
    return this.artifactSeq;
  }

  public async appendTimeline(ev: ForensicsBaseEvent): Promise<void> {
    if (this.closed) return;
    const line = `${JSON.stringify({ ...ev, callControlId: this.callControlId })}\n`;
    try {
      await fs.promises.appendFile(this.timelinePath, line, 'utf8');
    } catch (err) {
      log.warn({ event: 'forensics_timeline_write_failed', err }, 'forensics timeline write failed');
    }
  }

  public appendManifestLine(obj: Record<string, unknown>): void {
    if (this.closed) return;
    const line = `${JSON.stringify(obj)}\n`;
    void fs.promises.appendFile(this.manifestPath, line, 'utf8').catch(() => undefined);
  }

  public async writeBinary(relPath: string, data: Buffer): Promise<void> {
    if (this.closed) return;
    const full = path.join(this.sessionDir, relPath);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.writeFile(full, data);
  }

  public async writeText(relPath: string, text: string): Promise<void> {
    if (this.closed) return;
    const full = path.join(this.sessionDir, relPath);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.writeFile(full, text, 'utf8');
  }

  public async writeJson(relPath: string, data: unknown): Promise<void> {
    const redactTranscripts = !env.AUDIO_FORENSICS_ALLOW_PII;
    const safe = redactValue(data, { redactTranscripts }) as Record<string, unknown>;
    await this.writeText(relPath, JSON.stringify(safe, null, 2));
  }

  /** Append one JSON line to per-turn playback diagnostics. */
  public async appendPlaybackJsonl(turnId: string, record: Record<string, unknown>): Promise<void> {
    if (this.closed) return;
    const rel = `playback/014_playback_events_${turnId}.jsonl`;
    const full = path.join(this.sessionDir, rel);
    const redactTranscripts = !env.AUDIO_FORENSICS_ALLOW_PII;
    const safe = redactValue(record, { redactTranscripts }) as Record<string, unknown>;
    const line = `${JSON.stringify(safe)}\n`;
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.appendFile(full, line, 'utf8');
  }

  public async close(reason: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.appendTimeline({
        event: 'call_ended',
        wallClockMs: Date.now(),
        audioClockMs: this.sttAudioClockMs,
        callControlId: this.callControlId,
        reason,
      });
    } catch {
      // ignore
    }
  }
}

export async function ensureForensicsSession(callControlId: string): Promise<AudioForensicsSession | null> {
  if (!isAudioForensicsEnabled()) return null;
  const existing = sessions.get(callControlId);
  if (existing) return existing;
  try {
    const dir = env.AUDIO_FORENSICS_DIR.trim();
    const session = new AudioForensicsSession(callControlId, dir);
    await session.init();
    sessions.set(callControlId, session);
    log.info(
      { event: 'audio_forensics_session_created', call_control_id: callControlId, session_dir: session.sessionDir },
      'audio forensics session created',
    );
    return session;
  } catch (err) {
    log.warn({ event: 'audio_forensics_session_failed', err, call_control_id: callControlId }, 'audio forensics init failed');
    return null;
  }
}

export function getForensicsSession(callControlId: string): AudioForensicsSession | null {
  return sessions.get(callControlId) ?? null;
}

export async function endForensicsSession(callControlId: string, reason: string): Promise<void> {
  const s = sessions.get(callControlId);
  if (!s) return;
  sessions.delete(callControlId);
  await s.close(reason);
}

export function forensicsTimeline(
  callControlId: string,
  ev: Omit<ForensicsBaseEvent, 'callControlId' | 'wallClockMs'> & { wallClockMs?: number },
): void {
  const s = sessions.get(callControlId);
  if (!s) return;
  void s.appendTimeline({
    ...ev,
    callControlId,
    wallClockMs: ev.wallClockMs ?? Date.now(),
  } as ForensicsBaseEvent);
}
