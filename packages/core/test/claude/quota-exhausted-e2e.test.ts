/**
 * 全链路守卫:上游额度耗尽 → 下游 402 `billing_error`,四个端点(Messages 流式 / 非流式、
 * OpenAI Chat、Responses)一致。真实的 KiroProvider → RetryExecutor → classifyProviderError →
 * 路由,只把 axios 的 `post` 换成脚本化上游(同 `test/kiro/provider-v3-wire.test.ts`)。
 *
 * 上游形态出处:KAS SDK 的 KiroRuntimeService 错误 schema(ServiceQuotaExceededException = 402、
 * ThrottlingException = 429)+ KAS 自己把哪些 reason 当成「额度用完」;详见
 * docs/PITFALLS.md「额度耗尽」。
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KiroProvider } from '../../src/kiro/provider.js';
import type { SingleTokenManager } from '../../src/kiro/token-manager.js';
import { HookBus } from '../../src/plugin-host/index.js';
import { registerClaudeRoutes } from '../../src/routes/claude.js';
import { registerOpenAiRoutes } from '../../src/routes/openai.js';

const API_KEY = 'sk-test-quota';

function upstreamError(type: string, reason: string): string {
  return JSON.stringify({
    __type: `com.amazon.kiro.runtimeservice#${type}`,
    message: 'upstream prose that must not reach the client',
    reason,
  });
}

function makeProvider(status: number, body: string): KiroProvider {
  const tokenManager = {
    config: () => ({ region: 'us-east-1', upstreamMaxSockets: 4 }),
    acquireContext: async () => ({
      credentials: { accessToken: 'tok', region: 'us-east-1' },
      token: 'tok',
    }),
    forceRefreshToken: async () => 'tok',
  } as unknown as SingleTokenManager;
  const provider = new KiroProvider(tokenManager);
  const client = (provider as unknown as { client: { post: unknown } }).client;
  client.post = vi.fn(async () => ({ status, headers: {}, data: Buffer.from(body) }));
  return provider;
}

async function buildApp(provider: KiroProvider): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
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
  await app.register(async (i) => registerClaudeRoutes(i, deps), { prefix: '/claude/v1' });
  await app.register(async (i) => registerOpenAiRoutes(i, deps), { prefix: '/openai/v1' });
  await app.ready();
  return app;
}

const ENDPOINTS = [
  {
    name: 'Messages 非流式',
    url: '/claude/v1/messages',
    payload: {
      model: 'claude-opus-5',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
    },
  },
  {
    name: 'Messages 流式',
    url: '/claude/v1/messages',
    payload: {
      model: 'claude-opus-5',
      max_tokens: 64,
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    },
  },
  {
    name: 'OpenAI Chat',
    url: '/openai/v1/chat/completions',
    payload: { model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'hi' }] },
  },
  {
    name: 'Responses',
    url: '/openai/v1/responses',
    payload: { model: 'gpt-5.6-sol', input: 'hi' },
  },
] as const;

const QUOTA_SHAPES = [
  // 回归:曾落到 bad_request → 400「check your payload」
  [
    '402 overage 上限',
    402,
    upstreamError('ServiceQuotaExceededException', 'OVERAGE_REQUEST_LIMIT_EXCEEDED'),
  ],
  ['402 月额度', 402, upstreamError('ServiceQuotaExceededException', 'MONTHLY_REQUEST_COUNT')],
  // 回归:曾当成可重试的 429 限流转发
  ['429 月额度', 429, upstreamError('ThrottlingException', 'MONTHLY_REQUEST_COUNT')],
  ['429 日额度', 429, upstreamError('ThrottlingException', 'DAILY_REQUEST_COUNT')],
] as const;

describe('上游额度耗尽 → 下游 402 billing_error', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  for (const [shape, status, body] of QUOTA_SHAPES) {
    for (const ep of ENDPOINTS) {
      it(`${shape} × ${ep.name}`, async () => {
        app = await buildApp(makeProvider(status, body));
        const res = await app.inject({
          method: 'POST',
          url: ep.url,
          headers: { 'x-api-key': API_KEY, authorization: `Bearer ${API_KEY}` },
          payload: ep.payload,
        });
        expect(res.statusCode).toBe(402);
        const err = (res.json() as { error: { type: string; message: string } }).error;
        expect(err.type).toBe('billing_error');
        expect(err.message).toMatch(/quota/i);
        // 中性化:上游 reason / 异常名 / 文案都不上 wire
        expect(res.payload).not.toMatch(/kiro|aws|MONTHLY|OVERAGE|DAILY|Exception|upstream prose/i);
      });
    }
  }

  it('真正的 429 限流(容量 / 速率)照旧是可重试的 429', async () => {
    for (const reason of ['INSUFFICIENT_MODEL_CAPACITY', 'USER_REQUEST_RATE_EXCEEDED']) {
      app = await buildApp(makeProvider(429, upstreamError('ThrottlingException', reason)));
      const res = await app.inject({
        method: 'POST',
        url: ENDPOINTS[0].url,
        headers: { 'x-api-key': API_KEY },
        payload: ENDPOINTS[0].payload,
      });
      expect(res.statusCode, reason).toBe(429);
      expect((res.json() as { error: { type: string } }).error.type).toBe('rate_limit_error');
      await app.close();
      app = undefined;
    }
  });
});
