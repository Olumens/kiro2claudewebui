import { describe, expect, it } from 'vitest';
import { createWebUiStreamState, reduceClaudeSseData } from '../../src/webui/stream-adapter.js';

describe('webui stream adapter', () => {
  it('emits text deltas only for text blocks', () => {
    const state = createWebUiStreamState();

    expect(
      reduceClaudeSseData(
        state,
        JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
      ),
    ).toEqual({});

    expect(
      reduceClaudeSseData(
        state,
        JSON.stringify({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'hello' },
        }),
      ),
    ).toEqual({ textDelta: 'hello' });
  });

  it('ignores tool/thinking block deltas', () => {
    const state = createWebUiStreamState();

    reduceClaudeSseData(
      state,
      JSON.stringify({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use' },
      }),
    );
    reduceClaudeSseData(
      state,
      JSON.stringify({
        type: 'content_block_start',
        index: 2,
        content_block: { type: 'thinking' },
      }),
    );

    expect(
      reduceClaudeSseData(
        state,
        JSON.stringify({
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: 'tool text' },
        }),
      ),
    ).toEqual({});

    expect(
      reduceClaudeSseData(
        state,
        JSON.stringify({
          type: 'content_block_delta',
          index: 2,
          delta: { type: 'text_delta', text: 'hidden reasoning' },
        }),
      ),
    ).toEqual({});
  });

  it('maps error + done terminal events', () => {
    const state = createWebUiStreamState();
    expect(reduceClaudeSseData(state, JSON.stringify({ type: 'message_stop' }))).toEqual({
      done: true,
    });

    expect(
      reduceClaudeSseData(
        state,
        JSON.stringify({ type: 'error', error: { message: 'quota exhausted' } }),
      ),
    ).toEqual({ done: true, errorMessage: 'quota exhausted' });
  });
});
