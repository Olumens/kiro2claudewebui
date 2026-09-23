/**
 * 上游请求按 kiro-cli V3(KAS)的形态发出:GAR 与 InvokeMCP 都 POST 到 runtime host 根路径、
 * `KiroRuntimeService.*` target、KAS 的 UA 与静态头;不带 KAS 不发的 accept / accept-encoding。
 * 真相源 `kiro/provider.ts` 的 header builders 与 `kiro/client-profile.ts` 的 kas 身份。
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import axios from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { KiroProvider } from '../../src/kiro/provider.js';
import type { SingleTokenManager } from '../../src/kiro/token-manager.js';

const ARN = 'arn:aws:codewhisperer:us-east-1:000000000000:profile/TEST';

function makeProvider() {
  const tokenManager = {
    config: () => ({ region: 'us-east-1', upstreamMaxSockets: 4 }),
    acquireContext: async () => ({
      credentials: { accessToken: 'tok', region: 'us-east-1', profileArn: ARN },
      token: 'tok',
    }),
    forceRefreshToken: async () => 'tok',
  } as unknown as SingleTokenManager;
  const provider = new KiroProvider(tokenManager);
  const sent: Array<{ url: string; body: string; headers: Record<string, string | false> }> = [];
  const client = (provider as unknown as { client: { post: unknown } }).client;
  client.post = vi.fn(
    async (url: string, body: string, cfg: { headers: Record<string, string> }) => {
      sent.push({ url, body, headers: { ...cfg.headers } });
      return { status: 200, headers: {}, data: Buffer.from('') };
    },
  );
  return { provider, sent };
}

describe('upstream wire follows kiro-cli V3 (KAS)', () => {
  it('GenerateAssistantResponse: root path, KAS target / UA / headers, profileArn in body', async () => {
    const { provider, sent } = makeProvider();
    await provider.callApi(JSON.stringify({ conversationState: {} }));
    const [req] = sent;
    expect(req.url).toBe('https://runtime.us-east-1.kiro.dev/');
    expect(req.headers['x-amz-target']).toBe('KiroRuntimeService.GenerateAssistantResponse');
    expect(req.headers['user-agent']).toMatch(/^aws-sdk-js\/.* api\/kiroruntime#/);
    expect(req.headers['x-amzn-kiro-client-attribution']).toBe('unrecognized');
    expect(req.headers['x-amzn-codewhisperer-optout']).toBe('true');
    expect(req.headers.connection).toBe('keep-alive');
    expect(req.headers.accept).toBe(false);
    expect(req.headers['accept-encoding']).toBe(false);
    expect(req.headers['x-kiro-attempt']).toBe('1;max=3');
    expect(JSON.parse(req.body).profileArn).toBe(ARN);
  });

  it('InvokeMCP: root path, no attribution / profile-arn header / x-kiro-attempt, profileArn in body', async () => {
    const { provider, sent } = makeProvider();
    await provider.callMcp(JSON.stringify({ id: 'x', jsonrpc: '2.0', method: 'tools/call' }));
    const [req] = sent;
    expect(req.url).toBe('https://runtime.us-east-1.kiro.dev/');
    expect(req.headers['x-amz-target']).toBe('KiroRuntimeService.InvokeMCP');
    expect(req.headers).not.toHaveProperty('x-amzn-kiro-client-attribution');
    expect(req.headers).not.toHaveProperty('x-amzn-kiro-profile-arn');
    expect(req.headers).not.toHaveProperty('x-kiro-attempt');
    expect(req.headers['amz-sdk-request']).toBe('attempt=1; max=3');
    expect(JSON.parse(req.body).profileArn).toBe(ARN);
  });

  it('a false header value keeps axios from sending its default accept / accept-encoding', async () => {
    let seen: http.IncomingHttpHeaders = {};
    const server = http.createServer((req, res) => {
      seen = req.headers;
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      await axios.post(`http://127.0.0.1:${port}/`, '{}', {
        headers: { accept: false, 'accept-encoding': false, 'content-type': 'application/json' },
      } as never);
      expect(seen).not.toHaveProperty('accept');
      expect(seen).not.toHaveProperty('accept-encoding');
    } finally {
      server.close();
    }
  });
});
