import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTestEnv } from './testEnv';

setTestEnv();

import { resolveVoiceControlToken } from '../src/security/voiceControlAuth';

test('voice-control routes reject missing auth', async () => {
  const req = { headers: {} } as any;
  const token = resolveVoiceControlToken(req);
  assert.equal(token, undefined);
});

test('voice-control routes accept configured api key', async () => {
  const req = { headers: { authorization: 'Bearer test-voice-control-key' } } as any;
  const token = resolveVoiceControlToken(req);
  assert.equal(token, 'test-voice-control-key');
});
