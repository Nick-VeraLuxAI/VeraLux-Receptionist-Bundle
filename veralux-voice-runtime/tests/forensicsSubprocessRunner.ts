/**
 * Invoked by audioForensics.test.ts in a fresh process so zod env sees AUDIO_FORENSICS_ENABLED=true.
 */
import './testEnv';

const baseDir = process.argv[2];
if (!baseDir) {
  console.error('usage: forensicsSubprocessRunner.ts <baseDir>');
  process.exit(2);
}

process.env.AUDIO_FORENSICS_ENABLED = 'true';
process.env.AUDIO_FORENSICS_DIR = baseDir;
process.env.AUDIO_FORENSICS_ALLOW_PII = 'false';

async function main(): Promise<void> {
  const { encodePcm16MonoWav, endForensicsSession, ensureForensicsSession } = await import(
    '../src/observability/audioForensics'
  );
  const session = await ensureForensicsSession('cc-subprocess-1');
  if (!session) {
    console.error('no session');
    process.exit(3);
  }
  await session.appendTimeline({
    event: 'test_ping',
    wallClockMs: Date.now(),
    audioClockMs: 0,
    callControlId: 'cc-subprocess-1',
  });
  const wav = encodePcm16MonoWav(Buffer.alloc(320, 0), 8000);
  await session.writeBinary('audio/005_whisper_request_utt-sub.wav', wav);
  await session.writeJson('transcripts/008_transcript_policy_pol-sub.json', {
    decision: 'accepted',
    api_key: 'secret-should-redact',
    transcript: 'user said hello',
  });
  await endForensicsSession('cc-subprocess-1', 'runner_done');
  console.log(session.sessionDir);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
