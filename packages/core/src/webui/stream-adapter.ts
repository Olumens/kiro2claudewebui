export type WebUiBlockKind = 'text' | 'other';

export interface WebUiStreamState {
  readonly blockKinds: Map<number, WebUiBlockKind>;
}

export interface WebUiStreamDelta {
  readonly textDelta?: string;
  readonly done?: boolean;
  readonly errorMessage?: string;
}

export function createWebUiStreamState(): WebUiStreamState {
  return { blockKinds: new Map<number, WebUiBlockKind>() };
}

/**
 * Reduce one Claude SSE data event into Web UI-friendly deltas.
 *
 * 只把 text block 的 text_delta 往 UI 暴露;tool_use/thinking/redacted_thinking
 * 全部静默丢弃,避免在 MVP 聊天窗口里出现不适合直接展示的结构化内容。
 */
export function reduceClaudeSseData(state: WebUiStreamState, eventData: string): WebUiStreamDelta {
  const readBlockType = (raw: unknown): string | undefined => {
    if (!raw || typeof raw !== 'object') return undefined;
    const block = raw as { type?: unknown };
    return typeof block.type === 'string' ? block.type : undefined;
  };
  const readIndex = (raw: unknown): number | undefined => {
    if (!raw || typeof raw !== 'object') return undefined;
    const value = (raw as { index?: unknown }).index;
    return typeof value === 'number' ? value : undefined;
  };
  const readTextDelta = (raw: unknown): string | undefined => {
    if (!raw || typeof raw !== 'object') return undefined;
    const delta = raw as { type?: unknown; text?: unknown };
    if (delta.type !== 'text_delta') return undefined;
    return typeof delta.text === 'string' ? delta.text : undefined;
  };
  const readErrorMessage = (raw: unknown): string | undefined => {
    if (!raw || typeof raw !== 'object') return undefined;
    const err = (raw as { error?: unknown }).error;
    if (!err || typeof err !== 'object') return undefined;
    const msg = (err as { message?: unknown }).message;
    return typeof msg === 'string' ? msg : undefined;
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(eventData) as unknown;
  } catch {
    return {};
  }

  if (!parsed || typeof parsed !== 'object') return {};
  const event = parsed as {
    type?: unknown;
    content_block?: unknown;
    delta?: unknown;
  };

  if (event.type === 'content_block_start') {
    const index = readIndex(parsed);
    if (index !== undefined) {
      state.blockKinds.set(index, readBlockType(event.content_block) === 'text' ? 'text' : 'other');
    }
    return {};
  }

  if (event.type === 'content_block_delta') {
    const index = readIndex(parsed);
    if (index === undefined || state.blockKinds.get(index) !== 'text') return {};
    const textDelta = readTextDelta(event.delta);
    return textDelta ? { textDelta } : {};
  }

  if (event.type === 'content_block_stop') {
    const index = readIndex(parsed);
    if (index !== undefined) state.blockKinds.delete(index);
    return {};
  }

  if (event.type === 'message_stop') {
    state.blockKinds.clear();
    return { done: true };
  }

  if (event.type === 'error') {
    return {
      errorMessage: readErrorMessage(parsed) ?? '请求失败，请稍后重试。',
      done: true,
    };
  }

  return {};
}
