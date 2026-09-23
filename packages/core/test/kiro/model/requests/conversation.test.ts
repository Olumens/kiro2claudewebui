import { validate as isUuid, version as uuidVersion } from 'uuid';
import { describe, expect, it } from 'vitest';
import {
  attachToolUses,
  type ConversationState,
  createAssistantMessage,
  createConversationState,
  createUserInputMessage,
  createUserMessage,
  deriveConversationId,
  type Message,
  toKasSessionId,
} from '../../../../src/kiro/model/requests/conversation.js';
import {
  type KiroRequest,
  serializeKiroRequest,
} from '../../../../src/kiro/model/requests/kiro.js';

describe('ConversationState', () => {
  it('test_conversation_state_new', () => {
    const state = createConversationState('conv-123');
    state.agentTaskType = 'vibe';
    state.chatTriggerType = 'MANUAL';

    expect(state.conversationId).toBe('conv-123');
    expect(state.agentTaskType).toBe('vibe');
    expect(state.chatTriggerType).toBe('MANUAL');
  });

  it('returns a bare structural shell with no origin/envState', () => {
    // 工厂层只铺结构占位——origin 由 converter 从 client-profile 注入(单一写入点);
    // envState 是 V2 字段,KAS 不发。
    const msg = createUserInputMessage('Hello', 'claude-3-5-sonnet');

    expect(msg.content).toBe('Hello');
    expect(msg.modelId).toBe('claude-3-5-sonnet');
    expect(msg.origin).toBeUndefined();
    expect(msg.userInputMessageContext.envState).toBeUndefined();
  });

  // The Kiro wire format for conversation history is an **untagged union**:
  // each message is serialized directly as its variant payload, with no
  // discriminator field. Our internal `Message` type is a discriminated
  // union keyed by `kind`, so `serializeKiroRequest` must strip the `kind`
  // field before emitting JSON. Going through the real serializer here
  // (instead of hand-calling `serializeMessage`) is critical — otherwise
  // the test can silently pass while production code still leaks the tag.
  it('test_history_serialize', () => {
    const history: Message[] = [
      { kind: 'user', userInputMessage: createUserMessage('Hello', 'claude-3-5-sonnet') },
      {
        kind: 'assistant',
        assistantResponseMessage: createAssistantMessage('Hi! How can I help you?'),
      },
    ];

    const state = createConversationState('conv-123');
    state.history = history;
    const req: KiroRequest = { conversationState: state };
    const json = serializeKiroRequest(req);

    expect(json).toContain('userInputMessage');
    expect(json).toContain('assistantResponseMessage');
    // The untagged wire format must never emit the `kind` discriminator.
    expect(json).not.toContain('"kind"');
  });

  // Asserts the `ConversationState` wire format: `conversationId`,
  // `agentTaskType`, and `currentMessage` are all present with the
  // expected JSON shape. Additionally, an empty `history: []` MUST be
  // omitted from the wire output — the Kiro upstream rejects requests
  // that carry an empty history array alongside a `currentMessage`.
  it('test_conversation_state_serialize', () => {
    const state: ConversationState = createConversationState('conv-123');
    state.agentTaskType = 'vibe';
    state.currentMessage = {
      userInputMessage: {
        ...createUserInputMessage('Hello', 'claude-3-5-sonnet'),
      },
    };

    const req: KiroRequest = { conversationState: state };
    const json = serializeKiroRequest(req);

    expect(json).toContain('"conversationId":"conv-123"');
    expect(json).toContain('"agentTaskType":"vibe"');
    expect(json).toContain('"content":"Hello"');
    // Empty history must be stripped from the wire output entirely.
    expect(json).not.toContain('"history"');
  });
});

/**
 * `attachToolUses` 是 assistant 消息 toolUses 的唯一设置点:KAS 不给 assistant 消息发 V2 的
 * `messageId`,空数组不设字段。守卫在下面两条。
 */
describe('attachToolUses', () => {
  const TOOL_USE = { toolUseId: 'tooluse_1', name: 'Read', input: { file_path: '/a' } };

  it('只挂 toolUses:KAS 不给 assistant 消息发 V2 的 messageId', () => {
    const msg = createAssistantMessage('ok');
    attachToolUses(msg, [TOOL_USE]);

    expect(msg.toolUses).toEqual([TOOL_USE]);
    expect(JSON.stringify(msg)).not.toContain('messageId');
  });

  it('反向守卫：无 toolUses 时不设空 toolUses 数组', () => {
    const msg = createAssistantMessage('纯文本回复');
    attachToolUses(msg, []);

    expect(msg.toolUses).toBeUndefined();
    expect(JSON.stringify(msg)).not.toContain('toolUses');
  });
});

describe('deriveConversationId', () => {
  it('派生 KAS 形态的会话 id:同键恒定、异键不同,且不暴露原键', () => {
    const a = deriveConversationId('thread-a');
    expect(a).toMatch(/^sess_/);
    const uuid = a.slice('sess_'.length);
    expect(isUuid(uuid) && uuidVersion(uuid) === 4).toBe(true);
    expect(deriveConversationId('thread-a')).toBe(a);
    expect(deriveConversationId('thread-b')).not.toBe(a);
    expect(a).not.toContain('thread-a');
  });

  it('toKasSessionId 只补一次前缀', () => {
    expect(toKasSessionId('abc')).toBe('sess_abc');
    expect(toKasSessionId('sess_abc')).toBe('sess_abc');
  });
});
