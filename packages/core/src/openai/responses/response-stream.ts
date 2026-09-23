/**
 * Responses API 流式事件编码器:Claude `SseEvent` → 严格的 Responses SSE 事件序列。
 *
 * Codex 对该序列**极其挑剔**(实测踩坑):
 *   - 文本必须 `output_item.added(message)` → `content_part.added` → `output_text.delta`
 *     → `output_text.done` → `content_part.done` → `output_item.done`;缺 content_part.added
 *     会导致 Codex 丢弃全部 delta(`OutputTextDelta without active item`)。
 *   - done 事件必须回填**累积的完整文本/参数**(不能空)。
 *   - `response.completed` 的 `response.output` 要带完整 items。
 *   - 工具调用走 `function_call_arguments.delta/done`。
 *
 * ★ **freeform(custom)工具**(踩坑「Codex code mode」):走**另一套**事件
 *   `custom_tool_call` item + `custom_tool_call_input.delta/done`(载荷字段是
 *   `input` 裸文本,不是 `arguments` JSON 串)。判别靠构造时传入的 `customToolNames`
 *   (请求侧收集,见 responses/converter.ts),名字对不上就会错编成 function_call。
 *   ⚠ 这类工具**不能边收边发**:上游给的是替身 schema `{"input":"…"}` 的 partial
 *   JSON,逐块转发等于把 JSON 碎片当裸文本喂给客户端。必须缓冲到 block 结束、解出
 *   `input` 再一次性发 delta+done(实测 Codex 接受单次 delta)。
 *
 * usage 用 StreamContext 原始 token(不经 buildClaudeUsagePayload,理由同 chat 端点)。
 * Claude 明文 thinking → reasoning summary item(惰性开:首个 thinking_delta 才产 item,见
 * reasoningDelta;summary 通道,兼容面最广)。
 *
 * ★ 推理往返(`reasoningModelId` 非空 = 客户端声明了 `include:["reasoning.encrypted_content"]`):
 *   Claude 的 signature 与 GPT 的 redactedContent 装进信封放在 `encrypted_content`,客户端下一轮
 *   原样带回,converter 还原成 history 的 `reasoningContent`(信封格式与隔离规则见
 *   reasoning-envelope.ts)。GPT 那一帧在 tool_use **之后**才到,所以它的 reasoning item 只能在
 *   `finalize` 里追加在已发 item 之后。未声明 include 时行为不变:签名丢弃、GPT 不产 item。
 */

import { v4 as uuidv4 } from 'uuid';
import type { SseEvent } from '../../claude/stream.js';
import { NO_FREEFORM_TOOLS, unwrapFreeformArgs } from '../freeform-tool.js';
import { encodeReasoningEnvelope } from './reasoning-envelope.js';
import { responsesIncompleteDetails } from './response-nonstream.js';
import type {
  ResponsesObject,
  ResponsesOutputItem,
  ResponsesReasoningOutputItemOut,
  ResponsesUsage,
} from './types.js';
import { NO_TOOL_NAMESPACES } from './types.js';

type MessageItem = {
  kind: 'message';
  claudeIdx: number;
  index: number;
  itemId: string;
  text: string;
};
type ReasoningItem = {
  kind: 'reasoning';
  claudeIdx: number;
  index: number;
  itemId: string;
  summaryText: string;
  /** 是否已发 summary_part.added;只有签名没有明文的 thinking 块不开 summary part。 */
  summaryOpen: boolean;
  signature: string | undefined;
};
type ToolCallItem = {
  kind: 'function_call';
  claudeIdx: number;
  index: number;
  itemId: string;
  args: string;
  callId: string;
  name: string;
};

type CurrentItem = MessageItem | ReasoningItem | ToolCallItem;

/** 关闭一个 item 产出的事件行 + 该 item 的最终形态(进 completedItems)。 */
interface ClosedItem {
  out: string[];
  item: ResponsesOutputItem;
}

