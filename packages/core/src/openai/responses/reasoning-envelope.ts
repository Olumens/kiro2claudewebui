/**
 * Responses `reasoning.encrypted_content` ⇄ Kiro `reasoningContent` 的往返信封。
 *
 * kiro-cli 每轮都把上一轮推理原样放回 history 的 `assistantResponseMessage.reasoningContent`
 * (GPT `{redactedContent}`、Claude `{reasoningText:{text,signature}}`)。Responses 协议里对应的
 * 通道只有 reasoning item 的 `encrypted_content`:客户端请求时带 `include:["reasoning.encrypted_content"]`,
 * 下一轮就把它原样放回 `input`。网关把 Kiro 形态装进信封下发,回程拆开还原。
 *
 * ★ 会话隔离:网关不保存任何推理状态,信封只存在于客户端自己的历史里,跨会话无从串起。
 * ★ 模型绑定:信封记下签发它的上游 modelId,会话中途换模型时旧推理不回传——签名 / 密文
 *   按模型签发,发给别的模型只会换来 400 或一次剥离重试。
 * ★ 认不出的一律丢弃:真 OpenAI 的密文、被改坏的信封都不当推理上送。
 */

import type { ReasoningContent } from '../../kiro/model/requests/conversation.js';

const PREFIX = 'k2c.r1.';

interface Envelope {
  m: string;
  r: ReasoningContent;
}

export type ReasoningEnvelopeResult =
  | { ok: true; reasoning: ReasoningContent }
  | { ok: false; reason: 'foreign' | 'malformed' | 'model_mismatch' };

export function encodeReasoningEnvelope(reasoning: ReasoningContent, modelId: string): string {
  const envelope: Envelope = { m: modelId, r: reasoning };
  return PREFIX + Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url');
}

export function decodeReasoningEnvelope(
  value: unknown,
  modelId: string | undefined,
): ReasoningEnvelopeResult {
  if (typeof value !== 'string' || !value.startsWith(PREFIX))
    return { ok: false, reason: 'foreign' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value.slice(PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'malformed' };
  const { m, r } = parsed as { m?: unknown; r?: unknown };
  const reasoning = asReasoningContent(r);
  if (typeof m !== 'string' || !reasoning) return { ok: false, reason: 'malformed' };
  if (m !== modelId) return { ok: false, reason: 'model_mismatch' };
  return { ok: true, reasoning };
}

/** 只放行与 `ReasoningContent` 两种形态逐字段一致的值,多余字段一律不带出去。 */
function asReasoningContent(value: unknown): ReasoningContent | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as { redactedContent?: unknown; reasoningText?: unknown };
  if (typeof v.redactedContent === 'string' && v.redactedContent.length > 0) {
    return { redactedContent: v.redactedContent };
  }
  const rt = v.reasoningText as { text?: unknown; signature?: unknown } | undefined;
  if (
    rt &&
    typeof rt === 'object' &&
    typeof rt.text === 'string' &&
    typeof rt.signature === 'string' &&
    rt.signature.length > 0
  ) {
    return { reasoningText: { text: rt.text, signature: rt.signature } };
  }
  return undefined;
}

/** 请求是否要求下发 `encrypted_content`(OpenAI 语义:不声明就不给)。 */
export function wantsEncryptedReasoning(include: unknown): boolean {
  return Array.isArray(include) && include.includes('reasoning.encrypted_content');
}
