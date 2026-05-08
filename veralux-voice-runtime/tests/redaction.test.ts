import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactValue } from '../src/observability/redaction';

test('redacts tokens, phone numbers, and email values', () => {
  const payload = {
    authorization: 'Bearer abc.def.ghi',
    stream_url: 'wss://example.com/media?token=secret-token-123',
    from: '+1 (555) 123-4567',
    email: 'customer@example.com',
    transcript: 'My number is 5551234567',
  };

  const redacted = redactValue(payload) as Record<string, unknown>;
  assert.equal(redacted.authorization, '[redacted]');
  assert.equal(redacted.email, '[redacted]');
  assert.equal(redacted.transcript, '[redacted_transcript]');
  assert.match(String(redacted.stream_url), /\[redacted\]/);
});

test('can preserve transcript content when configured', () => {
  const payload = { transcript: 'Please schedule me at 2pm' };
  const redacted = redactValue(payload, { redactTranscripts: false }) as Record<string, unknown>;
  assert.equal(redacted.transcript, 'Please schedule me at 2pm');
});

test('does not redact ISO timestamps', () => {
  const payload = { ended_at: '2026-05-08T14:00:12.722Z' };
  const redacted = redactValue(payload) as Record<string, unknown>;
  assert.equal(redacted.ended_at, '2026-05-08T14:00:12.722Z');
});
