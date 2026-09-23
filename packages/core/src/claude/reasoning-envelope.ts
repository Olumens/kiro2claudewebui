/**
 * 推理往返信封:Kiro `reasoningContent` ⇄ 客户端可原样带回的不透明字符串(Responses 的
 * `reasoning.encrypted_content`、Messages 的 `redacted_thinking.data`)。
 *
 * kiro-cli 每轮都把上一轮推理原样放回 history 的 `assistantResponseMessage.reasoningContent`
 * (V3 下 GPT 与 Claude 都是 `{reasoningText:{text,signature}}`;V2 下 GPT 的 `{redactedContent}` 也认)。
 * 客户端协议里能原样带回不透明数据的通道:Responses 的 reasoning item `encrypted_content`
 * (声明 `include:["reasoning.encrypted_content"]` 时)与 Messages 的 `redacted_thinking.data`
 * (GPT 的推理只走这里,见 stream.ts `opaqueReasoning`)。网关把 Kiro 形态装进信封下发,
 * 回程拆开还原。
 *
 * ★ 会话隔离:网关不保存任何推理状态,信封只存在于客户端自己的历史里,跨会话无从串起。
 * ★ 模型绑定:信封记下签发它的上游 modelId,会话中途换模型时旧推理不回传——签名 / 密文
 *   按模型签发,发给别的模型只会换来 400 或一次剥离重试。
 * ★ 认不出的一律丢弃:真 OpenAI 的密文、被改坏的信封都不当推理上送。
 */

import type { ReasoningContent } from '../kiro/model/requests/conversation.js';

/**
 * 格式:`k2c.r2.` + JSON `{m, r}`。不再套 base64——`r` 里的签名 / 密文本身就是 base64,再编一层
 * 只会让客户端每轮多回传约 1/3 字节。`k2c.` 开头但版本不认得的算 malformed(丢弃),绝不当外来的
 * redacted 数据原样上送。
 */
const FAMILY = 'k2c.';
const PREFIX = 'k2c.r2.';

interface Envelope {
  m: string;
  r: ReasoningContent;
}

export type ReasoningEnvelopeResult =
  | { ok: true; reasoning: ReasoningContent }
  | { ok: false; reason: 'foreign' | 'malformed' | 'model_mismatch' };

export function encodeReasoningEnvelope(reasoning: ReasoningContent, modelId: string): string {
  const envelope: Envelope = { m: modelId, r: reasoning };
  return PREFIX + JSON.stringify(envelope);
}

export function decodeReasoningEnvelope(
  value: unknown,
  modelId: string | undefined,
): ReasoningEnvelopeResult {
  if (typeof value !== 'string' || !value.startsWith(FAMILY))
    return { ok: false, reason: 'foreign' };
  if (!value.startsWith(PREFIX)) return { ok: false, reason: 'malformed' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.slice(PREFIX.length));
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
