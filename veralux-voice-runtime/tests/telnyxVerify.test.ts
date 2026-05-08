import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { setTestEnv } from './testEnv';

setTestEnv();

test('parseTelnyxWebhookSigningPublicKey accepts Telnyx-style raw Ed25519 (32-byte base64)', async () => {
  const { parseTelnyxWebhookSigningPublicKey } = await import('../src/telnyx/telnyxVerify');
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const raw32 = spki.subarray(-32);
  const b64 = raw32.toString('base64');
  const parsed = parseTelnyxWebhookSigningPublicKey(b64);
  assert.ok(parsed);
  const reExported = parsed.export({ type: 'spki', format: 'der' }) as Buffer;
  assert.deepEqual(reExported, spki);
});

test('telnyxVerify rejects missing signature', async () => {
  const { verifyTelnyxSignature } = await import('../src/telnyx/telnyxVerify');

  const result = verifyTelnyxSignature({
    rawBody: Buffer.from('{}'),
    signature: '',
    timestamp: Math.floor(Date.now() / 1000).toString(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.skipped, false);
  assert.equal(result.reason, 'missing_signature_or_timestamp');
});

test('telnyxVerify accepts valid hmac signature', async () => {
  const { verifyTelnyxSignature } = await import('../src/telnyx/telnyxVerify');
  const rawBody = Buffer.from(JSON.stringify({ hello: 'world' }));
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const secret = 'test-secret';
  const signature = crypto
    .createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(timestamp), Buffer.from('.'), rawBody]))
    .digest('hex');

  const result = verifyTelnyxSignature({
    rawBody,
    signature,
    timestamp,
    scheme: 'hmac-sha256',
    tenantSecret: secret,
  });

  assert.equal(result.ok, true);
  assert.equal(result.skipped, false);
});

test('telnyxVerify rejects invalid signature', async () => {
  const { verifyTelnyxSignature } = await import('../src/telnyx/telnyxVerify');
  const result = verifyTelnyxSignature({
    rawBody: Buffer.from('{}'),
    signature: 'deadbeef',
    timestamp: Math.floor(Date.now() / 1000).toString(),
    scheme: 'hmac-sha256',
    tenantSecret: 'wrong-secret',
  });

  assert.equal(result.ok, false);
  assert.equal(result.skipped, false);
  assert.equal(result.reason, 'signature_mismatch');
});

test('telnyxVerify rejects stale timestamp drift', async () => {
  const { verifyTelnyxSignature } = await import('../src/telnyx/telnyxVerify');
  const rawBody = Buffer.from('{}');
  const timestamp = (Math.floor(Date.now() / 1000) - 10_000).toString();
  const secret = 'test-secret';
  const signature = crypto
    .createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(timestamp), Buffer.from('.'), rawBody]))
    .digest('hex');

  const result = verifyTelnyxSignature({
    rawBody,
    signature,
    timestamp,
    scheme: 'hmac-sha256',
    tenantSecret: secret,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timestamp_out_of_tolerance');
});