/**
 * 推理往返(`encrypted_content` 信封)与会话键派生 conversationId 的端到端守卫。
 *
 * 用会记录上游请求体的 stub provider 走完整路由:下行看 reasoning item 带不带信封,
 * 回程看信封是否还原成 history 的 `reasoningContent`;conversationId 看同键稳定、异键隔离。
 * 背景与实测见 PITFALLS「会话身份映射到 kiro-cli」「推理往返」。
 */

import type { AxiosResponse } from 'axios';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  decodeReasoningEnvelope,
  encodeReasoningEnvelope,
} from '../../../src/claude/reasoning-envelope.js';
import type { KiroProvider } from '../../../src/kiro/provider.js';
import { HookBus } from '../../../src/plugin-host/index.js';
import { registerOpenAiRoutes } from '../../../src/routes/openai.js';
import { requestContextStorage } from '../../../src/shared/request-context.js';
import {
  buildAssistantResponseFrame,
  buildMetadataFrame,
  buildMeteringFrame,
  buildReasoningContentFrame,
  buildRedactedReasoningFrame,
  buildToolUseFrame,
  withoutReasoningEnvelopes,
} from '../../helpers/event-stream.js';

const API_KEY = 'test-key';
const METERING = { unit: 'credit', unitPlural: 'credits', usage: 0.1 };
const BLOB = 'LktUUn5+ZW5jcnlwdGVkLWdwdC1yZWFzb25pbmc=';
const GPT = 'gpt-5.6-sol';

interface Recorder {
  bodies: Array<Record<string, unknown>>;
}

function response(data: unknown): AxiosResponse {
  return {
    data: data as AxiosResponse['data'],
    status: 200,
    statusText: 'OK',
    headers: {},
    config: {} as AxiosResponse['config'],
  };
}

async function* chunks(buffers: Buffer[]): AsyncIterable<Buffer> {
  for (const b of buffers) yield b;
}

async function buildApp(frames: Buffer[], rec: Recorder): Promise<FastifyInstance> {
  const provider = {
    callApi: async (body: string) => {
      rec.bodies.push(JSON.parse(body));
      return response(Buffer.concat(frames));
    },
    callApiStream: async (body: string) => {
      rec.bodies.push(JSON.parse(body));
      return response(chunks(frames));
    },
  } as unknown as KiroProvider;
  const app = Fastify({ logger: false });
  app.addHook('onRequest', (_request, _reply, done) => {
    requestContextStorage.run({ reqId: 'test-req', startTime: Date.now() }, done);
  });
  await app.register(
    async (instance) =>
      registerOpenAiRoutes(instance, {
        apiKey: API_KEY,
        kiroProvider: provider,
        extractThinking: false,
        identityOverride: false,
        rejectUnsupportedDocuments: false,
        emptyStreamRetries: 0,
        toolCallTextRescue: false,
        hookBus: new HookBus(),
      }),
    { prefix: '/openai/v1' },
  );
  await app.ready();
  return app;
}

