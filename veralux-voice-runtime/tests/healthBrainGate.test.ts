import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  executeStrictVoiceBrainGate,
  resolveStrictVoiceBrainPlan,
  voiceStrictPlaneReady,
} from '../src/healthBrainGate';

test('resolveStrictVoiceBrainPlan: local brain skips HTTP', () => {
  const p = resolveStrictVoiceBrainPlan({
    brainUseLocal: true,
    brainHealthRequired: true,
    llmHealthUrl: 'http://x/health',
    derivedBrainHealthUrl: 'http://brain/health',
  });
  assert.equal(p.action, 'skip');
  if (p.action === 'skip') assert.equal(p.status, 'skipped_local');
});

test('resolveStrictVoiceBrainPlan: no URL → not_configured', () => {
  const p = resolveStrictVoiceBrainPlan({
    brainUseLocal: false,
    brainHealthRequired: false,
    llmHealthUrl: undefined,
    derivedBrainHealthUrl: undefined,
  });
  assert.equal(p.action, 'skip');
  if (p.action === 'skip') assert.equal(p.status, 'not_configured');
});

test('resolveStrictVoiceBrainPlan: explicit LLM_HEALTH_URL + not required → skipped_optional', () => {
  const p = resolveStrictVoiceBrainPlan({
    brainUseLocal: false,
    brainHealthRequired: false,
    llmHealthUrl: 'http://brain:3001/health',
    derivedBrainHealthUrl: undefined,
  });
  assert.equal(p.action, 'skip');
  if (p.action === 'skip') assert.equal(p.status, 'skipped_optional');
});

test('resolveStrictVoiceBrainPlan: derived URL + required → probe', () => {
  const p = resolveStrictVoiceBrainPlan({
    brainUseLocal: false,
    brainHealthRequired: true,
    llmHealthUrl: undefined,
    derivedBrainHealthUrl: 'http://brain:3001/health',
  });
  assert.equal(p.action, 'probe');
  if (p.action === 'probe') assert.equal(p.url, 'http://brain:3001/health');
});

test('resolveStrictVoiceBrainPlan: LLM_HEALTH_URL wins over derived when both set', () => {
  const p = resolveStrictVoiceBrainPlan({
    brainUseLocal: false,
    brainHealthRequired: true,
    llmHealthUrl: 'http://explicit/health',
    derivedBrainHealthUrl: 'http://derived/health',
  });
  assert.equal(p.action, 'probe');
  if (p.action === 'probe') assert.equal(p.url, 'http://explicit/health');
});

test('executeStrictVoiceBrainGate: skip does not call checkUrl', async () => {
  let calls = 0;
  const checkUrl = async () => {
    calls += 1;
    return { ok: true, latency_ms: 1 };
  };
  const plan = resolveStrictVoiceBrainPlan({
    brainUseLocal: false,
    brainHealthRequired: false,
    llmHealthUrl: 'http://x/health',
    derivedBrainHealthUrl: undefined,
  });
  const out = await executeStrictVoiceBrainGate(plan, checkUrl);
  assert.equal(calls, 0);
  assert.equal(out.brainChecked, false);
  assert.equal(out.brainOk, true);
  assert.equal(out.brainCheck.status, 'skipped_optional');
});

test('executeStrictVoiceBrainGate: probe fail → brainOk false', async () => {
  const checkUrl = async () => ({ ok: false, error: 'fetch failed', latency_ms: 2 });
  const out = await executeStrictVoiceBrainGate({ action: 'probe', url: 'http://x' }, checkUrl);
  assert.equal(out.brainChecked, true);
  assert.equal(out.brainOk, false);
  assert.equal(out.brainCheck.status, 'failed');
});

test('executeStrictVoiceBrainGate: probe ok', async () => {
  const checkUrl = async () => ({ ok: true, latency_ms: 3 });
  const out = await executeStrictVoiceBrainGate({ action: 'probe', url: 'http://x' }, checkUrl);
  assert.equal(out.brainOk, true);
  assert.equal(out.brainCheck.status, 'ok');
});

test('voiceStrictPlaneReady: Redis failure blocks despite optional brain ok', () => {
  assert.equal(
    voiceStrictPlaneReady({ redisOk: false, sttOk: true, ttsOk: true, brainOk: true }),
    false,
  );
});

test('voiceStrictPlaneReady: STT failure blocks', () => {
  assert.equal(
    voiceStrictPlaneReady({ redisOk: true, sttOk: false, ttsOk: true, brainOk: true }),
    false,
  );
});

test('voiceStrictPlaneReady: required brain failure blocks', () => {
  assert.equal(
    voiceStrictPlaneReady({ redisOk: true, sttOk: true, ttsOk: true, brainOk: false }),
    false,
  );
});

test('voiceStrictPlaneReady: all ok', () => {
  assert.equal(
    voiceStrictPlaneReady({ redisOk: true, sttOk: true, ttsOk: true, brainOk: true }),
    true,
  );
});

test('voiceStrictPlaneReady: platform OpenAI constraint can fail', () => {
  assert.equal(
    voiceStrictPlaneReady({
      redisOk: true,
      sttOk: true,
      ttsOk: true,
      brainOk: true,
      platformOpenaiOk: false,
    }),
    false,
  );
});
