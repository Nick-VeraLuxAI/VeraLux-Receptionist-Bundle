"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateAssistantReply = generateAssistantReply;
exports.generateAssistantReplyStream = generateAssistantReplyStream;
const shared_1 = require("@veralux/shared");
const env_1 = require("../env");
const log_1 = require("../log");
const metrics_1 = require("../metrics");
const circuitBreaker_1 = require("../providers/circuitBreaker");
const defaultBrain_1 = require("./defaultBrain");
const llmProviderResolve_1 = require("./llmProviderResolve");

/** VERA_DEMO_SHOP_FIX_20260904: pino logs Error as {} unless fields are copied. */
function serializeCaughtError(error, depth) {
    const d = depth || 0;
    if (error == null) {
        return { value: String(error) };
    }
    if (typeof error !== "object") {
        return { value: String(error) };
    }
    const out = {};
    const name = error.name;
    const message = error.message;
    const stack = error.stack;
    if (typeof name === "string" && name)
        out.name = name;
    if (typeof message === "string")
        out.message = message;
    else if (message != null)
        out.message = String(message);
    if (typeof stack === "string" && stack)
        out.stack = stack.slice(0, 4000);
    const status = error.status ?? error.statusCode ?? error.status_code;
    if (status != null)
        out.status = status;
    let body = error.body ?? error.responseBody ?? error.response_body;
    if (body != null) {
        if (typeof body === "string")
            out.body_snippet = body.slice(0, 500);
        else {
            try {
                out.body_snippet = JSON.stringify(body).slice(0, 500);
            }
            catch {
                out.body_snippet = String(body).slice(0, 500);
            }
        }
    }
    const code = error.code;
    if (typeof code === "string" || typeof code === "number")
        out.code = code;
    const cause = error.cause;
    if (cause != null && d < 3)
        out.cause = serializeCaughtError(cause, d + 1);
    if (!out.message && !out.name) {
        try {
            out.json = JSON.stringify(error).slice(0, 1000);
        }
        catch {
            out.json = "[unserializable]";
        }
    }
    return out;
}
function sanitizePrompts(p) {
    if (!p)
        return undefined;
    // Drop empty fields so we never wipe brain-side defaults with blanks.
    const out = {};
    if (typeof p.systemPreamble === 'string' && p.systemPreamble.trim()) {
        out.systemPreamble = p.systemPreamble;
    }
    if (typeof p.schemaHint === 'string' && p.schemaHint.trim()) {
        out.schemaHint = p.schemaHint;
    }
    if (typeof p.policyPrompt === 'string' && p.policyPrompt.trim()) {
        out.policyPrompt = p.policyPrompt;
    }
    if (typeof p.voicePrompt === 'string' && p.voicePrompt.trim()) {
        out.voicePrompt = p.voicePrompt;
    }
    if (typeof p.greetingText === 'string' && p.greetingText.trim()) {
        out.greetingText = p.greetingText;
    }
    return Object.keys(out).length > 0 ? out : undefined;
}
function parseTransferAction(raw) {
    if (!raw || typeof raw !== 'object')
        return undefined;
    const o = raw;
    const to = typeof o.to === 'string' && o.to.trim() ? o.to.trim() : undefined;
    if (!to)
        return undefined;
    const audioUrl = typeof o.audioUrl === 'string' && o.audioUrl.trim() ? o.audioUrl.trim() : undefined;
    const timeoutSecs = typeof o.timeoutSecs === 'number' && o.timeoutSecs >= 5 && o.timeoutSecs <= 600
        ? o.timeoutSecs
        : undefined;
    return { to, audioUrl, timeoutSecs };
}
function parseVoiceDirective(raw) {
    if (!raw || typeof raw !== 'object')
        return undefined;
    const o = raw;
    // mode is required and must be 'preset' or 'cloned'
    const mode = typeof o.mode === 'string' ? o.mode.trim().toLowerCase() : undefined;
    if (mode !== 'preset' && mode !== 'cloned')
        return undefined;
    const speakerWavUrl = typeof o.speakerWavUrl === 'string' && o.speakerWavUrl.trim()
        ? o.speakerWavUrl.trim()
        : undefined;
    return { mode, speakerWavUrl };
}
function buildBrainUrl(base) {
    const trimmed = base.replace(/\/$/, '');
    if (trimmed.endsWith('/reply/stream')) {
        return trimmed.replace(/\/reply\/stream$/, '/reply');
    }
    if (trimmed.endsWith('/reply')) {
        return trimmed;
    }
    return `${trimmed}/reply`;
}
function buildBrainStreamUrl(base) {
    const trimmed = base.replace(/\/$/, '');
    if (trimmed.endsWith('/reply/stream')) {
        return trimmed;
    }
    let path = env_1.env.BRAIN_STREAM_PATH;
    if (!path.startsWith('/')) {
        path = `/${path}`;
    }
    if (trimmed.endsWith('/reply') && path.startsWith('/reply/')) {
        path = path.slice('/reply'.length);
    }
    return `${trimmed}${path}`;
}
async function readResponseText(response) {
    try {
        return await response.text();
    }
    catch {
        return '';
    }
}
function parseSseBlock(block) {
    const lines = block.split('\n');
    let event = 'message';
    const dataLines = [];
    for (const line of lines) {
        if (!line || line.startsWith(':')) {
            continue;
        }
        if (line.startsWith('event:')) {
            event = line.slice('event:'.length).trim();
            continue;
        }
        if (line.startsWith('data:')) {
            dataLines.push(line.slice('data:'.length).trimStart());
        }
    }
    if (dataLines.length === 0) {
        return null;
    }
    return { event, data: dataLines.join('\n') };
}
async function generateOpenAiDirectReply(input, plan) {
    const sysParts = [];
    const p = sanitizePrompts(input.prompts);
    if (p?.systemPreamble)
        sysParts.push(p.systemPreamble);
    if (p?.policyPrompt)
        sysParts.push(p.policyPrompt);
    if (p?.voicePrompt)
        sysParts.push(p.voicePrompt);
    if (p?.schemaHint)
        sysParts.push(p.schemaHint);
    if (input.assistantContext && Object.keys(input.assistantContext).length > 0) {
        sysParts.push('Business context:\n' +
            Object.entries(input.assistantContext)
                .map(([k, v]) => `${k}: ${v}`)
                .join('\n'));
    }
    const system = sysParts.join('\n\n').trim() || 'You are a helpful professional phone receptionist. Keep replies concise for voice.';
    const messages = [
        { role: 'system', content: system },
        ...input.history.map((t) => ({
            role: (t.role === 'assistant' ? 'assistant' : 'user'),
            content: t.content,
        })),
        { role: 'user', content: input.transcript },
    ];
    const url = `${plan.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env_1.env.BRAIN_TIMEOUT_MS);
    try {
        await input.forensics?.recordLlmRequestPayload({
            route: 'openai_direct',
            tenantId: input.tenantId,
            callControlId: input.callControlId,
            model: plan.model,
            history_turns: input.history.length,
        });
        const response = await (0, circuitBreaker_1.withCircuitBreaker)({
            key: 'openai_direct',
            failureThreshold: 3,
            openMs: 20000,
            onOpen: () => (0, metrics_1.incProviderCircuitOpen)('openai_direct'),
            action: () => fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${plan.apiKey}`,
                },
                body: JSON.stringify({
                    model: plan.model,
                    messages,
                    max_tokens: 512,
                    temperature: 0.4,
                    // VERA_DEMO_SHOP_THINKOFF_20260905 — disable Nemotron thinking for non-stream replies (empty-content fix)
                    chat_template_kwargs: { enable_thinking: false },
                }),
                signal: controller.signal,
            }),
        });
        if (!response.ok) {
            const body = await readResponseText(response);
            const preview = body.length > 500 ? `${body.slice(0, 500)}...` : body;
            throw new Error(`openai reply failed ${response.status}: ${preview}`);
        }
        const data = (await response.json());
        const text = typeof data.choices?.[0]?.message?.content === 'string' ? data.choices[0].message.content.trim() : '';
        if (!text) {
            throw new Error('openai reply missing text');
        }
        const result = { text, source: 'openai_direct' };
        await input.forensics?.recordLlmResponse({ text: result.text, source: result.source });
        return result;
    }
    catch (error) {
        if (error instanceof Error &&
            (error.name === 'AbortError' || /aborted|timeout/i.test(error.message))) {
            (0, metrics_1.incProviderTimeout)('brain_http');
        }
        log_1.log.error({
            err: error,
            event: 'openai_reply_failed',
            call_control_id: input.callControlId,
            tenant_id: input.tenantId,
        }, 'openai direct reply failed');
        const fb = { text: shared_1.ASSISTANT_VOICE_LLM_ERROR_FALLBACK, source: 'fallback_error' };
        await input.forensics?.recordLlmResponse(fb);
        return fb;
    }
    finally {
        clearTimeout(timeout);
    }
}
async function generateAnthropicDirectReply(input, plan) {
    const sysParts = [];
    const p = sanitizePrompts(input.prompts);
    if (p?.systemPreamble)
        sysParts.push(p.systemPreamble);
    if (p?.policyPrompt)
        sysParts.push(p.policyPrompt);
    if (p?.voicePrompt)
        sysParts.push(p.voicePrompt);
    if (p?.schemaHint)
        sysParts.push(p.schemaHint);
    if (input.assistantContext && Object.keys(input.assistantContext).length > 0) {
        sysParts.push('Business context:\n' +
            Object.entries(input.assistantContext)
                .map(([k, v]) => `${k}: ${v}`)
                .join('\n'));
    }
    const system = sysParts.join('\n\n').trim() || 'You are a helpful professional phone receptionist. Keep replies concise for voice.';
    const messages = [
        ...input.history.map((t) => ({
            role: (t.role === 'assistant' ? 'assistant' : 'user'),
            content: t.content,
        })).filter((m) => m.content && String(m.content).trim()),
        { role: 'user', content: input.transcript },
    ];
    if (messages[0]?.role === 'assistant') {
        messages.unshift({ role: 'user', content: 'Hello' });
    }
    const url = 'https://api.anthropic.com/v1/messages';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env_1.env.BRAIN_TIMEOUT_MS);
    try {
        await input.forensics?.recordLlmRequestPayload({
            route: 'anthropic_direct',
            tenantId: input.tenantId,
            callControlId: input.callControlId,
            model: plan.model,
            history_turns: input.history.length,
        });
        const response = await (0, circuitBreaker_1.withCircuitBreaker)({
            key: 'anthropic_direct',
            failureThreshold: 3,
            openMs: 20_000,
            onOpen: () => (0, metrics_1.incProviderCircuitOpen)('openai_direct'),
            action: () => fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': plan.apiKey,
                    'anthropic-version': '2023-06-01',
                },
                body: JSON.stringify({
                    model: plan.model,
                    max_tokens: 512,
                    system,
                    messages,
                }),
                signal: controller.signal,
            }),
        });
        if (!response.ok) {
            const body = await readResponseText(response);
            const preview = body.length > 500 ? `${body.slice(0, 500)}...` : body;
            throw new Error(`anthropic reply failed ${response.status}: ${preview}`);
        }
        const data = (await response.json());
        const text = (data.content || [])
            .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text)
            .join('')
            .trim();
        if (!text) {
            throw new Error('anthropic reply missing text');
        }
        const result = { text, source: 'anthropic_direct' };
        await input.forensics?.recordLlmResponse({ text: result.text, source: result.source });
        return result;
    }
    catch (error) {
        log_1.log.error({
            err: error,
            event: 'anthropic_reply_failed',
            call_control_id: input.callControlId,
            tenant_id: input.tenantId,
        }, 'anthropic direct reply failed');
        const fb = { text: shared_1.ASSISTANT_VOICE_LLM_ERROR_FALLBACK, source: 'fallback_error' };
        await input.forensics?.recordLlmResponse(fb);
        return fb;
    }
    finally {
        clearTimeout(timeout);
    }
}
async function readSseStream(response, onEvent) {
    if (!response.body) {
        throw new Error('brain stream missing body');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
        const { value, done } = await reader.read();
        if (done) {
            break;
        }
        buffer += decoder.decode(value, { stream: true });
        buffer = buffer.replace(/\r\n/g, '\n');
        let boundaryIndex = buffer.indexOf('\n\n');
        while (boundaryIndex !== -1) {
            const block = buffer.slice(0, boundaryIndex);
            buffer = buffer.slice(boundaryIndex + 2);
            const parsed = parseSseBlock(block);
            if (parsed) {
                const shouldContinue = onEvent(parsed);
                if (shouldContinue === false) {
                    // VERA_DEMO_SHOP_FIX_20260904: cancel() on an already-closing
                    // SSE body throws AbortError (logged as err:{}), aborting a
                    // successful short completion including Nemotron [DONE].
                    try {
                        await reader.cancel();
                    }
                    catch {
                        // ignore expected cancel/abort while the stream is finishing
                    }
                    return;
                }
            }
            boundaryIndex = buffer.indexOf('\n\n');
        }
    }
    buffer += decoder.decode();
    buffer = buffer.replace(/\r\n/g, '\n');
    const trailing = buffer.trim();
    if (trailing) {
        const parsed = parseSseBlock(trailing);
        if (parsed) {
            onEvent(parsed);
        }
    }
}
async function generateAssistantReply(input) {
    const plan = await (0, llmProviderResolve_1.resolveLlmExecutionPlan)({
        tenantId: input.tenantId,
        tenantConfig: input.tenantConfig ?? null,
    });
    log_1.log.info({
        event: 'llm_provider_resolution',
        route: plan.route,
        resolution_source: plan.resolutionSource,
        tenant_id: input.tenantId,
        call_control_id: input.callControlId,
    }, 'llm execution plan');
    if (plan.route === 'fallback_error') {
        log_1.log.warn({
            event: 'provider_resolution_failed',
            reason: plan.reason,
            tenant_id: input.tenantId,
            call_control_id: input.callControlId,
        }, 'llm provider resolution failed');
        const fb = { text: shared_1.ASSISTANT_VOICE_LLM_ERROR_FALLBACK, source: 'fallback_error' };
        await input.forensics?.recordLlmResponse(fb);
        return fb;
    }
    if (plan.route === 'brain_local') {
        await input.forensics?.recordLlmRequestPayload({
            route: 'brain_local_default',
            tenantId: input.tenantId,
            callControlId: input.callControlId,
            transcript: input.transcript,
            history_turns: input.history.length,
        });
        const text = (0, defaultBrain_1.defaultBrainReply)({
            transcript: input.transcript,
            tenantId: input.tenantId,
            assistantContext: input.assistantContext,
            businessHours: input.tenantConfig?.llmContext?.businessHours,
            referenceTime: input.referenceTime,
        });
        log_1.log.info({
            event: 'brain_route',
            source: 'brain_local_default',
            tenant_id: input.tenantId,
            call_control_id: input.callControlId,
        }, 'brain routed to local default');
        await input.forensics?.recordLlmResponse({ text, source: 'brain_local_default' });
        return { text, source: 'brain_local_default' };
    }
    if (plan.route === 'openai_direct') {
        return generateOpenAiDirectReply(input, plan);
    }
    if (plan.route === 'anthropic_direct') {
        return generateAnthropicDirectReply(input, plan);
    }
    const url = buildBrainUrl(plan.baseUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env_1.env.BRAIN_TIMEOUT_MS);
    try {
        log_1.log.info({
            event: 'brain_route',
            source: 'brain_http',
            tenant_id: input.tenantId,
            call_control_id: input.callControlId,
            has_brain_url: true,
        }, 'brain routed to http');
        const sanitizedPrompts = sanitizePrompts(input.prompts);
        const requestBody = {
            tenantId: input.tenantId,
            callControlId: input.callControlId,
            transcript: input.transcript,
            history: input.history,
            ...(input.transferProfiles?.length ? { transferProfiles: input.transferProfiles } : {}),
            ...(input.assistantContext && Object.keys(input.assistantContext).length > 0
                ? { assistantContext: input.assistantContext }
                : {}),
            ...(sanitizedPrompts ? { prompts: sanitizedPrompts } : {}),
        };
        await input.forensics?.recordLlmRequestPayload(requestBody);
        const response = await (0, circuitBreaker_1.withCircuitBreaker)({
            key: 'brain_http',
            failureThreshold: 3,
            openMs: 20000,
            onOpen: () => (0, metrics_1.incProviderCircuitOpen)('brain_http'),
            action: () => fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestBody),
                signal: controller.signal,
            }),
        });
        if (!response.ok) {
            const body = await readResponseText(response);
            const preview = body.length > 500 ? `${body.slice(0, 500)}...` : body;
            throw new Error(`brain reply failed ${response.status}: ${preview}`);
        }
        const data = (await response.json());
        const text = typeof data.text === 'string' ? data.text.trim() : '';
        const transfer = parseTransferAction(data.transfer);
        const voiceDirective = parseVoiceDirective(data.voiceDirective);
        if (!text && !transfer?.to) {
            throw new Error('brain reply missing text and transfer');
        }
        const result = {
            text: text || 'One moment.',
            source: 'brain_http',
        };
        if (transfer)
            result.transfer = transfer;
        if (voiceDirective)
            result.voiceDirective = voiceDirective;
        await input.forensics?.recordLlmResponse({ text: result.text, source: result.source });
        return result;
    }
    catch (error) {
        if (error instanceof Error &&
            (error.name === 'AbortError' || /aborted|timeout/i.test(error.message))) {
            (0, metrics_1.incProviderTimeout)('brain_http');
        }
        log_1.log.error({
            err: error,
            event: 'brain_reply_failed',
            call_control_id: input.callControlId,
            tenant_id: input.tenantId,
        }, 'brain reply failed');
        const fb = { text: shared_1.ASSISTANT_VOICE_LLM_ERROR_FALLBACK, source: 'fallback_error' };
        await input.forensics?.recordLlmResponse(fb);
        return fb;
    }
    finally {
        clearTimeout(timeout);
    }
}

