/**
 * OpenAI Responses API handler(POST /openai/v1/responses)。
 *
 * 镜像 chat handler:convertResponsesRequest → convertRequest(复用全链路)→
 * serialize → stream/non-stream 分派。Codex CLI 走这条(wire_api=responses)。
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  type ClientSession,
  ConversionError,
  type ConversionResult,
  clientModelHasEncryptedReasoning,
  convertRequest,
  toKiroRequest,
} from '../../claude/converter.js';
import { captureEmptyRequest, type MessageHandlerResult } from '../../claude/empty-capture.js';
import type { PostMessagesDeps } from '../../claude/handlers.js';
import { buildToolTextRegistry } from '../../claude/tool-call-text.js';
import type { MessagesRequest } from '../../claude/types.js';
import { isThinkingEnabled } from '../../claude/types.js';
import { serializeKiroRequest } from '../../kiro/model/requests/kiro.js';
import { getLogger } from '../../shared/logger.js';
import { getRequestContext } from '../../shared/request-context.js';
import { countAllTokens } from '../../token.js';
import { createOpenAiError } from '../types.js';
import {
  convertResponsesRequest,
  type ReasoningReplay,
  type ResponsesToolCodec,
} from './converter.js';
import { handleResponsesNonStreamRequest } from './non-stream-handler.js';
import { wantsEncryptedReasoning } from './reasoning-envelope.js';
import { handleResponsesStreamRequest } from './stream-handler.js';
import type { ResponsesRequest } from './types.js';

/**
 * Codex 线程 → kiro-cli 会话(形态见 `resolveConversationIdentity`)。
 *
 * Codex 的 subagent 与父线程共用 `prompt_cache_key`(根 session id),线程身份只在 `thread-id`
 * 头里:根线程的 `thread-id` 等于 key,子线程各有自己的(0.156.1 实测)。kiro-cli 的 subagent
 * 是独立会话——自己的 conversationId、不带 agentContinuationId——所以 `thread-id` 与 key 不同
 * 的请求按 subagent 会话映射。根线程只看 key,与 Chat 端点派生出同一个 id。没有 key 时不单凭
 * `thread-id` 认会话:那是 Codex 私有头,不是协议里的会话声明。
 */
export function responsesSession(
  promptCacheKey: unknown,
  threadId: unknown,
): ClientSession | undefined {
  if (typeof promptCacheKey !== 'string' || !promptCacheKey) return undefined;
  if (typeof threadId === 'string' && threadId && threadId !== promptCacheKey) {
    return { key: `${promptCacheKey}\nthread:${threadId}`, subagent: true };
  }
  return { key: promptCacheKey, subagent: false };
}

