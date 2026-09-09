import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTestEnv } from './testEnv';

setTestEnv();

test('kokoroStreamUrl maps /tts to /tts/stream', async () => {
  const { kokoroStreamUrl } = await import('../src/tts/kokoroStream');
  assert.equal(kokoroStreamUrl('http://kokoro:7001/tts'), 'http://kokoro:7001/tts/stream');
  assert.equal(kokoroStreamUrl('http://kokoro:7001/tts/stream'), 'http://kokoro:7001/tts/stream');
});

test('parseVlx1WavStream yields wav segments as bytes arrive', async () => {
  const { parseVlx1WavStream } = await import('../src/tts/kokoroStream');
  const wavA = Buffer.from('RIFF____WAVEfmt data-a');
  const wavB = Buffer.from('RIFF____WAVEfmt data-bb');
  const framed = Buffer.concat([
    Buffer.from('VLX1', 'ascii'),
    Buffer.from([0, 0, 0, wavA.length]),
    wavA,
    Buffer.from([0, 0, 0, wavB.length]),
    wavB,
  ]);

  async function* chunks() {
    yield framed.subarray(0, 6);
    yield framed.subarray(6, 20);
    yield framed.subarray(20);
  }

  const out: Buffer[] = [];
  for await (const wav of parseVlx1WavStream(chunks())) {
    out.push(wav);
  }
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], wavA);
  assert.deepEqual(out[1], wavB);
});
