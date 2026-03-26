import assert from 'node:assert/strict';
import { test } from 'node:test';
import './testEnv';
import {
  buildTtsCacheDescriptor,
  decodeTtsRedisCachePayload,
  encodeTtsRedisCachePayload,
  ttsCacheKeyHash,
} from '../src/tts/cache';
import type { TTSRequest } from '../src/tts/types';

test('buildTtsCacheDescriptor is stable for key order', () => {
  const req: TTSRequest = { text: '  Hello  ', voice: 'af_bella' };
  const config = {
    mode: 'kokoro_http' as const,
    kokoroUrl: 'http://kokoro/tts',
    voice: 'af_bella',
    format: 'wav' as const,
    sampleRate: 8000,
  };
  const a = ttsCacheKeyHash(buildTtsCacheDescriptor(req, config));
  const b = ttsCacheKeyHash(buildTtsCacheDescriptor(req, config));
  assert.equal(a, b);
  assert.equal(a.length, 64);
});

test('different text yields different cache hash', () => {
  const config = {
    mode: 'kokoro_http' as const,
    kokoroUrl: 'http://kokoro/tts',
    voice: 'af_bella',
    format: 'wav' as const,
    sampleRate: 8000,
  };
  const h1 = ttsCacheKeyHash(buildTtsCacheDescriptor({ text: 'a' }, config));
  const h2 = ttsCacheKeyHash(buildTtsCacheDescriptor({ text: 'b' }, config));
  assert.notEqual(h1, h2);
});

test('Redis cache payload roundtrips content-type and audio', () => {
  const ct = 'audio/wav';
  const audio = Buffer.from([1, 2, 3, 4, 5]);
  const encoded = encodeTtsRedisCachePayload(ct, audio);
  const decoded = decodeTtsRedisCachePayload(encoded);
  assert.ok(decoded);
  assert.equal(decoded!.contentType, ct);
  assert.ok(decoded!.audio.equals(audio));
});
