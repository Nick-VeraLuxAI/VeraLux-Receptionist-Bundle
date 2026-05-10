import assert from 'node:assert/strict';
import { test } from 'node:test';
import './testEnv';
import { isDisallowedPlaceholderApiKey, normalizePlatformLlmKind } from '../src/ai/llmProviderResolve';

test('normalizePlatformLlmKind: brain aliases', () => {
  assert.equal(normalizePlatformLlmKind('brain'), 'brain_local');
  assert.equal(normalizePlatformLlmKind('local'), 'brain_local');
  assert.equal(normalizePlatformLlmKind('brain_http'), 'brain_http');
  assert.equal(normalizePlatformLlmKind('openai'), 'openai');
});

test('isDisallowedPlaceholderApiKey', () => {
  assert.equal(isDisallowedPlaceholderApiKey(undefined), true);
  assert.equal(isDisallowedPlaceholderApiKey(''), true);
  assert.equal(isDisallowedPlaceholderApiKey('CHANGE_ME'), true);
  assert.equal(isDisallowedPlaceholderApiKey('sk-proj-real-looking'), false);
});
