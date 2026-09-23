/**
 * 客户端会话 → kiro-cli V3(KAS)会话身份(2.23.1 抓包):conversationId 一个会话一个(`sess_`);
 * agentContinuationId 一个用户轮次一个、轮内工具往返不变;subagent 是独立会话,
 * rootConversationId 指向父会话、agentMode 换成子 agent 的;不知道会话时每请求随机。
 */

import type { AxiosResponse } from 'axios';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { type ClientSession, convertRequest } from '../../src/claude/converter.js';
import type { MessagesRequest } from '../../src/claude/types.js';
import { deriveConversationId } from '../../src/kiro/model/requests/conversation.js';
import type { KiroProvider } from '../../src/kiro/provider.js';
import { HookBus } from '../../src/plugin-host/index.js';
import { registerClaudeRoutes } from '../../src/routes/claude.js';
import { buildAssistantResponseFrame, completedFrames } from '../helpers/event-stream.js';

const SESSION_UUID = '0199a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b';

function identity(
  messages: MessagesRequest['messages'],
  opts: { session?: ClientSession; userId?: string; agentId?: string } = {},
) {
  const result = convertRequest(
    {
      model: 'claude-opus-5',
      max_tokens: 1024,
      messages,
      ...(opts.userId ? { metadata: { user_id: opts.userId } } : {}),
    },
    { session: opts.session, claudeCodeAgentId: opts.agentId },
  );
  const state = result.conversationState;
  return {
    conversationId: state.conversationId,
    rootConversationId: state.rootConversationId,
    acid: state.agentContinuationId,
    agentMode: result.agentMode,
  };
}

const turn1 = [{ role: 'user', content: 'build it' }];
const loop1 = [
  ...turn1,
  { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'run', input: {} }] },
  {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
      // Claude Code 常把 system-reminder 夹在 tool_result 同一条里:不是新轮次
      { type: 'text', text: '<system-reminder>todo list changed</system-reminder>' },
    ],
  },
];
const turn2 = [
  ...loop1,
  { role: 'assistant', content: 'done' },
  { role: 'user', content: 'now add tests' },
];

