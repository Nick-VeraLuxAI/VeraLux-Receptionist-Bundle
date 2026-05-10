import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTestEnv } from './testEnv';

setTestEnv();

/**
 * Sprint 0 cohesion tests: prove that tenant prompts (system preamble / policy
 * / tone instructions) reach the brain HTTP request payload, and that
 * tenant A's prompts never leak into tenant B's request.
 *
 * Implementation strategy: stub global fetch, run generateAssistantReply with
 * tenant prompts, then read what the body that would have been sent to the
 * brain. Restore fetch in afterEach.
 */

const ORIGINAL_FETCH = globalThis.fetch;

function captureFetch(): {
  calls: Array<{ url: string; init: RequestInit | undefined }>;
  restore: () => void;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    calls.push({
      url: typeof input === 'string' ? input : String(input?.url ?? input),
      init,
    });
    return new Response(JSON.stringify({ text: 'okay' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as any;
  return {
    calls,
    restore: () => {
      globalThis.fetch = ORIGINAL_FETCH;
    },
  };
}

async function loadBrain() {
  // Force HTTP brain path (platform default), independent of leftover BRAIN_URL in .env.
  process.env.BRAIN_URL = 'http://test-brain.local/reply';
  process.env.BRAIN_USE_LOCAL = 'false';
  process.env.PLATFORM_LLM_PROVIDER = 'brain_http';
  process.env.BRAIN_TIMEOUT_MS = '1500';
  return await import('../src/ai/brainClient');
}

test('Sprint 0: tenant prompts are forwarded in the brain HTTP request body', async () => {
  const { generateAssistantReply } = await loadBrain();
  const cap = captureFetch();
  try {
    await generateAssistantReply({
      tenantId: 'alpha',
      callControlId: 'call-1',
      transcript: 'hello',
      history: [],
      prompts: {
        systemPreamble: 'TENANT-ALPHA-SYS',
        schemaHint: 'JSON',
        policyPrompt: 'TENANT-ALPHA-POLICY',
        voicePrompt: 'TENANT-ALPHA-TONE',
      },
    });
    assert.equal(cap.calls.length, 1, 'brain was called once');
    const body = JSON.parse(String(cap.calls[0].init?.body ?? '{}'));
    assert.equal(body.tenantId, 'alpha');
    assert.ok(body.prompts, 'prompts is present in the brain request body');
    assert.equal(body.prompts.systemPreamble, 'TENANT-ALPHA-SYS');
    assert.equal(body.prompts.policyPrompt, 'TENANT-ALPHA-POLICY');
    assert.equal(body.prompts.voicePrompt, 'TENANT-ALPHA-TONE');
  } finally {
    cap.restore();
  }
});

test('Sprint 0: tenant A prompts do not leak into tenant B request', async () => {
  const { generateAssistantReply } = await loadBrain();
  const cap = captureFetch();
  try {
    await generateAssistantReply({
      tenantId: 'alpha',
      callControlId: 'call-A',
      transcript: 'hi',
      history: [],
      prompts: {
        systemPreamble: 'TENANT-A',
        schemaHint: '',
        policyPrompt: '',
        voicePrompt: '',
      },
    });
    await generateAssistantReply({
      tenantId: 'beta',
      callControlId: 'call-B',
      transcript: 'hi',
      history: [],
      prompts: {
        systemPreamble: 'TENANT-B',
        schemaHint: '',
        policyPrompt: '',
        voicePrompt: '',
      },
    });
    assert.equal(cap.calls.length, 2);
    const bodyA = JSON.parse(String(cap.calls[0].init?.body ?? '{}'));
    const bodyB = JSON.parse(String(cap.calls[1].init?.body ?? '{}'));
    assert.equal(bodyA.tenantId, 'alpha');
    assert.equal(bodyB.tenantId, 'beta');
    assert.equal(bodyA.prompts.systemPreamble, 'TENANT-A');
    assert.equal(bodyB.prompts.systemPreamble, 'TENANT-B');
    assert.notEqual(bodyA.prompts.systemPreamble, bodyB.prompts.systemPreamble);
  } finally {
    cap.restore();
  }
});

test('Sprint 0: missing prompts fall back safely (no `prompts` key in payload)', async () => {
  const { generateAssistantReply } = await loadBrain();
  const cap = captureFetch();
  try {
    await generateAssistantReply({
      tenantId: 'gamma',
      callControlId: 'call-3',
      transcript: 'hi',
      history: [],
      // no prompts at all
    });
    assert.equal(cap.calls.length, 1);
    const body = JSON.parse(String(cap.calls[0].init?.body ?? '{}'));
    assert.equal(body.prompts, undefined, 'no prompts key when input has none');
    assert.equal(body.tenantId, 'gamma');
  } finally {
    cap.restore();
  }
});

test('Sprint 0: blank prompt fields are stripped (no empty preamble overwrite)', async () => {
  const { generateAssistantReply } = await loadBrain();
  const cap = captureFetch();
  try {
    await generateAssistantReply({
      tenantId: 'delta',
      callControlId: 'call-4',
      transcript: 'hi',
      history: [],
      prompts: {
        systemPreamble: '   ',
        schemaHint: '',
        policyPrompt: 'POL-D',
        voicePrompt: '',
      },
    });
    const body = JSON.parse(String(cap.calls[0].init?.body ?? '{}'));
    assert.ok(body.prompts, 'prompts is present (policyPrompt is set)');
    assert.equal(body.prompts.policyPrompt, 'POL-D');
    assert.equal(body.prompts.systemPreamble, undefined, 'blank fields are dropped');
    assert.equal(body.prompts.voicePrompt, undefined);
  } finally {
    cap.restore();
  }
});
