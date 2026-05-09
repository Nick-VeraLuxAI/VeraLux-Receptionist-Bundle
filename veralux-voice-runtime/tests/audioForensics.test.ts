import './testEnv';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { encodePcm16MonoWav } from '../src/observability/audioForensics';

const here = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.join(here, '..');

test('encodePcm16MonoWav prepends 44-byte RIFF header', () => {
  const pcm = Buffer.alloc(200, 0);
  const wav = encodePcm16MonoWav(pcm, 16000);
  assert.equal(wav.length, 44 + pcm.length);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
});

test('forensics disabled: ensureForensicsSession returns null (default env)', async () => {
  const { ensureForensicsSession } = await import('../src/observability/audioForensics');
  const s = await ensureForensicsSession('cc-noop');
  assert.equal(s, null);
});

test('forensics enabled in subprocess: session dir, timeline, whisper wav, redacted policy json', () => {
  const tmpBase = fs.mkdtempSync(path.join('/tmp', 'vl-fos-test-'));
  const runner = path.join(runtimeRoot, 'tests', 'forensicsSubprocessRunner.ts');
  const r = spawnSync('npx', ['tsx', runner, tmpBase], {
    cwd: runtimeRoot,
    encoding: 'utf8',
    env: { ...process.env },
  });
  if (r.status !== 0) {
    assert.fail(`subprocess failed: ${r.stderr}\n${r.stdout}`);
  }
  const sessionDir = r.stdout.trim().split('\n').filter(Boolean).pop();
  assert.ok(sessionDir && fs.existsSync(sessionDir), `session dir: ${sessionDir}`);
  const timeline = path.join(sessionDir, 'timeline.jsonl');
  assert.ok(fs.existsSync(timeline));
  const lines = fs.readFileSync(timeline, 'utf8').trim().split('\n');
  assert.ok(lines.some((ln) => ln.includes('test_ping')));
  const whisperWav = path.join(sessionDir, 'audio', '005_whisper_request_utt-sub.wav');
  assert.ok(fs.existsSync(whisperWav));
  const policyPath = path.join(sessionDir, 'transcripts', '008_transcript_policy_pol-sub.json');
  const raw = fs.readFileSync(policyPath, 'utf8');
  assert.match(raw, /\[redacted\]/);
  assert.match(raw, /\[redacted_transcript\]/);
});