export class ResponsesEventEncoder {
  private seq = 0;
  private readonly responseId = `resp_${uuidv4().replace(/-/g, '')}`;
  private readonly createdAt = Math.floor(Date.now() / 1000);
  private readonly model: string;
  private readonly customToolNames: ReadonlySet<string>;

  private createdEmitted = false;
  private outputIndex = 0;
  private current: CurrentItem | undefined;
  private readonly completedItems: ResponsesOutputItem[] = [];
  private stopReason = 'end_turn';

  private readonly toolNamespaces: ReadonlyMap<string, string>;
  /** 上游 modelId;非空才下发 `encrypted_content`(见文件头「推理往返」)。 */
  private readonly reasoningModelId: string | undefined;

  constructor(
    model: string,
    customToolNames: ReadonlySet<string> = NO_FREEFORM_TOOLS,
    toolNamespaces: ReadonlyMap<string, string> = NO_TOOL_NAMESPACES,
    reasoningModelId?: string,
  ) {
    this.model = model;
    this.customToolNames = customToolNames;
    this.toolNamespaces = toolNamespaces;
    this.reasoningModelId = reasoningModelId;
  }

  /**
   * 工具调用所属 namespace。客户端 router **按它分发**:`collaboration` 的六个 subagent
   * 工具少了这个字段就一律 `unsupported call`(理由见 converter.ts `expandNamespaces`)。
   * 默认 `functions` 命名空间的工具按裸名回调,不在表里 → 不写字段,保持原样。
   */
  private namespaceFields(name: string): { namespace?: string } {
    const namespace = this.toolNamespaces.get(name);
    return namespace ? { namespace } : {};
  }

  /** 把事件对象序列化成一行 SSE(带自增 sequence_number)。 */
  private line(obj: Record<string, unknown>): string {
    obj.sequence_number = this.seq++;
    return `data: ${JSON.stringify(obj)}\n\n`;
  }

  private responseObject(status: ResponsesObject['status']): ResponsesObject {
    return {
      id: this.responseId,
      object: 'response',
      created_at: this.createdAt,
      status,
      model: this.model,
      output: [...this.completedItems],
      usage: null,
      error: null,
      incomplete_details: null,
      metadata: {},
    };
  }