async function generateOpenAiDirectReplyStream(input, plan, onToken) {
    const sysParts = [];
    const p = sanitizePrompts(input.prompts);
    if (p?.systemPreamble)
        sysParts.push(p.systemPreamble);
    if (p?.policyPrompt)
        sysParts.push(p.policyPrompt);
    if (p?.voicePrompt)
        sysParts.push(p.voicePrompt);
    if (p?.schemaHint)
        sysParts.push(p.schemaHint);
    if (input.assistantContext && Object.keys(input.assistantContext).length > 0) {
        sysParts.push('Business context:\n' +
            Object.entries(input.assistantContext)
                .map(([k, v]) => `${k}: ${v}`)
                .join('\n'));
    }
    const system = sysParts.join('\n\n').trim() || 'You are a helpful professional phone receptionist. Keep replies concise for voice.';
    const messages = [
        { role: 'system', content: system },
        ...input.history.map((t) => ({
            role: (t.role === 'assistant' ? 'assistant' : 'user'),
            content: t.content,
        })),
        { role: 'user', content: input.transcript },
    ];
    const url = `${plan.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env_1.env.BRAIN_TIMEOUT_MS);
    const startedAt = Date.now();
    let fullText = '';
    let tokenCount = 0;
    let sawTokens = false;
    const tokenLogEvery = 10;
    try {
        log_1.log.info({
            event: 'brain_route',
            source: 'openai_direct_stream',
            tenant_id: input.tenantId,
            call_control_id: input.callControlId,
            model: plan.model,
            base_url: plan.baseUrl,
        }, 'openai direct stream start');
        await input.forensics?.recordLlmRequestPayload({
            route: 'openai_direct_stream',
            tenantId: input.tenantId,
            callControlId: input.callControlId,
            model: plan.model,
            history_turns: input.history.length,
            stream: true,
        });
        const response = await (0, circuitBreaker_1.withCircuitBreaker)({
            key: 'openai_direct_stream',
            failureThreshold: 3,
            openMs: 20000,
            onOpen: () => (0, metrics_1.incProviderCircuitOpen)('openai_direct_stream'),
            action: () => fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'text/event-stream',
                    Authorization: `Bearer ${plan.apiKey}`,
                },
                body: JSON.stringify({
                    model: plan.model,
                    messages,
                    stream: true,
                    max_tokens: 256,
                    temperature: 0.4,
                    chat_template_kwargs: { enable_thinking: false },
                }),
                signal: controller.signal,
            }),
        });
        if (!response.ok) {
            const body = await readResponseText(response);
            const preview = body.length > 500 ? `${body.slice(0, 500)}...` : body;
            throw new Error(`openai stream failed ${response.status}: ${preview}`);
        }
        await readSseStream(response, ({ data }) => {
            if (!data) {
                return;
            }
            if (data === '[DONE]') {
                return false;
            }
            let payload;
            try {
                payload = JSON.parse(data);
            }
            catch {
                return;
            }
            const delta = payload?.choices?.[0]?.delta;
            if (!delta || typeof delta !== 'object') {
                return;
            }
            // Only surface spoken content tokens; ignore reasoning / thinking deltas.
            const content = typeof delta.content === 'string' ? delta.content : '';
            if (!content) {
                return;
            }
            sawTokens = true;
            fullText += content;
            tokenCount += 1;
            if (tokenCount % tokenLogEvery === 0) {
                log_1.log.info({
                    event: 'openai_direct_stream_token',
                    chunk_len: content.length,
                    total_len: fullText.length,
                    tenant_id: input.tenantId,
                    call_control_id: input.callControlId,
                }, 'openai direct stream token');
            }
            onToken(content);
        });
        const trimmed = fullText.trim();
        if (!trimmed) {
            throw new Error('openai stream missing text');
        }
        const durationMs = Date.now() - startedAt;
        log_1.log.info({
            event: 'openai_direct_stream_done',
            total_len: trimmed.length,
            duration_ms: durationMs,
            tenant_id: input.tenantId,
            call_control_id: input.callControlId,
        }, 'openai direct stream done');
        const result = { text: trimmed, source: 'openai_direct_stream' };
        await input.forensics?.recordLlmResponse({ text: result.text, source: result.source });
        return result;
    }
    catch (error) {
        if (error instanceof Error &&
            (error.name === 'AbortError' || /aborted|timeout/i.test(error.message))) {
            (0, metrics_1.incProviderTimeout)('openai_direct_stream');
        }
        const serialized = serializeCaughtError(error);
        log_1.log.warn({
            err: serialized,
            err_message: serialized.message || String(error),
            event: 'openai_direct_stream_error',
            tenant_id: input.tenantId,
            call_control_id: input.callControlId,
            partial_len: fullText ? fullText.length : 0,
            saw_tokens: sawTokens,
            // VERA_DEMO_SHOP_FIX_20260904
        }, 'openai direct stream error');
        try {
            if (sawTokens && fullText.trim()) {
                const partial = { text: fullText.trim(), source: 'openai_direct_stream' };
                try {
                    await input.forensics?.recordLlmResponse(partial);
                }
                catch (forensicsErr) {
                    log_1.log.warn({ err: serializeCaughtError(forensicsErr), event: 'openai_direct_stream_partial_forensics_error', call_control_id: input.callControlId }, 'openai direct stream partial forensics failed');
                }
                return partial;
            }
            return await generateAssistantReply({ ...input, forensics: undefined });
        }
        catch (inner) {
            log_1.log.warn({ err: serializeCaughtError(inner), event: 'openai_direct_stream_fallback_error', call_control_id: input.callControlId }, 'openai direct stream fallback failed');
            const fb = { text: shared_1.ASSISTANT_VOICE_LLM_ERROR_FALLBACK, source: 'fallback_error' };
            try {
                await input.forensics?.recordLlmResponse(fb);
            }
            catch {
                // ignore forensics failure on last-resort fallback
            }
            return fb;
        }
    }
    finally {
        clearTimeout(timeout);
    }
}

async function generateAssistantReplyStream(input, onToken) {
    const plan = await (0, llmProviderResolve_1.resolveLlmExecutionPlan)({
        tenantId: input.tenantId,
        tenantConfig: input.tenantConfig ?? null,
    });
    // Demo Shop only: stream OpenAI-compatible SSE (Nemotron) for low TTFT on PSTN.
    // Other tenants keep non-stream openai_direct / brain_http behavior unchanged.
    if (plan.route === 'openai_direct' && input.tenantId === 'demo-shop') {
        return generateOpenAiDirectReplyStream(input, plan, onToken);
    }
    if (plan.route !== 'brain_http' || !env_1.env.BRAIN_STREAMING_ENABLED) {
        return generateAssistantReply(input);
    }
    const streamUrl = buildBrainStreamUrl(plan.baseUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), env_1.env.BRAIN_TIMEOUT_MS);
    const startedAt = Date.now();
    const tokenLogEvery = 10;
    let fullText = '';
    let tokenCount = 0;
    let sawTokens = false;
    let transfer;
    let voiceDirective;
    try {
        log_1.log.info({
            event: 'brain_route',
            source: 'brain_http_stream',
            tenant_id: input.tenantId,
            call_control_id: input.callControlId,
            has_brain_url: true,
        }, 'brain routed to stream');
        const sanitizedPrompts = sanitizePrompts(input.prompts);
        const streamRequestBody = {
            tenantId: input.tenantId,
            callControlId: input.callControlId,
            transcript: input.transcript,
            history: input.history,
            ...(input.transferProfiles?.length ? { transferProfiles: input.transferProfiles } : {}),
            ...(input.assistantContext && Object.keys(input.assistantContext).length > 0
                ? { assistantContext: input.assistantContext }
                : {}),
            ...(sanitizedPrompts ? { prompts: sanitizedPrompts } : {}),
        };
        await input.forensics?.recordLlmRequestPayload({ ...streamRequestBody, route: 'brain_http_stream' });
        const response = await (0, circuitBreaker_1.withCircuitBreaker)({
            key: 'brain_http_stream',
            failureThreshold: 3,
            openMs: 20000,
            onOpen: () => (0, metrics_1.incProviderCircuitOpen)('brain_http_stream'),
            action: () => fetch(streamUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'text/event-stream',
                },
                body: JSON.stringify(streamRequestBody),
                signal: controller.signal,
            }),
        });
        const contentType = response.headers.get('content-type') ?? '';
        if (!response.ok) {
            const body = await readResponseText(response);
            const preview = body.length > 500 ? `${body.slice(0, 500)}...` : body;
            throw new Error(`brain stream failed ${response.status}: ${preview}`);
        }
        if (!contentType.includes('text/event-stream')) {
            throw new Error(`brain stream unsupported content-type: ${contentType}`);
        }
        log_1.log.info({
            event: 'brain_stream_start',
            tenant_id: input.tenantId,
            call_control_id: input.callControlId,
        }, 'brain stream start');
        await readSseStream(response, ({ event, data }) => {
            if (event === 'ping' || event === 'meta') {
                return;
            }
            let payload;
            if (data) {
                try {
                    payload = JSON.parse(data);
                }
                catch {
                    payload = undefined;
                }
            }
            if (event === 'token') {
                const chunk = payload && typeof payload.t === 'string'
                    ? payload.t
                    : '';
                if (!chunk) {
                    return;
                }
                sawTokens = true;
                fullText += chunk;
                tokenCount += 1;
                if (tokenCount % tokenLogEvery === 0) {
                    log_1.log.info({
                        event: 'brain_stream_token',
                        chunk_len: chunk.length,
                        total_len: fullText.length,
                        tenant_id: input.tenantId,
                        call_control_id: input.callControlId,
                    }, 'brain stream token');
                }
                onToken(chunk);
                return;
            }
            if (event === 'done') {
                const p = payload;
                const text = p && typeof p.text === 'string' ? p.text : '';
                if (text) {
                    fullText = text;
                }
                transfer = parseTransferAction(p?.transfer);
                voiceDirective = parseVoiceDirective(p?.voiceDirective);
                return false;
            }
            if (event === 'error') {
                const message = payload && typeof payload.message === 'string'
                    ? payload.message
                    : 'brain stream error';
                throw new Error(message);
            }
        });
        const trimmed = fullText.trim();
        if (!trimmed) {
            throw new Error('brain stream missing text');
        }
        const durationMs = Date.now() - startedAt;
        log_1.log.info({
            event: 'brain_stream_done',
            total_len: trimmed.length,
            duration_ms: durationMs,
            tenant_id: input.tenantId,
            call_control_id: input.callControlId,
        }, 'brain stream done');
        const result = {
            text: trimmed,
            source: 'brain_http_stream',
        };
        if (transfer)
            result.transfer = transfer;
        if (voiceDirective)
            result.voiceDirective = voiceDirective;
        await input.forensics?.recordLlmResponse({ text: result.text, source: result.source });
        return result;
    }
    catch (error) {
        if (error instanceof Error &&
            (error.name === 'AbortError' || /aborted|timeout/i.test(error.message))) {
            (0, metrics_1.incProviderTimeout)('brain_http_stream');
        }
        log_1.log.warn({
            err: error,
            event: 'brain_stream_error',
            tenant_id: input.tenantId,
            call_control_id: input.callControlId,
        }, 'brain stream error');
        if (sawTokens && fullText.trim()) {
            const partial = { text: fullText.trim(), source: 'brain_http_stream' };
            await input.forensics?.recordLlmResponse(partial);
            return partial;
        }
        return generateAssistantReply({ ...input, forensics: undefined });
    }
    finally {
        clearTimeout(timeout);
    }
}
//# sourceMappingURL=brainClient.js.map