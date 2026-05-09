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

test('telnyxWebhookSignedMessage uses pipe for Ed25519 and dot for HMAC', async () => {
  const { telnyxWebhookSignedMessage } = await import('../src/telnyx/telnyxVerify');
  const raw = Buffer.from('{"x":1}');
  const ts = '1700000000';
  assert.deepEqual(
    telnyxWebhookSignedMessage(ts, raw, 'ed25519', undefined),
    Buffer.concat([Buffer.from(ts), Buffer.from('|'), raw]),
  );
  assert.deepEqual(
    telnyxWebhookSignedMessage(ts, raw, 'hmac-sha256', 's'),
    Buffer.concat([Buffer.from(ts), Buffer.from('.'), raw]),
  );
  assert.deepEqual(
    telnyxWebhookSignedMessage(ts, raw, undefined, 'tenant-secret'),
    Buffer.concat([Buffer.from(ts), Buffer.from('.'), raw]),
  );
});

test('Ed25519 signature verifies over timestamp|body not timestamp.body', async () => {
  const { telnyxWebhookSignedMessage, parseTelnyxWebhookSigningPublicKey } = await import(
    '../src/telnyx/telnyxVerify'
  );
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const raw32 = spki.subarray(-32);
  const pub = parseTelnyxWebhookSigningPublicKey(raw32.toString('base64'));
  const rawBody = Buffer.from('{}');
  const ts = String(Math.floor(Date.now() / 1000));
  const pipeMsg = telnyxWebhookSignedMessage(ts, rawBody, 'ed25519', undefined);
  const dotMsg = Buffer.concat([Buffer.from(ts, 'utf8'), Buffer.from('.', 'utf8'), rawBody]);
  const sig = crypto.sign(null, pipeMsg, privateKey);
  assert.equal(crypto.verify(null, pipeMsg, pub, sig), true);
  assert.equal(crypto.verify(null, dotMsg, pub, sig), false);
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