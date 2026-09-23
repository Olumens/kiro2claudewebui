import { createHash } from 'node:crypto';
import type { Tool, ToolResult, ToolUseEntry } from './tool.js';

/** 对话状态 */
export interface ConversationState {
  agentContinuationId?: string;
  agentTaskType?: string;
  chatTriggerType?: string;
  currentMessage: CurrentMessage;
  conversationId: string;
  /** KAS:主会话等于自己的 conversationId,subagent 会话指向父会话 */
  rootConversationId?: string;
  history: Message[];
}

export function createConversationState(conversationId: string): ConversationState {
  return {
    conversationId,
    currentMessage: { userInputMessage: defaultUserInputMessage() },
    history: [],
  };
}

/** 当前消息容器 */
export interface CurrentMessage {
  userInputMessage: UserInputMessage;
}

/** 用户输入消息 */
export interface UserInputMessage {
  userInputMessageContext: UserInputMessageContext;
  content: string;
  modelId: string;
  images: KiroImage[];
  origin?: string;
}

/**
 * Kiro 原生 reasoning effort 等级(与 kiro-cli `--effort` 取值一致)。生效位置是请求顶层
 * `additionalModelRequestFields`(见 `requests/kiro.ts`);`UserInputMessage` 上没有 reasoning
 * 字段,上游不认。
 */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

// 工厂只铺结构占位：`content`、`modelId`、`images`、空 `userInputMessageContext`。
// 语义字段 `origin` 由 converter 层从 client-profile 注入——converter 是 origin 的单一
// 写入点，避免工厂硬编码的默认值和 client-profile 漂移。
function defaultUserInputMessage(): UserInputMessage {
  return {
    userInputMessageContext: { toolResults: [], tools: [] },
    content: '',
    modelId: '',
    images: [],
  };
}

export function createUserInputMessage(content: string, modelId: string): UserInputMessage {
  return {
    ...defaultUserInputMessage(),
    content,
    modelId,
  };
}

/**
 * 用户输入消息上下文。空集合由 `serializeKiroRequest` 从 wire 上省略(同 KAS:没有工具结果的
 * 历史消息整个不带 context)。KAS 不发 `envState`。
 */
export interface UserInputMessageContext {
  toolResults: ToolResult[];
  tools: Tool[];
}

/** Kiro 图片 */
export interface KiroImage {
  format: string;
  source: KiroImageSource;
}

export interface KiroImageSource {
  bytes: string;
}

export function createKiroImage(format: string, base64Data: string): KiroImage {
  return { format, source: { bytes: base64Data } };
}

/** 历史消息（discriminated union） */
export type Message =
  | { kind: 'user'; userInputMessage: UserMessage }
  | { kind: 'assistant'; assistantResponseMessage: AssistantMessage };

/** 用户消息（历史记录中使用） */
export interface UserMessage {
  content: string;
  modelId: string;
  origin?: string;
  images: KiroImage[];
  userInputMessageContext: UserInputMessageContext;
}

export function createUserMessage(content: string, modelId: string): UserMessage {
  return {
    content,
    modelId,
    images: [],
    userInputMessageContext: { toolResults: [], tools: [] },
  };
}

/**
 * history 里 assistant 上一轮推理的 wire 形态,与 Anthropic 的 `thinking` / `redacted_thinking`
 * 块一一对应:Claude `{reasoningText:{text, signature}}`——signature 必填且须有效,否则上游
 * 400 `THINKING_SIGNATURE_INVALID`;GPT 也是 `{reasoningText}`(文本为占位 `...`),
 * `{redactedContent}`(V2 下 GPT 的形态)上游也收。不拼成 `<thinking>` 文本混进
 * `content`。签名失效由 `RetryExecutor` 剥掉重发一次(`stripReasoningContent`)。
 */
export type ReasoningContent =
  | { reasoningText: { text: string; signature: string } }
  | { redactedContent: string };

/** 助手消息（历史记录中使用） */
export interface AssistantMessage {
  content: string;
  toolUses?: ToolUseEntry[];
  /** 上一轮推理的原生回传,形态与红线见 {@link ReasoningContent}。 */
  reasoningContent?: ReasoningContent;
}

