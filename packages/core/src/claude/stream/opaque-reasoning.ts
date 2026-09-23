/**
 * GPT 推理帧的累积器:流式 `StreamContext` 与非流式 `reduceKiroResponse` 共用,两边必须同源。
 *
 * V3 target 下 GPT 的 `reasoningContentEvent` 是 `{text:"...", signature}`——文本只是占位,真正
 * 的推理在 signature 的密文里;KAS 把它原样放回 history 的 `reasoningContent.reasoningText`。
 * 所以对 GPT:**绝不**把这段文本当 thinking 展示,但要完整保留(原文 + 签名)供下一轮回传。
 * `{redactedContent}`(V2 下 GPT 的形态)也收下,上游回退到该形态时不至于丢。
 *
 * 一条 Kiro 消息只有一个推理槽位:文本累积到带签名的那一帧为止,多段取最后一段(同 KAS)。
 */

import type { ReasoningContent } from '../../kiro/model/requests/conversation.js';
import { mapModel } from '../converter.js';
import { encodeReasoningEnvelope } from '../reasoning-envelope.js';

export class OpaqueReasoningAccumulator {
  private pendingText = '';
  private latest: ReasoningContent | undefined;

  push(event: { text: string; signature: string | undefined; redactedContent?: string }): void {
    if (event.redactedContent) {
      this.latest = { redactedContent: event.redactedContent };
      this.pendingText = '';
      return;
    }
    this.pendingText += event.text;
    if (event.signature) {
      this.latest = { reasoningText: { text: this.pendingText, signature: event.signature } };
      this.pendingText = '';
    }
  }

  get result(): ReasoningContent | undefined {
    return this.latest;
  }
}

/**
 * Messages 下发 GPT 推理的 `redacted_thinking` 块(data = 网关信封,按上游 modelId 绑定):流式
 * `StreamContext.generateFinalEvents` 与非流式 handler 共用。客户端原样带回后由 converter 还原成
 * history 的 reasoningContent(同 KAS 每轮回传)。
 */
export function redactedThinkingBlock(
  reasoning: ReasoningContent,
  clientModel: string,
): { type: 'redacted_thinking'; data: string } | undefined {
  const modelId = mapModel(clientModel);
  if (modelId === undefined) return undefined;
  return { type: 'redacted_thinking', data: encodeReasoningEnvelope(reasoning, modelId) };
}
