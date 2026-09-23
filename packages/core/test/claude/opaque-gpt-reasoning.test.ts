/**
 * GPT 推理在 V3(KAS)下的映射守卫。
 *
 * V3 target 下 GPT 的 `reasoningContentEvent` 是 `{text:"...", signature}`:文本只是占位,绝不能作为
 * thinking 展示;但要原样保留,像 KAS 一样下一轮回传(`reasoningContent.reasoningText`)。
 *   - Messages:收尾产出一个 `redacted_thinking`(data = 网关信封),回程 converter 还原
 *   - Responses:声明 include 时进 reasoning item 的 `encrypted_content`(见 reasoning-roundtrip.test.ts)
 *   - Chat:不回传,也不出现 `reasoning_content`
 * 真相源:`claude/stream/opaque-reasoning.ts`、`claude/reasoning-envelope.ts`。
 */

import type { AxiosResponse } from 'axios';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { convertRequest } from '../../src/claude/converter.js';
import {
  decodeReasoningEnvelope,
  encodeReasoningEnvelope,
} from '../../src/claude/reasoning-envelope.js';
import type { MessagesRequest } from '../../src/claude/types.js';
import type { KiroProvider } from '../../src/kiro/provider.js';
import { HookBus } from '../../src/plugin-host/index.js';
import { registerClaudeRoutes } from '../../src/routes/claude.js';
import { registerOpenAiRoutes } from '../../src/routes/openai.js';
import { requestContextStorage } from '../../src/shared/request-context.js';
import {
  buildAssistantResponseFrame,
  buildMetadataFrame,
  buildMeteringFrame,
  buildReasoningContentFrame,
  buildToolUseFrame,
  parseSseEvents,
  withoutReasoningEnvelopes,
} from '../helpers/event-stream.js';

const API_KEY = 'test-key';
const GPT = 'gpt-5.6-sol';
const SIG = '.KTR~~opaque-gpt-signature';
const METERING = { unit: 'credit', unitPlural: 'credits', usage: 0.1 };

/** V3 的真实顺序:可见输出先到,GPT 推理帧在末尾。 */
const gptFrames = [
  buildToolUseFrame('run', 'call_1', '{"cmd":"ls"}', true),
  buildAssistantResponseFrame('VISIBLE_ANSWER'),
  buildReasoningContentFrame('...', SIG),
  buildMeteringFrame(METERING),
  buildMetadataFrame(),
];

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

async function buildApp(frames: Buffer[]): Promise<FastifyInstance> {
  const provider = {
    callApi: async () => response(Buffer.concat(frames)),
    callApiStream: async () => response(chunks(frames)),
  } as unknown as KiroProvider;
  const deps = {
    apiKey: API_KEY,
    kiroProvider: provider,
    extractThinking: false,
    identityOverride: false,
    rejectUnsupportedDocuments: false,
    emptyStreamRetries: 0,
    toolCallTextRescue: false,
    hookBus: new HookBus(),
  };
  const app = Fastify({ logger: false });
  app.addHook('onRequest', (_request, _reply, done) => {
    requestContextStorage.run({ reqId: 'test-req', startTime: Date.now() }, done);
  });
  await app.register(async (i) => registerClaudeRoutes(i, deps), { prefix: '/claude/v1' });
  await app.register(async (i) => registerOpenAiRoutes(i, deps), { prefix: '/openai/v1' });
  await app.ready();
  return app;
}

function post(app: FastifyInstance, url: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url,
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      authorization: `Bearer ${API_KEY}`,
    },
    payload,
  });
}

const messagesBody = (stream: boolean) => ({
  model: GPT,
  max_tokens: 1024,
  stream,
  messages: [{ role: 'user', content: 'list files' }],
});

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GPT opaque reasoning on the Messages path', () => {
  it('streams exactly one redacted_thinking carrying the reasoning, never the "..." placeholder', async () => {
    app = await buildApp(gptFrames);
    const res = await post(app, '/claude/v1/messages', messagesBody(true));
    const events = parseSseEvents(res.payload);
    const starts = events
      .filter((e) => e.event === 'content_block_start')
      .map((e) => e.data.content_block as { type: string; data?: string });
    // 推理帧晚于可见输出到达,redacted_thinking 只能排在最后,且只有一个
    expect(starts.filter((b) => b.type === 'redacted_thinking')).toHaveLength(1);
    const redacted = starts[starts.length - 1];
    expect(redacted.type).toBe('redacted_thinking');
    expect(starts.some((b) => b.type === 'thinking')).toBe(false);
    expect(decodeReasoningEnvelope(redacted.data, GPT)).toEqual({
      ok: true,
      reasoning: { reasoningText: { text: '...', signature: SIG } },
    });
    expect(events.some((e) => JSON.stringify(e.data).includes('thinking_delta'))).toBe(false);
    // 签名只随信封下发:不出 signature_delta / thinking 块
    expect(withoutReasoningEnvelopes(res.payload)).not.toContain(SIG);
  });

  it('non-stream response carries the same redacted_thinking last, like the stream', async () => {
    app = await buildApp(gptFrames);
    const res = await post(app, '/claude/v1/messages', messagesBody(false));
    const content = res.json().content as Array<{ type: string; data?: string }>;
    expect(content.map((b) => b.type)).toEqual(['text', 'tool_use', 'redacted_thinking']);
    expect(decodeReasoningEnvelope(content[2].data, GPT).ok).toBe(true);
    expect(res.payload).not.toContain('"thinking"');
  });

  it('Chat Completions never surfaces GPT reasoning', async () => {
    app = await buildApp(gptFrames);
    for (const stream of [true, false]) {
      const res = await post(app, '/openai/v1/chat/completions', {
        model: GPT,
        stream,
        messages: [{ role: 'user', content: 'list files' }],
      });
      expect(res.payload).not.toContain('reasoning_content');
      expect(res.payload).not.toContain(SIG);
    }
  });
});

describe('redacted_thinking round trip in the converter', () => {
  const turn = (data: string, model = GPT): MessagesRequest => ({
    model,
    max_tokens: 1024,
    messages: [
      { role: 'user', content: 'list files' },
      {
        role: 'assistant',
        content: [
          { type: 'redacted_thinking', data },
          { type: 'tool_use', id: 'call_1', name: 'run', input: {} },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'a.txt' }] },
    ],
  });
  const reasoningOf = (req: MessagesRequest) => {
    const h = convertRequest(req).conversationState.history[1];
    return h.kind === 'assistant' ? h.assistantResponseMessage.reasoningContent : undefined;
  };

  it('restores the gateway envelope into reasoningText', () => {
    const data = encodeReasoningEnvelope({ reasoningText: { text: '...', signature: SIG } }, GPT);
    expect(reasoningOf(turn(data))).toEqual({ reasoningText: { text: '...', signature: SIG } });
  });

  it('drops an envelope issued for another model', () => {
    const data = encodeReasoningEnvelope({ reasoningText: { text: '...', signature: SIG } }, GPT);
    expect(reasoningOf(turn(data, 'claude-opus-5'))).toBeUndefined();
  });

  it('passes a foreign redacted_thinking through unchanged', () => {
    expect(reasoningOf(turn('anthropic-native-redacted-blob'))).toEqual({
      redactedContent: 'anthropic-native-redacted-blob',
    });
  });
});