function post(
  app: FastifyInstance,
  url: string,
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: 'POST',
    url: `/openai/v1/${url}`,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${API_KEY}`,
      ...headers,
    },
    payload,
  });
}

function sseItems(payload: string): Array<Record<string, unknown>> {
  return payload
    .split('\n\n')
    .map((b) => b.trim())
    .filter((b) => b.startsWith('data:'))
    .map((b) => JSON.parse(b.slice(5).trim()) as Record<string, unknown>)
    .filter((e) => e.type === 'response.output_item.done')
    .map((e) => e.item as Record<string, unknown>);
}

function conversationState(body: Record<string, unknown>) {
  return body.conversationState as {
    conversationId: string;
    history: Array<{ assistantResponseMessage?: Record<string, unknown> }>;
  };
}

/** GPT 的真实顺序:tool_use 先完成,加密推理帧在末尾才到。 */
const gptToolFrames = [
  buildToolUseFrame('run', 'call_1', '{"cmd":"ls"}', true),
  buildRedactedReasoningFrame(BLOB),
  buildMeteringFrame(METERING),
  buildMetadataFrame(),
];

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('reasoning envelope', () => {
  it('round-trips both Kiro reasoning shapes only for the model that issued them', () => {
    const redacted = encodeReasoningEnvelope({ redactedContent: BLOB }, GPT);
    expect(decodeReasoningEnvelope(redacted, GPT)).toEqual({
      ok: true,
      reasoning: { redactedContent: BLOB },
    });
    const signed = encodeReasoningEnvelope(
      { reasoningText: { text: 'plan', signature: 'sig' } },
      'claude-opus-5',
    );
    expect(decodeReasoningEnvelope(signed, 'claude-opus-5')).toEqual({
      ok: true,
      reasoning: { reasoningText: { text: 'plan', signature: 'sig' } },
    });
    expect(decodeReasoningEnvelope(redacted, 'claude-opus-5')).toEqual({
      ok: false,
      reason: 'model_mismatch',
    });
  });

  it('rejects foreign ciphertext and malformed or unsigned envelopes', () => {
    const forge = (v: unknown) => `k2c.r2.${JSON.stringify(v)}`;
    expect(decodeReasoningEnvelope('gAAAAABopenai-ciphertext', GPT)).toEqual({
      ok: false,
      reason: 'foreign',
    });
    expect(decodeReasoningEnvelope(undefined, GPT).ok).toBe(false);
    expect(decodeReasoningEnvelope(null, GPT).ok).toBe(false);
    expect(decodeReasoningEnvelope('k2c.r2.@@@', GPT)).toEqual({ ok: false, reason: 'malformed' });
    // 网关签发、但版本不认得的信封:丢弃,不能当外来 redacted 数据原样上送
    expect(decodeReasoningEnvelope('k2c.r1.eyJtIjoiZ3B0In0', GPT)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(decodeReasoningEnvelope(forge({ m: GPT, r: {} }), GPT).ok).toBe(false);
    expect(
      decodeReasoningEnvelope(forge({ m: GPT, r: { reasoningText: { text: 'x' } } }), GPT).ok,
    ).toBe(false);
    // 多余字段一律不带出去
    expect(
      decodeReasoningEnvelope(forge({ m: GPT, r: { redactedContent: BLOB, extra: 'leak' } }), GPT),
    ).toEqual({ ok: true, reasoning: { redactedContent: BLOB } });
  });
});

describe('Responses reasoning round-trip', () => {
  it('streams GPT redacted reasoning as an enveloped item after the tool call when requested', async () => {
    const rec: Recorder = { bodies: [] };
    app = await buildApp(gptToolFrames, rec);
    const res = await post(app, 'responses', {
      model: GPT,
      stream: true,
      include: ['reasoning.encrypted_content'],
      input: 'list files',
    });
    const items = sseItems(res.payload);
    expect(items.map((i) => i.type)).toEqual(['function_call', 'reasoning']);
    expect(items[1].summary).toEqual([]);
    expect(decodeReasoningEnvelope(items[1].encrypted_content, GPT)).toEqual({
      ok: true,
      reasoning: { redactedContent: BLOB },
    });
    // 密文只随信封下发
    expect(withoutReasoningEnvelopes(res.payload)).not.toContain(BLOB);
  });

  it('envelopes the V3 GPT frame ({text:"...", signature}) as reasoningText without surfacing "..."', async () => {
    const rec: Recorder = { bodies: [] };
    app = await buildApp(
      [
        buildToolUseFrame('run', 'call_1', '{"cmd":"ls"}', true),
        buildReasoningContentFrame('...', 'sig-gpt'),
        buildMeteringFrame(METERING),
        buildMetadataFrame(),
      ],
      rec,
    );
    const res = await post(app, 'responses', {
      model: GPT,
      stream: true,
      include: ['reasoning.encrypted_content'],
      input: 'list files',
    });
    const items = sseItems(res.payload);
    expect(items.map((i) => i.type)).toEqual(['function_call', 'reasoning']);
    expect(items[1].summary).toEqual([]);
    expect(decodeReasoningEnvelope(items[1].encrypted_content, GPT)).toEqual({
      ok: true,
      reasoning: { reasoningText: { text: '...', signature: 'sig-gpt' } },
    });
    expect(res.payload).not.toContain('reasoning_summary_text');
  });

  it('keeps the old wire when include is absent', async () => {
    const rec: Recorder = { bodies: [] };
    app = await buildApp(gptToolFrames, rec);
    const res = await post(app, 'responses', { model: GPT, stream: true, input: 'list files' });
    expect(sseItems(res.payload).map((i) => i.type)).toEqual(['function_call']);
    expect(res.payload).not.toContain('encrypted_content');
  });

  it('replays the envelope as reasoningContent on the same assistant message as the tool call', async () => {
    const rec: Recorder = { bodies: [] };
    app = await buildApp(gptToolFrames, rec);
    const first = await post(app, 'responses', {
      model: GPT,
      stream: true,
      include: ['reasoning.encrypted_content'],
      input: 'list files',
    });
    const [call, reasoning] = sseItems(first.payload);
    await post(app, 'responses', {
      model: GPT,
      stream: true,
      include: ['reasoning.encrypted_content'],
      input: [
        { role: 'user', content: 'list files' },
        call,
        reasoning,
        { type: 'function_call_output', call_id: 'call_1', output: 'a.txt' },
      ],
    });
    const history = conversationState(rec.bodies[1]).history;
    expect(history[1].assistantResponseMessage).toMatchObject({
      reasoningContent: { redactedContent: BLOB },
      toolUses: [{ toolUseId: 'call_1', name: 'run' }],
    });
  });

  it('drops reasoning issued by another model after a mid-session model switch', async () => {
    const rec: Recorder = { bodies: [] };
    app = await buildApp(gptToolFrames, rec);
    await post(app, 'responses', {
      model: 'claude-opus-5',
      stream: true,
      include: ['reasoning.encrypted_content'],
      input: [
        { role: 'user', content: 'list files' },
        { type: 'function_call', call_id: 'call_1', name: 'run', arguments: '{}' },
        {
          type: 'reasoning',
          summary: [],
          encrypted_content: encodeReasoningEnvelope({ redactedContent: BLOB }, GPT),
        },
        { type: 'function_call_output', call_id: 'call_1', output: 'a.txt' },
      ],
    });
    expect(JSON.stringify(rec.bodies[0])).not.toContain('reasoningContent');
    expect(JSON.stringify(rec.bodies[0])).not.toContain(BLOB);
  });

  it('envelopes Claude signed thinking with the exact signed text', async () => {
    const rec: Recorder = { bodies: [] };
    app = await buildApp(
      [
        buildReasoningContentFrame('step one. '),
        buildReasoningContentFrame('step two.', 'sig-abc'),
        buildAssistantResponseFrame('done'),
        buildMeteringFrame(METERING),
        buildMetadataFrame(),
      ],
      rec,
    );
    const res = await post(app, 'responses', {
      model: 'claude-opus-5',
      stream: true,
      include: ['reasoning.encrypted_content'],
      reasoning: { effort: 'high' },
      input: 'think',
    });
    const [reasoning, message] = sseItems(res.payload);
    expect(reasoning.summary).toEqual([{ type: 'summary_text', text: 'step one. step two.' }]);
    expect(decodeReasoningEnvelope(reasoning.encrypted_content, 'claude-opus-5')).toEqual({
      ok: true,
      reasoning: { reasoningText: { text: 'step one. step two.', signature: 'sig-abc' } },
    });
    await post(app, 'responses', {
      model: 'claude-opus-5',
      stream: true,
      include: ['reasoning.encrypted_content'],
      input: [
        { role: 'user', content: 'think' },
        reasoning,
        message,
        { role: 'user', content: 'next' },
      ],
    });
    expect(conversationState(rec.bodies[1]).history[1].assistantResponseMessage).toMatchObject({
      content: 'done',
      reasoningContent: { reasoningText: { text: 'step one. step two.', signature: 'sig-abc' } },
    });
  });

  it('puts the enveloped GPT reasoning last in non-stream output, like the stream', async () => {
    const rec: Recorder = { bodies: [] };
    app = await buildApp(gptToolFrames, rec);
    const res = await post(app, 'responses', {
      model: GPT,
      include: ['reasoning.encrypted_content'],
      input: 'list files',
    });
    const output = res.json().output as Array<Record<string, unknown>>;
    expect(output.map((i) => i.type)).toEqual(['function_call', 'reasoning']);
    expect(decodeReasoningEnvelope(output[1].encrypted_content, GPT).ok).toBe(true);
  });
});

describe('session key → conversationId', () => {
  it('is stable within a prompt_cache_key and distinct across keys (Responses)', async () => {
    const rec: Recorder = { bodies: [] };
    app = await buildApp(gptToolFrames, rec);
    for (const key of ['thread-a', 'thread-a', 'thread-b', undefined, undefined]) {
      await post(app, 'responses', { model: GPT, input: 'hi', prompt_cache_key: key });
    }
    const ids = rec.bodies.map((b) => conversationState(b).conversationId);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
    expect(ids[3]).not.toBe(ids[4]);
    expect(new Set([ids[0], ids[2], ids[3], ids[4]]).size).toBe(4);
    expect(ids[0]).toMatch(
      /^sess_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(ids[0]).not.toContain('thread-a');
  });

  it('uses the same derivation on Chat Completions and ignores non-string keys', async () => {
    const rec: Recorder = { bodies: [] };
    app = await buildApp(gptToolFrames, rec);
    const messages = [{ role: 'user', content: 'hi' }];
    await post(app, 'responses', { model: GPT, input: 'hi', prompt_cache_key: 'thread-a' });
    await post(app, 'chat/completions', { model: GPT, messages, prompt_cache_key: 'thread-a' });
    await post(app, 'chat/completions', { model: GPT, messages, prompt_cache_key: 42 });
    await post(app, 'chat/completions', { model: GPT, messages, prompt_cache_key: 42 });
    const ids = rec.bodies.map((b) => conversationState(b).conversationId);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[3]);
  });

  it('maps Codex subagent threads to KAS subagent sessions', async () => {
    // KAS 的 subagent:自己的 conversationId 与 acid、rootConversationId 指向父会话、顶层 agentMode
    // 换成子 agent 的(2.23.1 抓包)。Codex 父子共用 prompt_cache_key,只有 thread-id 不同。
    const rec: Recorder = { bodies: [] };
    app = await buildApp(gptToolFrames, rec);
    const body = { model: GPT, input: 'hi', prompt_cache_key: 'root-session' };
    await post(app, 'responses', body);
    await post(app, 'responses', body, { 'thread-id': 'root-session' });
    await post(app, 'responses', body, { 'thread-id': 'child-1' });
    await post(app, 'responses', body, { 'thread-id': 'child-1' });
    await post(app, 'responses', body, { 'thread-id': 'child-2' });
    const states = rec.bodies.map(conversationState);
    const ids = states.map((st) => st.conversationId);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[3]).toBe(ids[2]);
    expect(new Set([ids[0], ids[2], ids[4]]).size).toBe(3);
    const cs = (i: number) => rec.bodies[i].conversationState as Record<string, unknown>;
    expect(cs(0).rootConversationId).toBe(ids[0]);
    expect(cs(2).rootConversationId).toBe(ids[0]);
    expect(cs(4).rootConversationId).toBe(ids[0]);
    expect(rec.bodies[0].agentMode).toBe('vibe');
    expect(rec.bodies[2].agentMode).toBe('general-task-execution');
    expect(cs(2).agentContinuationId).toBeTypeOf('string');
    expect(cs(2).agentContinuationId).not.toBe(cs(0).agentContinuationId);
  });

  it('does not treat a thread-id without prompt_cache_key as a session', async () => {
    const rec: Recorder = { bodies: [] };
    app = await buildApp(gptToolFrames, rec);
    await post(app, 'responses', { model: GPT, input: 'hi' }, { 'thread-id': 'child-1' });
    await post(app, 'responses', { model: GPT, input: 'hi' }, { 'thread-id': 'child-1' });
    const ids = rec.bodies.map((b) => conversationState(b).conversationId);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('carries no reasoning across sessions: the gateway keeps no per-session state', async () => {
    const rec: Recorder = { bodies: [] };
    app = await buildApp(gptToolFrames, rec);
    const include = ['reasoning.encrypted_content'];
    await post(app, 'responses', {
      model: GPT,
      stream: true,
      include,
      prompt_cache_key: 'thread-a',
      input: 'list files',
    });
    // 另一个会话重放了同名的 call_id,但自己的历史里没有推理 item → 上游不得出现 A 的推理
    await post(app, 'responses', {
      model: GPT,
      stream: true,
      include,
      prompt_cache_key: 'thread-b',
      input: [
        { role: 'user', content: 'list files' },
        { type: 'function_call', call_id: 'call_1', name: 'run', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'a.txt' },
      ],
    });
    expect(JSON.stringify(rec.bodies[1])).not.toContain('reasoningContent');
    expect(conversationState(rec.bodies[1]).conversationId).not.toBe(
      conversationState(rec.bodies[0]).conversationId,
    );
  });
});
