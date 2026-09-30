import type { FastifyInstance } from 'fastify';
import { buildWebUiHtml } from '../webui/page.js';

/**
 * Built-in browser chat UI (MVP).
 *
 * 页面本身不鉴权;真正发请求走 `/api/claude/v1/*`，仍由既有 API key 鉴权。
 */
export async function registerWebUiRoutes(app: FastifyInstance): Promise<void> {
  app.get('/webui', async (_request, reply) => {
    reply.type('text/html; charset=utf-8').send(buildWebUiHtml());
  });

  app.get('/webui/', async (_request, reply) => {
    reply.redirect('/webui');
  });
}
