/**
 * Codex multi-agent 的 `<subagent_notification>` 与子会话 id(对齐 kiro-cli 2.23.1 抓包):
 *   - 子 agent 完成后 Codex 紧跟 `wait` 的工具输出插一条只含通知的 user 消息;kiro-cli 里子 agent 的
 *     结果是 `invoke_sub_agent` 的 tool result、父会话 acid 不变 → 通知不开新轮次,上送内容不变;
 *   - 这条 Codex 约定只在 Responses 适配层生效:Messages / Chat 里同样的文本照常算新轮次;
 *   - 子会话 conversationId 是裸 UUID(KAS 只给顶层会话加 `sess_`),root 指带前缀的父会话。
 */

import { describe, expect, it } from 'vitest';
import { type ClientSession, convertRequest } from '../../../src/claude/converter.js';
import type { MessagesRequest } from '../../../src/claude/types.js';
import { convertOpenAiRequest } from '../../../src/openai/converter.js';
import { convertResponsesRequest } from '../../../src/openai/responses/converter.js';
import { responsesSession } from '../../../src/openai/responses/handlers.js';
import type { ResponsesRequest } from '../../../src/openai/responses/types.js';

const MODEL = 'gpt-5.6-luna';
const KEY = '01a0ce3f-5100-7553-9d12-5181c4e48f95';
const NOTIFICATION =
  '<subagent_notification>\n{"agent_path":"01a0ce3f-651d","status":{"completed":"PONG"}}\n</subagent_notification>';

const userText = (text: string) => ({
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text }],
});
const spawn = [
  userText('Spawn a subagent that replies PONG.'),
  { type: 'function_call', call_id: 'c1', name: 'wait', arguments: '{}' },
  { type: 'function_call_output', call_id: 'c1', output: '{"completed":"PONG"}' },
];

function viaResponses(input: unknown[], session: ClientSession | undefined = { key: KEY }) {
  const { payload } = convertResponsesRequest({ model: MODEL, input } as ResponsesRequest);
  return convertRequest(payload, { session });
}

describe('Codex <subagent_notification> is a tool-loop continuation, not a new user turn', () => {
  it('keeps the parent acid of the turn and uploads the same content', () => {
    const before = viaResponses(spawn);
    const after = viaResponses([...spawn, userText(NOTIFICATION)]);
    expect(after.conversationState.agentContinuationId).toBe(
      before.conversationState.agentContinuationId,
    );
    const cur = after.conversationState.currentMessage.userInputMessage;
    expect(cur.content).toBe(NOTIFICATION);
    expect(cur.userInputMessageContext.toolResults).toHaveLength(1);
  });

  it('a notification with no tool output before it is left as it is', () => {
    const turn = [userText('hi'), { type: 'message', role: 'assistant', content: 'ok' }];
    const before = viaResponses(turn);
    const after = viaResponses([...turn, userText(NOTIFICATION)]);
    expect(after.conversationState.agentContinuationId).not.toBe(
      before.conversationState.agentContinuationId,
    );
  });

  it('only a message that is entirely the notification is folded', () => {
    const before = viaResponses(spawn);
    const after = viaResponses([...spawn, userText(`${NOTIFICATION}\nalso, add tests`)]);
    expect(after.conversationState.agentContinuationId).not.toBe(
      before.conversationState.agentContinuationId,
    );
  });
});

describe('the Codex convention does not leak into other endpoints', () => {
  const session: ClientSession = { key: KEY };
  const toolTurn: MessagesRequest['messages'] = [
    { role: 'user', content: 'Spawn a subagent that replies PONG.' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'wait', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'PONG' }] },
  ];

  it('Messages (Claude Code): the same text after a tool_result still starts a new turn', () => {
    const req = (messages: MessagesRequest['messages']): MessagesRequest => ({
      model: 'claude-opus-5',
      max_tokens: 64,
      messages,
    });
    const before = convertRequest(req(toolTurn), { session });
    const after = convertRequest(req([...toolTurn, { role: 'user', content: NOTIFICATION }]), {
      session,
    });
    expect(after.conversationState.agentContinuationId).not.toBe(
      before.conversationState.agentContinuationId,
    );
  });

  it('Chat Completions: the same text after a tool message still starts a new turn', () => {
    const chat = (extra: unknown[]) =>
      convertRequest(
        convertOpenAiRequest({
          model: MODEL,
          messages: [
            { role: 'user', content: 'Spawn a subagent that replies PONG.' },
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'c1', type: 'function', function: { name: 'wait', arguments: '{}' } },
              ],
            },
            { role: 'tool', tool_call_id: 'c1', content: 'PONG' },
            ...extra,
          ],
        } as never),
        { session },
      );
    expect(
      chat([{ role: 'user', content: NOTIFICATION }]).conversationState.agentContinuationId,
    ).not.toBe(chat([]).conversationState.agentContinuationId);
  });
});

describe('subagent conversationId is a bare UUID, like KAS invoke_sub_agent', () => {
  const BARE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it('Codex child thread', () => {
    const parent = viaResponses(spawn, responsesSession(KEY, KEY)).conversationState;
    const child = viaResponses(spawn, responsesSession(KEY, 'child-thread')).conversationState;
    expect(parent.conversationId).toMatch(/^sess_/);
    expect(child.conversationId).toMatch(BARE_UUID);
    expect(child.rootConversationId).toBe(parent.conversationId);
  });

  it('Claude Code subagent (x-claude-code-agent-id)', () => {
    const req: MessagesRequest = {
      model: 'claude-opus-5',
      max_tokens: 64,
      metadata: { user_id: `user_x_account__session_${'7f17a411-f624-48b9-86c6-55d1586e77a5'}` },
      messages: [{ role: 'user', content: 'Task: read notes.txt' }],
    };
    const main = convertRequest(req).conversationState;
    const sub = convertRequest(req, { claudeCodeAgentId: 'a54873b2b11dd5621' }).conversationState;
    expect(main.conversationId).toMatch(/^sess_/);
    expect(sub.conversationId).toMatch(BARE_UUID);
    expect(sub.rootConversationId).toBe(main.conversationId);
  });
});