export function createAssistantMessage(content: string): AssistantMessage {
  return { content };
}

/**
 * 从客户端的会话键确定性派生 `conversationId`(键从哪来见 `resolveConversationIdentity`;Codex 子线程
 * 另有自己的键,见 `responsesSession`)。
 *
 * ★ 为什么不能每请求 `uuidv4()`:上游的缓存折扣按 conversationId 给。2026-09 用 Codex
 * 实测同一任务:随机 id 每轮都按冷价计(约 0.08 credit/1K input),稳定 id 从第二轮起降到
 * 约 1/5,整段会话省约 70%。kiro-cli 整个会话都用同一个 id(V3 形如 `sess_<uuid>`)。
 *
 * 会话隔离靠键本身:不同会话的键不同 → id 不同;同一个键 = 客户端声明的同一段对话。
 * 上游不按 conversationId 存历史(每次都整段重发),撞键只影响缓存命中,不会串内容。
 * 证据与复跑入口见 PITFALLS「会话身份映射到 kiro-cli」。
 */
export function deriveConversationId(sessionKey: string): string {
  return toKasSessionId(deriveSubConversationId(sessionKey));
}

/**
 * 子会话(subagent)的 conversationId:KAS 只给顶层会话加 `sess_` 前缀,`invoke_sub_agent` 的子会话
 * 是裸 UUID,`rootConversationId` 仍指向带前缀的父会话(2.23.1 抓包)。
 */
export function deriveSubConversationId(sessionKey: string): string {
  return deriveUuidV4Shape('conversationId', sessionKey);
}

/** KAS 的会话 id 形如 `sess_<uuid>`;已是这个形态的原样返回。 */
export function toKasSessionId(uuid: string): string {
  return uuid.startsWith('sess_') ? uuid : `sess_${uuid}`;
}

/**
 * kiro-cli 的 `agentContinuationId` 是「一个用户轮次一个」:同一轮里的工具往返不变,
 * 下一条用户输入(同进程或 `--resume`)换新(2.23.1 V2 / V3 抓包一致)。按「会话 + 轮次键」派生
 * (键的构成见 converter 的 `userTurnKey`),同一轮的每个请求都得到同一个值。subagent 会话按自己的
 * conversationId 派生,轮次各算各的。
 */
export function deriveAgentContinuationId(conversationId: string, userTurnKey: string): string {
  return deriveUuidV4Shape('agentContinuationId', `${conversationId}#${userTurnKey}`);
}

/** 按「用途 + 种子」派生 UUID v4 形状的值;用途前缀让不同字段的派生值互不相撞。 */
function deriveUuidV4Shape(purpose: string, seed: string): string {
  const bytes = createHash('sha256').update(`kiro2claude:${purpose}:${seed}`).digest();
  const b = Buffer.from(bytes.subarray(0, 16));
  // RFC 4122：version 4 + variant 10xx，让派生值与真 uuidv4 在形状上不可区分
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * 挂载 toolUses。`converter.ts` 有两处构造 assistant 历史消息(单条与合并多条),共用这一个
 * 设置点。KAS 不给 assistant 消息发 `messageId`。
 *
 * 空数组是 no-op:Kiro 对 `toolUses: []` 与不发该字段都收,保持不发。
 */
export function attachToolUses(msg: AssistantMessage, toolUses: ToolUseEntry[]): void {
  if (toolUses.length === 0) return;
  msg.toolUses = toolUses;
}

/**
 * 序列化 Message 为 Kiro API 格式
 * 注意: Kiro API 使用 untagged union，所以不包含 kind 字段
 */
export function serializeMessage(msg: Message): Record<string, unknown> {
  if (msg.kind === 'user') {
    return { userInputMessage: msg.userInputMessage };
  }
  return { assistantResponseMessage: msg.assistantResponseMessage };
}

/** 反序列化 Kiro API 格式到 Message */
export function deserializeMessage(obj: Record<string, unknown>): Message {
  if ('userInputMessage' in obj) {
    return { kind: 'user', userInputMessage: obj.userInputMessage as UserMessage };
  }
  return {
    kind: 'assistant',
    assistantResponseMessage: obj.assistantResponseMessage as AssistantMessage,
  };
}