describe('conversation identity', () => {
  const session: ClientSession = { key: 'thread-a' };

  it('keeps agentContinuationId within a user turn and mints a new one on the next user turn', () => {
    const a = identity(turn1, { session });
    const b = identity(loop1, { session });
    const c = identity(turn2, { session });
    expect(b.conversationId).toBe(a.conversationId);
    expect(c.conversationId).toBe(a.conversationId);
    expect(b.acid).toBe(a.acid);
    expect(c.acid).not.toBe(a.acid);
  });

  it('does not reuse an earlier turn id after context compaction drops the turn count', () => {
    const original = identity(turn2, { session });
    // 压缩后历史只剩摘要 + 新输入:序号回到 2,但这一轮的输入文本不同
    const compacted = identity(
      [
        { role: 'user', content: 'Summary of the conversation so far: ...' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'continue with the docs' },
      ],
      { session },
    );
    expect(compacted.conversationId).toBe(original.conversationId);
    expect(compacted.acid).not.toBe(original.acid);
  });

  it('counts a run of consecutive user messages as one turn', () => {
    const leadIn = [
      { role: 'user', content: '# AGENTS.md instructions' },
      { role: 'user', content: '<environment_context>…</environment_context>' },
      { role: 'user', content: 'build it' },
    ];
    expect(identity(leadIn, { session }).acid).toBe(identity(turn1, { session }).acid);
  });

  it('maps subagent sessions like KAS: own id and acid, root points at the parent, subagent agentMode', () => {
    const parent = identity(loop1, { session });
    const child = identity(loop1, {
      session: { key: 'thread-a\nthread:child', rootKey: 'thread-a' },
    });
    expect(parent.rootConversationId).toBe(parent.conversationId);
    expect(parent.agentMode).toBe('vibe');
    expect(child.conversationId).not.toBe(parent.conversationId);
    expect(child.rootConversationId).toBe(parent.conversationId);
    expect(child.agentMode).toBe('general-task-execution');
    expect(child.acid).toBeTypeOf('string');
    expect(child.acid).not.toBe(parent.acid);
  });

  it('applies the same per-turn rule to Claude Code sessions from metadata.user_id', () => {
    const userId = `user_x_account__session_${SESSION_UUID}`;
    const a = identity(turn1, { userId });
    const b = identity(loop1, { userId });
    // session 当会话键派生(与 OpenAI 的键同一条路径),客户端原始 session id 不上送
    expect(a.conversationId).toBe(deriveConversationId(SESSION_UUID));
    expect(b.acid).toBe(a.acid);
    expect(identity(turn2, { userId }).acid).not.toBe(a.acid);
  });

  it('maps Claude Code subagents (x-claude-code-agent-id) like KAS subagent sessions', () => {
    // Claude Code 2.1.280 实测:subagent 与主线程共用 metadata.user_id 的 session,只多带
    // x-claude-code-agent-id(同一 subagent 的多个请求值不变,主线程不带)
    const userId = `user_x_account__session_${SESSION_UUID}`;
    const main = identity(loop1, { userId });
    const sub = identity([{ role: 'user', content: 'Task: read notes.txt' }], {
      userId,
      agentId: 'a43736ab5265ef258',
    });
    const sibling = identity([{ role: 'user', content: 'Task: read notes.txt' }], {
      userId,
      agentId: 'b00000000000000001',
    });
    expect(main.rootConversationId).toBe(main.conversationId);
    expect(sub.conversationId).not.toBe(main.conversationId);
    expect(sub.rootConversationId).toBe(main.conversationId);
    expect(sub.agentMode).toBe('general-task-execution');
    expect(sibling.conversationId).not.toBe(sub.conversationId);
    expect(identity(loop1, { userId, agentId: 'a43736ab5265ef258' }).conversationId).toBe(
      sub.conversationId,
    );
  });

  it('stays random per request when no session is known', () => {
    const a = identity(loop1);
    const b = identity(loop1);
    expect(a.conversationId).not.toBe(b.conversationId);
    expect(a.acid).not.toBe(b.acid);
  });
});

describe('Messages route: x-claude-code-agent-id reaches the identity mapping', () => {
  it('sends a Claude Code subagent upstream as its own session rooted at the main thread', async () => {
    const bodies: Record<string, Record<string, unknown>>[] = [];
    const app = Fastify({ logger: false });
    await app.register(
      (instance) =>
        registerClaudeRoutes(instance, {
          apiKey: 'test-key',
          kiroProvider: {
            callApi: async (body: string) => {
              bodies.push(JSON.parse(body));
              return {
                data: Buffer.concat(completedFrames(buildAssistantResponseFrame('ok'))),
              } as AxiosResponse;
            },
          } as unknown as KiroProvider,
          extractThinking: true,
          identityOverride: false,
          emptyStreamRetries: 0,
          hookBus: new HookBus(),
        }),
      { prefix: '/claude/v1' },
    );
    try {
      const send = (agentId?: string) =>
        app.inject({
          method: 'POST',
          url: '/claude/v1/messages',
          headers: {
            'x-api-key': 'test-key',
            ...(agentId ? { 'x-claude-code-agent-id': agentId } : {}),
          },
          payload: {
            model: 'claude-opus-5',
            max_tokens: 64,
            metadata: { user_id: `user_x_account__session_${SESSION_UUID}` },
            messages: [{ role: 'user', content: 'hi' }],
          },
        });
      await send();
      await send('a43736ab5265ef258');
      const [main, sub] = bodies.map((b) => b.conversationState as Record<string, unknown>);
      expect(main.rootConversationId).toBe(main.conversationId);
      expect(sub.conversationId).not.toBe(main.conversationId);
      expect(sub.rootConversationId).toBe(main.conversationId);
      expect(bodies[1].agentMode).toBe('general-task-execution');
    } finally {
      await app.close();
    }
  });
});
