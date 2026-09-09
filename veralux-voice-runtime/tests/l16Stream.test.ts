import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTestEnv } from './testEnv';

setTestEnv();

test('isL16Codec accepts Telnyx and PCM aliases', async () => {
  const { isL16Codec } = await import('../src/telnyx/streamCodec');
  assert.equal(isL16Codec('L16'), true);
  assert.equal(isL16Codec('linear16'), true);
  assert.equal(isL16Codec('pcm16le'), true);
  assert.equal(isL16Codec('AMR-WB'), false);
  assert.equal(isL16Codec('PCMU'), false);
});

test('decodeTelnyxPayloadToPcm16 handles L16 little-endian 16 kHz', async () => {
  const { decodeTelnyxPayloadToPcm16 } = await import('../src/audio/codecDecode');
  const payload = Buffer.alloc(8);
  payload.writeInt16LE(1234, 0);
  payload.writeInt16LE(-2000, 2);
  payload.writeInt16LE(0, 4);
  payload.writeInt16LE(32767, 6);

  const decoded = await decodeTelnyxPayloadToPcm16({
    encoding: 'L16',
    payload,
    channels: 1,
    reportedSampleRateHz: 16000,
    targetSampleRateHz: 16000,
    allowAmrWb: false,
    allowG722: false,
    allowOpus: false,
  });

  assert.ok(decoded);
  assert.equal(decoded.sampleRateHz, 16000);
  assert.equal(decoded.pcm16.length, 4);
  assert.equal(decoded.pcm16[0], 1234);
  assert.equal(decoded.pcm16[1], -2000);
  assert.equal(decoded.pcm16[3], 32767);
});

test('decodeTelnyxPayloadToPcm16 does not treat L16 as AMR-WB', async () => {
  const { decodeTelnyxPayloadToPcm16 } = await import('../src/audio/codecDecode');
  const payload = Buffer.alloc(640);
  const decoded = await decodeTelnyxPayloadToPcm16({
    encoding: 'AMR-WB',
    payload,
    channels: 1,
    reportedSampleRateHz: 16000,
    targetSampleRateHz: 16000,
    allowAmrWb: false,
    allowG722: false,
    allowOpus: false,
  });
  assert.equal(decoded, null);
});