  /** 把一个 Claude SseEvent 翻成 0+ 个 Responses SSE 行。 */
  push(ev: SseEvent): string[] {
    switch (ev.event) {
      case 'message_start': {
        if (this.createdEmitted) return [];
        this.createdEmitted = true;
        return [
          this.line({ type: 'response.created', response: this.responseObject('in_progress') }),
          this.line({ type: 'response.in_progress', response: this.responseObject('in_progress') }),
        ];
      }

      case 'content_block_start': {
        const cb = ev.data.content_block as
          | { type?: string; id?: string; name?: string }
          | undefined;
        const idx = ev.data.index as number;
        // text block 惰性开:等首个 text_delta 才发 output_item.added(见 textDelta),
        // 避免「模型直接调工具、无前导文本」时产出空 message item(Codex 会误判成
        // 空的 last agent message)。tool_use 立即开 function_call item。
        if (cb?.type === 'tool_use') return this.openFunctionCall(idx, cb.id, cb.name ?? 'tool');
        // text / thinking block 均惰性开(等首个 delta):见 textDelta / reasoningDelta
        return [];
      }

      case 'content_block_delta': {
        const d = ev.data.delta as {
          type?: string;
          text?: string;
          partial_json?: string;
          thinking?: string;
          signature?: string;
        };
        if (d.type === 'text_delta' && typeof d.text === 'string') {
          return this.textDelta(d.text, ev.data.index as number);
        }
        if (d.type === 'thinking_delta' && typeof d.thinking === 'string') {
          return this.reasoningDelta(d.thinking, ev.data.index as number);
        }
        if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
          return this.argsDelta(d.partial_json);
        }
        if (d.type === 'signature_delta' && typeof d.signature === 'string') {
          return this.reasoningSignature(d.signature, ev.data.index as number);
        }
        return [];
      }

      case 'content_block_stop':
        return this.closeIfCurrent(ev.data.index as number);

      case 'message_delta': {
        const delta = ev.data.delta as { stop_reason?: string } | undefined;
        if (delta?.stop_reason) this.stopReason = delta.stop_reason;
        return [];
      }

      // message_stop / ping:completion 由 handler 调 finalize() 收口
      default:
        return [];
    }
  }

  private openMessage(claudeIdx: number): string[] {
    const out = this.closeCurrent();
    const itemId = `msg_${uuidv4().replace(/-/g, '')}`;
    const index = this.outputIndex;
    this.current = { kind: 'message', claudeIdx, index, itemId, text: '' };
    out.push(
      this.line({
        type: 'response.output_item.added',
        output_index: index,
        item: {
          id: itemId,
          type: 'message',
          role: 'assistant',
          status: 'in_progress',
          content: [],
        },
      }),
    );
    out.push(
      this.line({
        type: 'response.content_part.added',
        item_id: itemId,
        output_index: index,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      }),
    );
    return out;
  }

  private textDelta(text: string, claudeIdx: number): string[] {
    // 惰性开 message:首个 text_delta 到达才发 output_item.added + content_part.added,
    // 用该 delta 的 block index(content_block_stop 据此关闭)。
    const out: string[] = [];
    if (!this.current || this.current.kind !== 'message') {
      out.push(...this.openMessage(claudeIdx));
    }
    const cur = this.current as Extract<CurrentItem, { kind: 'message' }>;
    cur.text += text;
    out.push(
      this.line({
        type: 'response.output_text.delta',
        item_id: cur.itemId,
        output_index: cur.index,
        content_index: 0,
        delta: text,
      }),
    );
    return out;
  }

  /** 惰性开 reasoning item:发 output_item.added(reasoning);summary part 由 reasoningDelta 开。 */
  private openReasoning(claudeIdx: number): string[] {
    const out = this.closeCurrent();
    const itemId = `rs_${uuidv4().replace(/-/g, '')}`;
    const index = this.outputIndex;
    this.current = {
      kind: 'reasoning',
      claudeIdx,
      index,
      itemId,
      summaryText: '',
      summaryOpen: false,
      signature: undefined,
    };
    out.push(
      this.line({
        type: 'response.output_item.added',
        output_index: index,
        item: { id: itemId, type: 'reasoning', summary: [] },
      }),
    );
    return out;
  }

  private reasoningDelta(text: string, claudeIdx: number): string[] {
    // 惰性开 reasoning item:首个 thinking_delta 到达才发 output_item.added +
    // reasoning_summary_part.added,用该 delta 的 block index(content_block_stop 据此关闭)。
    const out: string[] = [];
    if (!this.current || this.current.kind !== 'reasoning') {
      out.push(...this.openReasoning(claudeIdx));
    }
    const cur = this.current as Extract<CurrentItem, { kind: 'reasoning' }>;
    if (!cur.summaryOpen) {
      cur.summaryOpen = true;
      out.push(
        this.line({
          type: 'response.reasoning_summary_part.added',
          item_id: cur.itemId,
          output_index: cur.index,
          summary_index: 0,
          part: { type: 'summary_text', text: '' },
        }),
      );
    }
    cur.summaryText += text;
    out.push(
      this.line({
        type: 'response.reasoning_summary_text.delta',
        item_id: cur.itemId,
        output_index: cur.index,
        summary_index: 0,
        delta: text,
      }),
    );
    return out;
  }

  /**
   * signature 只在往返开启时有用:记到对应的 reasoning item 上,关闭时装进信封。没有明文、
   * 只有签名的 thinking 块(display omitted)也要开一个空摘要的 item,否则签名无处安放。
   */
  private reasoningSignature(signature: string, claudeIdx: number): string[] {
    if (!this.reasoningModelId) return [];
    const out: string[] = [];
    if (this.current?.kind !== 'reasoning' || this.current.claudeIdx !== claudeIdx) {
      out.push(...this.openReasoning(claudeIdx));
    }
    (this.current as ReasoningItem).signature = signature;
    return out;
  }

  /** 该工具是否 freeform(走 custom_tool_call 事件族)。 */
  private isCustom(name: string): boolean {
    return this.customToolNames.has(name);
  }

  private openFunctionCall(claudeIdx: number, id: string | undefined, name: string): string[] {
    const out = this.closeCurrent();
    const custom = this.isCustom(name);
    const itemId = `${custom ? 'ctc' : 'fc'}_${uuidv4().replace(/-/g, '')}`;
    const callId = id ?? `call_${uuidv4().replace(/-/g, '')}`;
    const index = this.outputIndex;
    this.current = { kind: 'function_call', claudeIdx, index, itemId, args: '', callId, name };
    out.push(
      this.line({
        type: 'response.output_item.added',
        output_index: index,
        item: custom
          ? {
              id: itemId,
              type: 'custom_tool_call',
              call_id: callId,
              name,
              input: '',
              status: 'in_progress',
            }
          : {
              id: itemId,
              type: 'function_call',
              call_id: callId,
              name,
              ...this.namespaceFields(name),
              arguments: '',
              status: 'in_progress',
            },
      }),
    );
    return out;
  }

  private argsDelta(partial: string): string[] {
    if (!this.current || this.current.kind !== 'function_call') return [];
    this.current.args += partial;
    // freeform:只累积。此刻手里是 `{"input":"…"}` 的 JSON 碎片,发出去会被客户端
    // 当成工具原始文本(见文件头红线);完整文本在 closeCustomToolCall 一次性发。
    if (this.isCustom(this.current.name)) return [];
    return [
      this.line({
        type: 'response.function_call_arguments.delta',
        item_id: this.current.itemId,
        output_index: this.current.index,
        delta: partial,
      }),
    ];
  }

  private closeIfCurrent(claudeIdx: number): string[] {
    if (this.current && this.current.claudeIdx === claudeIdx) return this.closeCurrent();
    return [];
  }

  private closeMessage(cur: MessageItem): ClosedItem {
    const part = { type: 'output_text' as const, text: cur.text, annotations: [] };
    const out = [
      this.line({
        type: 'response.output_text.done',
        item_id: cur.itemId,
        output_index: cur.index,
        content_index: 0,
        text: cur.text,
      }),
      this.line({
        type: 'response.content_part.done',
        item_id: cur.itemId,
        output_index: cur.index,
        content_index: 0,
        part,
      }),
    ];
    return {
      out,
      item: {
        id: cur.itemId,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [part],
      },
    };
  }

  /** reasoning:summary_text.done → summary_part.done(回填完整摘要);有签名时附信封。 */
  private closeReasoning(cur: ReasoningItem): ClosedItem {
    const out = cur.summaryOpen
      ? [
          this.line({
            type: 'response.reasoning_summary_text.done',
            item_id: cur.itemId,
            output_index: cur.index,
            summary_index: 0,
            text: cur.summaryText,
          }),
          this.line({
            type: 'response.reasoning_summary_part.done',
            item_id: cur.itemId,
            output_index: cur.index,
            summary_index: 0,
            part: { type: 'summary_text', text: cur.summaryText },
          }),
        ]
      : [];
    const item: ResponsesReasoningOutputItemOut = {
      id: cur.itemId,
      type: 'reasoning',
      summary: cur.summaryOpen ? [{ type: 'summary_text', text: cur.summaryText }] : [],
    };
    if (this.reasoningModelId && cur.signature) {
      item.encrypted_content = encodeReasoningEnvelope(
        { reasoningText: { text: cur.summaryText, signature: cur.signature } },
        this.reasoningModelId,
      );
    }
    return { out, item };
  }

  /**
   * freeform:delta 在这里才发(累积期只缓冲,见 argsDelta)。载荷是解包后的裸文本,
   * 空输入给 ""——**不是** "{}",那是 JSON 工具的兜底,对裸文本工具是一段垃圾内容。
   */
  private closeCustomToolCall(cur: ToolCallItem): ClosedItem {
    const input = unwrapFreeformArgs(cur.args);
    const out = [
      this.line({
        type: 'response.custom_tool_call_input.delta',
        item_id: cur.itemId,
        output_index: cur.index,
        delta: input,
      }),
      this.line({
        type: 'response.custom_tool_call_input.done',
        item_id: cur.itemId,
        output_index: cur.index,
        input,
      }),
    ];
    return {
      out,
      item: {
        id: cur.itemId,
        type: 'custom_tool_call',
        call_id: cur.callId,
        name: cur.name,
        input,
        status: 'completed',
      },
    };
  }

  private closeFunctionCall(cur: ToolCallItem): ClosedItem {
    const out: string[] = [];
    // 空输入工具:上游无 input_json_delta → args 停在 ""(非法 JSON,Codex serde_json
    // 解析报错)。补 "{}" 使 arguments 合法,delta+done 两通道一致——与非流式
    // reduceKiroResponse 的 `if(!buffer) input={}` 归一对齐。
    if (cur.args.length === 0) {
      cur.args = '{}';
      out.push(
        this.line({
          type: 'response.function_call_arguments.delta',
          item_id: cur.itemId,
          output_index: cur.index,
          delta: '{}',
        }),
      );
    }
    out.push(
      this.line({
        type: 'response.function_call_arguments.done',
        item_id: cur.itemId,
        output_index: cur.index,
        arguments: cur.args,
      }),
    );
    return {
      out,
      item: {
        id: cur.itemId,
        type: 'function_call',
        call_id: cur.callId,
        name: cur.name,
        ...this.namespaceFields(cur.name),
        arguments: cur.args,
        status: 'completed',
      },
    };
  }

  /**
   * 关闭当前 open item(发 done 事件、回填完整文本/参数、进 completedItems)。幂等。
   * 各形态的收尾细节在 closeX;「output_item.done 与 completedItems 必须成对」这条不变量
   * **只在这里**出现一次,新增 item 形态别把它抄进 closeX。
   */
  private closeCurrent(): string[] {
    const cur = this.current;
    if (!cur) return [];
    this.current = undefined;
    this.outputIndex++;

    const { out, item } =
      cur.kind === 'message'
        ? this.closeMessage(cur)
        : cur.kind === 'reasoning'
          ? this.closeReasoning(cur)
          : this.isCustom(cur.name)
            ? this.closeCustomToolCall(cur)
            : this.closeFunctionCall(cur);

    out.push(this.line({ type: 'response.output_item.done', output_index: cur.index, item }));
    this.completedItems.push(item);
    return out;
  }

  /**
   * 收口:发 completed/incomplete,保留实际已接收的 output 与 usage。`redactedReasoning` 是
   * GPT 的加密推理,往返开启时在这里追加成独立 reasoning item(它晚于 tool_use 到达)。
   */
  finalize(usage: ResponsesUsage, redactedReasoning?: string): string[] {
    const out = this.closeCurrent();
    if (this.reasoningModelId && redactedReasoning) {
      const index = this.outputIndex++;
      const itemId = `rs_${uuidv4().replace(/-/g, '')}`;
      const item: ResponsesReasoningOutputItemOut = {
        id: itemId,
        type: 'reasoning',
        summary: [],
        encrypted_content: encodeReasoningEnvelope(
          { redactedContent: redactedReasoning },
          this.reasoningModelId,
        ),
      };
      out.push(
        this.line({
          type: 'response.output_item.added',
          output_index: index,
          item: { id: itemId, type: 'reasoning', summary: [] },
        }),
        this.line({ type: 'response.output_item.done', output_index: index, item }),
      );
      this.completedItems.push(item);
    }
    const incompleteDetails = responsesIncompleteDetails(this.stopReason);
    const resp = this.responseObject(incompleteDetails ? 'incomplete' : 'completed');
    resp.incomplete_details = incompleteDetails;
    resp.usage = usage;
    out.push(this.line({ type: `response.${resp.status}`, response: resp }));
    return out;
  }

  /** committed 后的 in-band 错误事件(Responses 流用 `type:"error"` 事件)。 */
  errorLine(message: string, type: string): string {
    return this.line({ type: 'error', code: type, message, param: null });
  }
}