export function createPostResponses(deps: PostMessagesDeps) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const log = getLogger();

    // Responses 请求宽松:只强校验 model + input 存在,其余交 converter 防御式处理。
    const body = request.body as Partial<ResponsesRequest> | undefined;
    if (!body || typeof body !== 'object' || typeof body.model !== 'string') {
      reply.status(400).send(createOpenAiError('model is required', 'invalid_request_error'));
      return;
    }
    if (body.input === undefined || body.input === null) {
      reply.status(400).send(createOpenAiError('input is required', 'invalid_request_error'));
      return;
    }
    const oaiReq = body as ResponsesRequest;
    const stream = oaiReq.stream ?? false;
    const session = responsesSession(oaiReq.prompt_cache_key, request.headers['thread-id']);

    // 这行是本请求的**唯一**日志(CLAUDE.md 日志红线),故转换必须在它之前完成:
    // tool_count 要记**转换后**的数量——code mode 下顶层 tools 不存在(工具在 input 的
    // additional_tools 里),读顶层会把这类请求恒记成 0,而「工具全丢」只在这个字段上可见。
    // 转换抛错时也不能把这行吞掉(那正是最需要它的时候),故兜住异常补记再抛。
    let payload: MessagesRequest;
    let codec: ResponsesToolCodec;
    let reasoningReplay: ReasoningReplay;
    try {
      ({ payload, codec, reasoningReplay } = convertResponsesRequest(oaiReq));
    } catch (e) {
      log.info({
        msg: 'POST /openai/v1/responses',
        model: oaiReq.model,
        stream,
        input_type: Array.isArray(oaiReq.input) ? `items[${oaiReq.input.length}]` : 'string',
        conversion_failed: true,
      });
      throw e;
    }

    log.info({
      msg: 'POST /openai/v1/responses',
      model: oaiReq.model,
      stream,
      input_type: Array.isArray(oaiReq.input) ? `items[${oaiReq.input.length}]` : 'string',
      tool_count: payload.tools?.length ?? 0,
      custom_tool_count: codec.customToolNames.size,
      namespaced_tool_count: codec.toolNamespaces.size,
      reasoning_effort: oaiReq.reasoning?.effort,
      has_session_key: session !== undefined,
      ...(session?.subagent ? { subagent_thread: true } : {}),
      reasoning_replayed: reasoningReplay.replayed,
      ...(Object.values(reasoningReplay.dropped).some((n) => n > 0)
        ? { reasoning_dropped: reasoningReplay.dropped }
        : {}),
    });

    const provider = deps.kiroProvider;

    const rescueRegistry =
      deps.toolCallTextRescue && payload.tools && payload.tools.length > 0
        ? buildToolTextRegistry(payload.tools)
        : undefined;

    let conversionResult: ConversionResult;
    try {
      conversionResult = convertRequest(payload, {
        identityOverride: deps.identityOverride,
        rejectUnsupportedDocuments: deps.rejectUnsupportedDocuments,
        toolDescriptionMaxLen: deps.toolDescriptionMaxLen,
        toolTextRegistry: rescueRegistry,
        session,
      });
    } catch (e) {
      if (e instanceof ConversionError) {
        const message =
          e.code === 'UnsupportedModel'
            ? `Model not supported: ${oaiReq.model}`
            : 'input produced no messages';
        log.warn({ msg: 'responses conversion failed', code: e.code });
        reply.status(400).send(createOpenAiError(message, 'invalid_request_error'));
        return;
      }
      throw e;
    }

    const kiroRequest = toKiroRequest(conversionResult);
    let requestBody: string;
    try {
      requestBody = serializeKiroRequest(kiroRequest);
    } catch (e) {
      log.error({ msg: 'responses serialization failed', error: String(e) });
      reply.status(500).send(createOpenAiError(`Serialization failed: ${e}`, 'api_error'));
      return;
    }

    const inputTokens = await countAllTokens(
      payload.model,
      payload.system,
      payload.messages,
      payload.tools,
    );
    // 仅 GPT(加密 reasoning)从响应开始就关掉 legacy `<thinking>` 解码；运行时 native
    // event 也会锁模式，但静态判定还能覆盖 redacted event 缺失/晚到，避免误解 GPT
    // 可见输出里的字面标签。Claude 原生 reasoning(明文)不纳入(见 converter.ts)。
    const extractThinking =
      deps.extractThinking &&
      isThinkingEnabled(payload.thinking) &&
      !clientModelHasEncryptedReasoning(payload.model);
    const toolNameMap = conversionResult.toolNameMap;
    // 推理往返只在客户端声明 include 时开(OpenAI 语义:不声明就不下发 encrypted_content)。
    const reasoningModelId = wantsEncryptedReasoning(oaiReq.include)
      ? reasoningReplay.modelId
      : undefined;

    let result: MessageHandlerResult;
    if (stream) {
      result = await handleResponsesStreamRequest(
        provider,
        requestBody,
        payload.model,
        inputTokens,
        extractThinking,
        toolNameMap,
        deps.hookBus,
        reply,
        deps.emptyStreamRetries,
        rescueRegistry,
        codec,
        reasoningModelId,
      );
    } else {
      result = await handleResponsesNonStreamRequest(
        provider,
        requestBody,
        payload.model,
        inputTokens,
        extractThinking,
        toolNameMap,
        deps.hookBus,
        reply,
        Math.floor(Date.now() / 1000),
        deps.emptyStreamRetries,
        rescueRegistry,
        codec,
        reasoningModelId,
      );
    }

    if (result.emptyResponse && deps.captureEmptyDir) {
      captureEmptyRequest(deps.captureEmptyDir, {
        reqId: getRequestContext()?.reqId,
        model: payload.model,
        emptyAttempts: result.emptyAttempts,
        rawRequest: request.body,
        meta: { stream, endpoint: 'responses' },
      });
    }
  };
}
