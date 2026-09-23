/** 工具定义 */
export interface Tool {
  toolSpecification: ToolSpecification;
}

/** 工具规范 */
export interface ToolSpecification {
  name: string;
  description: string;
  inputSchema: InputSchema;
}

/** 输入模式 (JSON Schema 包装) */
export interface InputSchema {
  json: Record<string, unknown>;
}

export function defaultInputSchema(): InputSchema {
  return {
    json: { type: 'object', properties: {} },
  };
}

/**
 * 工具执行结果。
 *
 * kiro-cli 实测形态(2.21.1 V2 探针 `test/manual/kiro-cli-probe.ts`;2.23.1 V3 抓包一致):
 * ```
 * 成功: { toolUseId, content:[{ text }] | [{ json:{…} }], status:"success" }
 * 失败: { toolUseId, content:[{ text }],                   status:"error"   }
 * ```
 * 同 KAS 只用 `status` 区分,不发 `isError`。2026-09 对照实验(content 保持中性 "done",
 * 只改 status / isError,问模型成败):luna 与 opus-5 各 4 种组合 × 3 次全部答 SUCCESS——
 * 两个字段都不作为失败信号到达模型,判定靠正文,所以不发 isError 不丢信息。
 *
 * 与 kiro-cli 已知且刻意保持的差异:
 *
 * 1. **`content[]` 上游支持 `{json}` 通道**（`execute_bash` 回
 *    `{json:{stdout,stderr,exit_status}}`），我们只产 `{text}`。可接受的降级：下游
 *    送来的 tool_result 本就是文本/blocks，结构化信息在进网关前已序列化过一次。
 * 2. **`content[]` 没有图片通道**：塞 Bedrock 风格的 `{image:{format,source:{bytes}}}`
 *    上游照样 200，但静默丢弃（2026-09-09 直连实测：模型说结果为空、输入 token 恰好
 *    少掉图片的量）。所以 tool_result 里的图只能提升到消息级 `images[]`，与 kiro-cli
 *    `fs_read` 的做法一致；归属只剩位置，`claude/converter.ts` 用三件套补回：
 *    `canonicalizeToolResultOrder`（images[] 与 tool_use 同序）+ `imagePlaceholder`
 *    （结果内 `[image k attached to this message]`）+ `prependImageLegend`（≥2 图时
 *    user content 前置 `[Attached images, in order: …]`，真实上游实测缺了它两模型 4/4 错位）。
 *
 * ⚠ `status` 表示**工具本身是否执行成功**，不是业务结果：`exit 42` 仍是 `"success"`
 * （拿到了退出码），只有参数校验失败这类才是 `"error"`。
 */
export interface ToolResult {
  toolUseId: string;
  content: Record<string, unknown>[];
  status?: string;
}

export function toolResultSuccess(toolUseId: string, content: string): ToolResult {
  return {
    toolUseId,
    content: [{ text: content }],
    status: 'success',
  };
}

export function toolResultError(toolUseId: string, errorMessage: string): ToolResult {
  return {
    toolUseId,
    content: [{ text: errorMessage }],
    status: 'error',
  };
}

/** 工具使用条目（历史消息中记录工具调用） */
export interface ToolUseEntry {
  toolUseId: string;
  name: string;
  input: unknown;
}

export function createToolUseEntry(
  toolUseId: string,
  name: string,
  input: unknown = {},
): ToolUseEntry {
  return { toolUseId, name, input };
}
