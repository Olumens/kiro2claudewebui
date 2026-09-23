import { describe, expect, it } from 'vitest';
import {
  createToolUseEntry,
  defaultInputSchema,
  toolResultError,
  toolResultSuccess,
} from '../../../../src/kiro/model/requests/tool.js';

describe('ToolResult', () => {
  it('test_tool_result_success', () => {
    const result = toolResultSuccess('tool-123', 'Operation completed');
    expect(result.status).toBe('success');
  });

  it('test_tool_result_error', () => {
    const result = toolResultError('tool-456', 'File not found');
    expect(result.status).toBe('error');
  });

  it('test_tool_result_serialize', () => {
    const result = toolResultSuccess('tool-789', 'Done');
    const json = JSON.stringify(result);
    expect(json).toContain('"toolUseId":"tool-789"');
    expect(json).toContain('"status":"success"');
    // Like kiro-cli (KAS), success/failure rides on `status` only; `isError` is not sent
    // (see the control experiment in the ToolResult doc comment).
    expect(json).not.toContain('isError');
  });
});

describe('ToolUseEntry', () => {
  it('test_tool_use_entry', () => {
    const entry = createToolUseEntry('use-123', 'read_file', { path: '/test.txt' });
    const json = JSON.stringify(entry);
    expect(json).toContain('"toolUseId":"use-123"');
    expect(json).toContain('"name":"read_file"');
    expect(json).toContain('"path":"/test.txt"');
  });
});

describe('InputSchema', () => {
  it('test_input_schema_default', () => {
    const schema = defaultInputSchema();
    expect((schema.json as { type: string }).type).toBe('object');
  });
});
