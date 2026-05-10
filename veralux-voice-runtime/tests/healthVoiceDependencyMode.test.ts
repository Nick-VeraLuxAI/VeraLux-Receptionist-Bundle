import assert from 'node:assert/strict';
import { test } from 'node:test';
import './testEnv';
import { preprocessHealthVoiceDependencies } from '../src/env';

test('preprocessHealthVoiceDependencies maps legacy booleans', () => {
  assert.equal(preprocessHealthVoiceDependencies(undefined), 'strict');
  assert.equal(preprocessHealthVoiceDependencies(true), 'strict');
  assert.equal(preprocessHealthVoiceDependencies(false), 'disabled');
});

test('preprocessHealthVoiceDependencies maps string tokens', () => {
  assert.equal(preprocessHealthVoiceDependencies('true'), 'strict');
  assert.equal(preprocessHealthVoiceDependencies('false'), 'disabled');
  assert.equal(preprocessHealthVoiceDependencies('strict'), 'strict');
  assert.equal(preprocessHealthVoiceDependencies('configured'), 'configured');
  assert.equal(preprocessHealthVoiceDependencies('disabled'), 'disabled');
});
