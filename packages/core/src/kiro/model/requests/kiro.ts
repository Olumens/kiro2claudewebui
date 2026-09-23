import type { ConversationState, EffortLevel, UserMessage } from './conversation.js';

/**
 * 请求顶层的模型附加参数,effort 唯一生效的位置(kiro-cli KAS 也发在这里)。形状逐模型由上游
 * `ListAvailableModels` 的 `additionalModelRequestFieldsSchema` 给出:Claude 原生模型
 * `{thinking:{type, display?}, output_config:{effort}, max_tokens}`(4.6 系无 xhigh),GPT
 * `{reasoning:{effort}}`(含 none),其它模型无 schema、不发。`max_tokens` 故意不发:传了会让
 * 小 max_tokens 的客户端在思考阶段被截断。
 */
export interface AdditionalModelRequestFields {
  thinking?: { type: 'adaptive' | 'disabled'; display?: 'summarized' | 'omitted' };
  output_config?: { effort: EffortLevel };
  reasoning?: { effort: EffortLevel | 'none' };
}

/** Kiro API 请求 */
export interface KiroRequest {
  conversationState: ConversationState;
  profileArn?: string;
  /** KAS 顶层字段:主会话 `vibe`,subagent 会话为子 agent 的模式 */
  agentMode?: string;
  additionalModelRequestFields?: AdditionalModelRequestFields;
}

/**
 * 剥掉序列化请求体里 history 的全部 `assistantResponseMessage.reasoningContent`;一个都没有时
 * 返回 undefined(重发无意义)。供 `RetryExecutor` 在上游 400 `THINKING_SIGNATURE_INVALID`
 * (签名与当前模型/上下文不匹配,典型是中途换模型)时重发一次,与 kiro-cli KAS 同策。在字符串上
 * 做,因为 executor 只持有 body 字符串。
 */
export function stripReasoningContent(serialized: string): string | undefined {
  let json: { conversationState?: { history?: unknown } };
  try {
    json = JSON.parse(serialized);
  } catch {
    return undefined;
  }
  const history = json.conversationState?.history;
  if (!Array.isArray(history)) return undefined;
  let removed = 0;
  for (const entry of history) {
    const assistant = (entry as { assistantResponseMessage?: Record<string, unknown> })
      ?.assistantResponseMessage;
    if (assistant && 'reasoningContent' in assistant) {
      // JSON.stringify 会丢掉 undefined 值,效果等同删除,且不触发 biome noDelete。
      assistant.reasoningContent = undefined;
      removed += 1;
    }
  }
  return removed > 0 ? JSON.stringify(json) : undefined;
}

/**
 * 序列化 KiroRequest 为 Kiro API 期望的 wire format。
 *
 * ⚠️ 为什么不能直接 `JSON.stringify(req)`:
 *
 * `ConversationState.history` 里的 `Message` 是 TS 侧的 discriminated union
 * （`{ kind: 'user' | 'assistant', ... }`）。Kiro API 的线上格式是**未加标签的
 * 联合**（untagged union）—— variant 的字段直接平铺到 JSON，没有 discriminator。
 * 但 `JSON.stringify` 会天真地把 `kind` 字段也写出去，导致线上报文长这样：
 *   `{"kind":"user","userInputMessage":{...}}`
 * 而 Kiro API 期望的是：
 *   `{"userInputMessage":{...}}`
 *
 * 当前 Kiro API 对多出来的 `kind` 字段是容忍的（因此单轮对话的冒烟测试能通），
 * 但这仍然是**协议偏离**：AWS Smithy 后端对未知字段的处理策略并不保证稳定，
 * 并且任何基于字段签名的缓存/校验都会被这个"噪声字段"破坏。
 *
 * 另一个 wire 细节：Kiro 后端对空 `history` 数组的处理不稳定 —— 有时会拒绝
 * 带 `"history": []` 同时又带 `currentMessage` 的请求。所以空数组要从 wire
 * 输出里完全去掉，而不是保留一个空的 `"history": []`。
 *
 * 其余空集合同 KAS 一样不上 wire:空 `images` / `toolResults` 省略;`userInputMessageContext`
 * 里全是空集合时整个省略(KAS 没有工具结果的历史消息就不带 context)。
 *
 * ★ 以上规则只作用于 wire 结构节点(conversationState / 各条消息 / userInputMessage / context)。
 * 工具参数(`toolUses[].input`)、工具结果、工具 schema 是不透明载荷,里面的 `kind` / `images: []`
 * 是模型或工具的原话,改了就篡改了历史。
 */
export function serializeKiroRequest(req: KiroRequest): string {
  const structural = collectStructuralNodes(req.conversationState);
  return JSON.stringify(req, function (this: unknown, key: string, value: unknown) {
    if (!structural.has(this as object)) return value;
    // 剥离 Message union 上的 discriminator tag
    if (key === 'kind') return undefined;
    if (
      (key === 'history' || key === 'images' || key === 'toolResults') &&
      Array.isArray(value) &&
      value.length === 0
    ) {
      return undefined;
    }
    if (key === 'userInputMessageContext' && isAllEmpty(value)) return undefined;
    return value;
  });
}

function collectStructuralNodes(state: ConversationState): WeakSet<object> {
  const nodes = new WeakSet<object>([state]);
  const addUser = (m: UserMessage) => {
    nodes.add(m);
    if (m.userInputMessageContext) nodes.add(m.userInputMessageContext);
  };
  addUser(state.currentMessage.userInputMessage);
  for (const entry of state.history) {
    nodes.add(entry);
    if (entry.kind === 'user') addUser(entry.userInputMessage);
  }
  return nodes;
}

function isAllEmpty(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).every((v) => v === undefined || (Array.isArray(v) && v.length === 0));
}
