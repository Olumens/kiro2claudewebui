import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _resetKiroClientProfileCacheForTesting,
  getKiroClientProfile,
  renderKasUserAgent,
  renderKasXAmzUserAgent,
  renderShellUserAgent,
  renderShellXAmzUserAgent,
  requireKasTarget,
} from '../../src/kiro/client-profile.js';

/**
 * client-profile 模块的职责是「加载并缓存捕获脚本产出的 kiro-cli 请求画像」,分 `kas`(kiro-cli
 * `chat --v3` 的对话进程)与 `shell`(Rust 外壳)两个身份。测试覆盖:
 *   1. 默认(仓库 fixture)下的 V3 形态
 *   2. UA 模板里 `{jsOs}` / `{os}` / `{service}` 占位的渲染
 *   3. `KIRO2CLAUDE_CLIENT_PROFILE_PATH` 指向自定义 JSON;V2 时代的旧 fixture 回退到内置快照
 *   4. optout 隐私约束与缓存语义
 */

const kiroOsToken = (): string =>
  process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux';

describe('getKiroClientProfile', () => {
  const originalEnv = process.env.KIRO2CLAUDE_CLIENT_PROFILE_PATH;

  beforeEach(() => {
    _resetKiroClientProfileCacheForTesting();
    delete process.env.KIRO2CLAUDE_CLIENT_PROFILE_PATH;
  });

  afterEach(() => {
    _resetKiroClientProfileCacheForTesting();
    if (originalEnv === undefined) {
      delete process.env.KIRO2CLAUDE_CLIENT_PROFILE_PATH;
    } else {
      process.env.KIRO2CLAUDE_CLIENT_PROFILE_PATH = originalEnv;
    }
  });

  function withProfileFile(payload: unknown, run: () => void): void {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-cli-profile-test-'));
    const fixturePath = path.join(tmpDir, 'profile.json');
    try {
      fs.writeFileSync(fixturePath, JSON.stringify(payload));
      process.env.KIRO2CLAUDE_CLIENT_PROFILE_PATH = fixturePath;
      run();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  it('returns the kiro-cli V3 (KAS) wire shape', () => {
    const profile = getKiroClientProfile();
    expect(profile.mode).toBe('kiro-cli');

    expect(profile.kas.body.origin).toBe('AI_EDITOR');
    expect(profile.kas.body.agentMode).toBe('vibe');
    expect(profile.kas.body.subagentAgentMode).toBe('general-task-execution');
    expect(profile.kas.body.agentTaskType).toBe('vibe');
    expect(profile.kas.body.chatTriggerType).toBe('MANUAL');

    expect(requireKasTarget(profile, 'generateAssistantResponse')).toBe(
      'KiroRuntimeService.GenerateAssistantResponse',
    );
    expect(requireKasTarget(profile, 'invokeMcp')).toBe('KiroRuntimeService.InvokeMCP');
    expect(profile.shell.amzTargets.getUsageLimits).toBe(
      'AmazonCodeWhispererService.GetUsageLimits',
    );

    // KAS 的 GAR 带 attribution、不带 accept;MCP 不带 attribution
    expect(profile.kas.staticHeaders['x-amzn-kiro-client-attribution']).toBe('unrecognized');
    expect(profile.kas.staticHeaders).not.toHaveProperty('accept');
    expect(profile.kas.mcpStaticHeaders).not.toHaveProperty('x-amzn-kiro-client-attribution');
  });

  it('renders the KAS UA with a Node-style and a kiro-cli-style platform token', () => {
    const profile = getKiroClientProfile();
    for (const ua of [renderKasUserAgent(profile), renderKasXAmzUserAgent(profile)]) {
      expect(ua).toMatch(/^aws-sdk-js\//);
      expect(ua).not.toMatch(/\{(jsOs|os|service)\}/);
      expect(ua).toContain(`os/${kiroOsToken()}`);
    }
    // user-agent 另带 Node 风格的 `os/<platform>#<release>`
    expect(renderKasUserAgent(profile)).toContain(`os/${process.platform}#${os.release()}`);
  });

  it('renders the shell UA with the service id', () => {
    const profile = getKiroClientProfile();
    const ua = renderShellUserAgent(profile);
    expect(ua).toMatch(/^aws-sdk-rust\//);
    expect(ua).toContain('api/codewhispererruntime/');
    expect(ua).toContain(`os/${kiroOsToken()}`);
    expect(renderShellXAmzUserAgent(profile)).not.toMatch(/\{/);
  });

  it('loads a profile from KIRO2CLAUDE_CLIENT_PROFILE_PATH and normalizes platform tokens', () => {
    withProfileFile(
      {
        kiroCliVersion: 'test-9.9.9',
        kas: {
          staticHeaders: { 'content-type': 'application/x-amz-json-1.0' },
          userAgent: 'custom-js/1.0 os/darwin#25.6.0 lang/js os/macos',
          xAmzUserAgent: 'custom-js/1.0 os/macos',
          amzTargets: { generateAssistantResponse: 'Custom.GenerateAssistantResponse' },
          body: { origin: 'TEST_ORIGIN', agentMode: 'test-mode' },
        },
        shell: { userAgent: 'custom-rust/1.0 api/{service}/x os/linux' },
      },
      () => {
        const profile = getKiroClientProfile();
        expect(profile.kiroCliVersion).toBe('test-9.9.9');
        expect(profile.kas.body.origin).toBe('TEST_ORIGIN');
        expect(profile.kas.body.agentMode).toBe('test-mode');
        // 没写的字段取内置快照
        expect(profile.kas.body.subagentAgentMode).toBe('general-task-execution');
        expect(profile.kas.userAgent).toBe('custom-js/1.0 os/{jsOs} lang/js os/{os}');
        expect(renderKasUserAgent(profile)).toBe(
          `custom-js/1.0 os/${process.platform}#${os.release()} lang/js os/${kiroOsToken()}`,
        );
        expect(renderShellUserAgent(profile)).toBe(
          `custom-rust/1.0 api/codewhispererruntime/x os/${kiroOsToken()}`,
        );
      },
    );
  });

  it('falls back to the built-in V3 snapshot for a V2-era fixture (no `kas` section)', () => {
    withProfileFile(
      {
        kiroCliVersion: '2.21.0',
        userAgent: 'aws-sdk-rust/1.3.15 api/{service}/x os/{os}',
        amzTargets: {
          generateAssistantResponse:
            'AmazonCodeWhispererStreamingService.GenerateAssistantResponse',
        },
        body: { origin: 'KIRO_CLI' },
      },
      () => {
        const profile = getKiroClientProfile();
        expect(profile.kiroCliVersion).toBe('unknown');
        expect(profile.kas.body.origin).toBe('AI_EDITOR');
        expect(requireKasTarget(profile, 'generateAssistantResponse')).toBe(
          'KiroRuntimeService.GenerateAssistantResponse',
        );
      },
    );
  });

  it('forces the opt-out header on every identity regardless of the fixture', () => {
    withProfileFile(
      {
        kas: {
          staticHeaders: { 'x-amzn-codewhisperer-optout': 'false' },
          mcpStaticHeaders: {},
        },
        shell: { staticHeaders: { 'x-amzn-codewhisperer-optout': 'false' } },
      },
      () => {
        const profile = getKiroClientProfile();
        expect(profile.kas.staticHeaders['x-amzn-codewhisperer-optout']).toBe('true');
        expect(profile.kas.mcpStaticHeaders['x-amzn-codewhisperer-optout']).toBe('true');
        expect(profile.shell.staticHeaders['x-amzn-codewhisperer-optout']).toBe('true');
      },
    );
  });

  it('caches the profile across calls', () => {
    const a = getKiroClientProfile();
    const b = getKiroClientProfile();
    expect(a).toBe(b);
  });
});
