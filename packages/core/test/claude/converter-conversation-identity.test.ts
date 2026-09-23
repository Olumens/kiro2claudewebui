/**
 * 客户端会话 → kiro-cli V2 会话身份(2.23.1 抓包):conversationId 一个会话一个;
 * agentContinuationId 一个用户轮次一个、轮内工具往返不变;subagent 会话不带 agentContinuationId;
 * 不知道会话时两者都每请求随机。
 */

import { describe, expect, it } from 'vitest';
import { type ClientSession, convertRequest } from '../../src/claude/converter.js';
import type { MessagesRequest } from '../../src/claude/types.js';

const SESSION_UUID = '0199a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b';

function identity(
  messages: MessagesRequest['messages'],
  opts: { session?: ClientSession; userId?: string } = {},
) {
  const state = convertRequest(
    {
      model: 'claude-opus-5',
      max_tokens: 1024,
      messages,
      ...(opts.userId ? { metadata: { user_id: opts.userId } } : {}),
    },
    { session: opts.session },
  ).conversationState;
  return { conversationId: state.conversationId, acid: state.agentContinuationId };
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
  const session: ClientSession = { key: 'thread-a', subagent: false };

  it('keeps agentContinuationId within a user turn and mints a new one on the next user turn', () => {
    const a = identity(turn1, { session });
    const b = identity(loop1, { session });
    const c = identity(turn2, { session });
    expect(b.conversationId).toBe(a.conversationId);
    expect(c.conversationId).toBe(a.conversationId);
    expect(b.acid).toBe(a.acid);
    expect(c.acid).not.toBe(a.acid);
  });

  it('counts a run of consecutive user messages as one turn', () => {
    const leadIn = [
      { role: 'user', content: '# AGENTS.md instructions' },
      { role: 'user', content: '<environment_context>…</environment_context>' },
      { role: 'user', content: 'build it' },
    ];
    expect(identity(leadIn, { session }).acid).toBe(identity(turn1, { session }).acid);
  });

  it('omits agentContinuationId for subagent sessions', () => {
    const child = identity(loop1, { session: { key: 'thread-a\nthread:child', subagent: true } });
    expect(child.acid).toBeUndefined();
    expect(child.conversationId).not.toBe(identity(loop1, { session }).conversationId);
  });

  it('applies the same per-turn rule to Claude Code sessions from metadata.user_id', () => {
    const userId = `user_x_account__session_${SESSION_UUID}`;
    const a = identity(turn1, { userId });
    const b = identity(loop1, { userId });
    expect(a.conversationId).toBe(SESSION_UUID);
    expect(b.acid).toBe(a.acid);
    expect(identity(turn2, { userId }).acid).not.toBe(a.acid);
  });

  it('stays random per request when no session is known', () => {
    const a = identity(loop1);
    const b = identity(loop1);
    expect(a.conversationId).not.toBe(b.conversationId);
    expect(a.acid).not.toBe(b.acid);
  });
});
