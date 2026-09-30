import type { AxiosResponse } from 'axios';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { KiroProvider } from '../../src/kiro/provider.js';
import { HookBus } from '../../src/plugin-host/index.js';
import { registerClaudeRoutes } from '../../src/routes/claude.js';
import { registerWebUiRoutes } from '../../src/routes/webui.js';
import { getRequestContext, requestContextStorage } from '../../src/shared/request-context.js';
import { framesWithMetering } from '../helpers/event-stream.js';

const API_KEY = 'webui-test-key';

async function* bufferStream(buffers: Buffer[]): AsyncIterable<Buffer> {
  for (const buf of buffers) yield buf;
}

function streamResponse(body: AsyncIterable<Buffer>): AxiosResponse {
  return {
    data: body as unknown as AxiosResponse['data'],
    status: 200,
    statusText: 'OK',
    headers: {},
    config: {} as AxiosResponse['config'],
  };
}

function bufferResponse(body: Buffer): AxiosResponse {
  return {
    data: body as unknown as AxiosResponse['data'],
    status: 200,
    statusText: 'OK',
    headers: {},
    config: {} as AxiosResponse['config'],
  };
}

function makeProvider(frames: Buffer[]): KiroProvider {
  return {
    callApi: async () => bufferResponse(Buffer.concat(frames)),
    callApiStream: async () => streamResponse(bufferStream(frames)),
    callMcp: async () => streamResponse(bufferStream(frames)),
  } as unknown as KiroProvider;
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const hookBus = new HookBus();

  app.addHook('onRequest', (request, _reply, done) => {
    const reqId = (request.headers['x-request-id'] as string) || 'test-req';
    requestContextStorage.run({ reqId, startTime: Date.now() }, done);
  });

  await app.register(registerWebUiRoutes);

  const deps = {
    apiKey: API_KEY,
    kiroProvider: makeProvider(
      framesWithMetering({ unit: 'credit', unitPlural: 'credits', usage: 0.001 }, 'pong'),
    ),
    extractThinking: false,
    identityOverride: false,
    rejectUnsupportedDocuments: false,
    emptyStreamRetries: 0,
    toolCallTextRescue: false,
    hookBus,
  };

  await app.register(
    async (instance) => {
      instance.addHook('preHandler', (_request, _reply, done) => {
        const ctx = getRequestContext();
        if (ctx) ctx.stripPluginUsage = true;
        done();
      });
      await registerClaudeRoutes(instance, deps);
    },
    { prefix: '/api/claude/v1' },
  );

  await app.ready();
  return app;
}

describe('webui route + auth behavior', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('GET /webui loads without API key', async () => {
    app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/webui' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.payload).toContain('kiro2claude Web UI (MVP)');
    expect(response.payload).toContain('/api/claude/v1/messages');
  });

  it('POST /api/claude/v1/messages requires API key (webui send path)', async () => {
    app = await buildApp();
    const body = {
      model: 'claude-opus-5',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'ping' }],
    };

    const missingKey = await app.inject({
      method: 'POST',
      url: '/api/claude/v1/messages',
      headers: { 'content-type': 'application/json' },
      payload: body,
    });
    expect(missingKey.statusCode).toBe(401);

    const withKey = await app.inject({
      method: 'POST',
      url: '/api/claude/v1/messages',
      headers: {
        'content-type': 'application/json',
        'x-api-key': API_KEY,
      },
      payload: body,
    });
    expect(withKey.statusCode).toBe(200);
  });
});
