/**
 * Kiro CLI 客户端画像（client profile）
 *
 * 集中管理 kiro2claude 向上游模拟 kiro-cli `chat --v3` 时使用的请求形态,分两个身份:
 * - `kas`:KAS(对话子进程)发的 GAR / InvokeMCP——头、UA 模板、target、body 语义字段
 *   (origin / agentMode / agentTaskType / chatTriggerType)
 * - `shell`:Rust 外壳发的 GetUsageLimits
 *
 * 这个模块是 kiro2claude 唯一的客户端模拟路径——`provider.ts`、
 * `token-manager.ts`、`converter.ts` 都会从这里取 UA / target / body
 * 字段，确保三端使用同一套 kiro-cli 画像，不会偷偷漂移。
 *
 * 值的加载优先级（高→低）：
 *   1. 环境变量 `KIRO2CLAUDE_CLIENT_PROFILE_PATH` 指向的 JSON 文件
 *   2. 启动期 auto-capture 临时写到 `$TMPDIR/kiro2claude-profile.json` 的文件
 *      （由 `KIRO2CLAUDE_AUTO_CAPTURE_PROFILE=true` 开启；见 `src/index.ts`）
 *   3. 仓库根目录下的 `fixtures/kiro-cli-profile.json`（由
 *      `scripts/capture-kiro-cli.sh` 从本机真实 kiro-cli 捕获生成）
 *   4. 下面写死的 `FALLBACK_PROFILE`（一次性抓包快照，kiroCliVersion 字段固定 'unknown'）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { logger } from '../shared/logger.js';
import { expandTilde, findUpwards } from '../shared/paths.js';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** KAS 发出的请求 → x-amz-target。网关只发前两个;其余随抓包保留,供对照。 */
export type KasTargetKey =
  | 'generateAssistantResponse'
  | 'invokeMcp'
  | 'getFeatureConfiguration'
  | 'listAvailableModels'
  | 'getProfile';

/**
 * KAS(kiro-cli `chat --v3` 的对话子进程 `@kiro/agent`)的请求身份:对话(GAR)与
 * web_search(InvokeMCP)都以它的形态发出。
 */
export interface KasIdentity {
  /** GAR 的静态头 */
  staticHeaders: Record<string, string>;
  /** InvokeMCP 的静态头(KAS 不给 MCP 发 attribution 头) */
  mcpStaticHeaders: Record<string, string>;
  /**
   * UA 模板:`{jsOs}` 渲染成 Node 风格的 `<platform>#<release>`,`{os}` 渲染成 kiro-cli 风格的
   * `macos` / `linux` / `windows`。`md/nodejs#…` 是 kiro-cli 自带 Node 的版本,原样保留。
   */
  userAgent: string;
  xAmzUserAgent: string;
  amzTargets: Partial<Record<KasTargetKey, string>>;
  /** body 里的语义字段 */
  body: {
    origin: string;
    /** 顶层 `agentMode`:主会话 */
    agentMode: string;
    /** 顶层 `agentMode`:subagent 会话(KAS `invoke_sub_agent` 的实测值) */
    subagentAgentMode: string;
    agentTaskType: string;
    chatTriggerType: string;
  };
}

/** kiro-cli Rust 外壳的请求身份:网关只用它发 GetUsageLimits(V3 下额度查询由外壳而非 KAS 发)。 */
export interface ShellIdentity {
  staticHeaders: Record<string, string>;
  /** UA 模板:`{service}` 为服务标识,`{os}` 同 KAS */
  userAgent: string;
  xAmzUserAgent: string;
  amzTargets: { getUsageLimits: string };
}

export interface KiroClientProfile {
  /** 固定为 'kiro-cli'——这个模块只承载 kiro-cli 仿真画像 */
  readonly mode: 'kiro-cli';
  /** 捕获时的 kiro-cli 版本 */
  kiroCliVersion: string;
  kas: KasIdentity;
  shell: ShellIdentity;
}

// ---------------------------------------------------------------------------
// Fallback —— fixture 缺失时的兜底快照
// ---------------------------------------------------------------------------

/**
 * 兜底 profile。当 fixture 文件不存在、加载失败或缺 `kas` 段(V2 形态)时使用。
 * 数值来源:2026-09 kiro-cli 2.23.1 `chat --v3` 实测抓包(一次性快照,不维护同步)。
 * 例外:`x-amzn-codewhisperer-optout` 固定 `'true'`(项目隐私硬约束,绝不参与
 * 上游训练 / 遥测),不取抓包值——与 fixture 的归一化立场一致。
 *
 * **kiroCliVersion 字段固定为 'unknown'**——版本号的唯一真相源是
 * `fixtures/kiro-cli-profile.json` 的 `kiroCliVersion`。FALLBACK 触发
 * 时说明 fixture 不可用,此时显示具体版本号反而误导。
 *
 * UA 等字段保留快照时点的具体值:可以 stale,但必须 wire-format 合法。
 */
const FALLBACK_PROFILE: KiroClientProfile = {
  mode: 'kiro-cli',
  kiroCliVersion: 'unknown',
  kas: {
    staticHeaders: {
      'content-type': 'application/x-amz-json-1.0',
      // 隐私硬约束:始终 opt-out,绝不让对话数据被上游用于训练。与 fixture 同立场。
      'x-amzn-codewhisperer-optout': 'true',
      'x-amzn-kiro-client-attribution': 'unrecognized',
      connection: 'keep-alive',
    },
    mcpStaticHeaders: {
      'content-type': 'application/x-amz-json-1.0',
      'x-amzn-codewhisperer-optout': 'true',
      connection: 'keep-alive',
    },
    userAgent:
      'aws-sdk-js/1.0.0 ua/2.1 os/{jsOs} lang/js md/nodejs#22.22.2 api/kiroruntime#1.0.0 m/N KiroCLI/2.23.1 KAS/0.66.8 os/{os} md/appVersion-2.23.1 app/AmazonQ-For-CLI',
    xAmzUserAgent:
      'aws-sdk-js/1.0.0 KiroCLI/2.23.1 KAS/0.66.8 os/{os} md/appVersion-2.23.1 app/AmazonQ-For-CLI',
    amzTargets: {
      generateAssistantResponse: 'KiroRuntimeService.GenerateAssistantResponse',
      invokeMcp: 'KiroRuntimeService.InvokeMCP',
    },
    body: {
      origin: 'AI_EDITOR',
      agentMode: 'vibe',
      subagentAgentMode: 'general-task-execution',
      agentTaskType: 'vibe',
      chatTriggerType: 'MANUAL',
    },
  },
  shell: {
    staticHeaders: {
      'content-type': 'application/x-amz-json-1.0',
      'x-amzn-codewhisperer-optout': 'true',
      accept: '*/*',
      'accept-encoding': 'gzip',
    },
    userAgent:
      'aws-sdk-rust/1.3.10 ua/2.1 api/{service}/0.1.10231 os/{os} lang/rust/1.92.0 md/appVersion-2.23.1 app/AmazonQ-For-CLI',
    xAmzUserAgent:
      'aws-sdk-rust/1.3.10 ua/2.1 api/{service}/0.1.10231 os/{os} lang/rust/1.92.0 m/F,C app/AmazonQ-For-CLI',
    amzTargets: { getUsageLimits: 'AmazonCodeWhispererService.GetUsageLimits' },
  },
};

// ---------------------------------------------------------------------------
// os 归一化
// ---------------------------------------------------------------------------

/**
 * 把 UA 里的具体平台 token 换回占位符:Node 风格的 `os/<platform>#<release>` → `os/{jsOs}`,
 * kiro-cli 风格的 `os/macos|linux|windows` → `os/{os}`。
 *
 * `scripts/capture-kiro-cli.sh` 写 fixture 时已经做过,这里给手工编辑的 fixture 兜底,
 * 保证 macOS 抓的画像部署到 Linux 容器也不会暴露抓包机平台。先换 `{jsOs}`,否则
 * `os/linux#…` 会被第二条规则截成 `os/{os}#…`。
 */
function normalizeUa(ua: string): string {
  return ua
    .replace(/\bos\/(darwin|linux|win32)#[^\s]+/g, 'os/{jsOs}')
    .replace(/\bos\/(macos|linux|windows)\b/g, 'os/{os}');
}

function normalizeProfileOs(profile: KiroClientProfile): KiroClientProfile {
  return {
    ...profile,
    kas: {
      ...profile.kas,
      userAgent: normalizeUa(profile.kas.userAgent),
      xAmzUserAgent: normalizeUa(profile.kas.xAmzUserAgent),
    },
    shell: {
      ...profile.shell,
      userAgent: normalizeUa(profile.shell.userAgent),
      xAmzUserAgent: normalizeUa(profile.shell.xAmzUserAgent),
    },
  };
}

/** 根据 Node 的 process.platform 返回 kiro-cli 风格的 os 字符串 */
function currentOsToken(): string {
  switch (process.platform) {
    case 'linux':
      return 'linux';
    case 'darwin':
      return 'macos';
    case 'win32':
      return 'windows';
    default:
      // freebsd / android 等冷门平台按 kiro-cli 默认落回 linux 最接近
      return 'linux';
  }
}

/** KAS(aws-sdk-js)在 UA 里写的平台:`<process.platform>#<os.release()>`,真实 KAS 在同一台机器上也这样报。 */
const JS_OS_TOKEN = `${process.platform}#${os.release()}`;

/** Rust 外壳调用的上游服务标识(shell UA 里的 `api/{service}/...`);网关只经外壳发 GetUsageLimits */
const SHELL_SERVICE_ID = 'codewhispererruntime';

// ---------------------------------------------------------------------------
// 加载
// ---------------------------------------------------------------------------

const asStringRecord = (v: unknown): Record<string, string> | undefined =>
  v && typeof v === 'object' ? (v as Record<string, string>) : undefined;
const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * 把 capture 脚本产出的原始 JSON 规范化为 `KiroClientProfile`。
 *
 * fixture 没有 `kas` 段 = V2 时代的旧 fixture:它描述的是另一套 wire,不能拿来半拼半凑,
 * 直接报错让调用方回退到内置 V3 快照。
 */
function parseCaptured(raw: unknown): KiroClientProfile {
  if (!raw || typeof raw !== 'object') {
    throw new Error('profile JSON root is not an object');
  }
  const obj = raw as Record<string, unknown>;
  if (!obj.kas || typeof obj.kas !== 'object') {
    throw new Error(
      'profile has no `kas` section (V2-era fixture); rerun scripts/capture-kiro-cli.sh',
    );
  }
  const kasRaw = obj.kas as Record<string, unknown>;
  const shellRaw = (obj.shell && typeof obj.shell === 'object' ? obj.shell : {}) as Record<
    string,
    unknown
  >;
  const fb = FALLBACK_PROFILE;

  const amzTargets: KasIdentity['amzTargets'] = { ...fb.kas.amzTargets };
  for (const [k, v] of Object.entries(asStringRecord(kasRaw.amzTargets) ?? {})) {
    if (typeof v === 'string') (amzTargets as Record<string, string>)[k] = v;
  }
  const bodyRaw = (kasRaw.body && typeof kasRaw.body === 'object' ? kasRaw.body : {}) as Record<
    string,
    unknown
  >;

  const profile: KiroClientProfile = {
    mode: 'kiro-cli',
    kiroCliVersion: asString(obj.kiroCliVersion) ?? 'unknown',
    kas: {
      staticHeaders: asStringRecord(kasRaw.staticHeaders) ?? fb.kas.staticHeaders,
      mcpStaticHeaders: asStringRecord(kasRaw.mcpStaticHeaders) ?? fb.kas.mcpStaticHeaders,
      userAgent: asString(kasRaw.userAgent) ?? fb.kas.userAgent,
      xAmzUserAgent: asString(kasRaw.xAmzUserAgent) ?? fb.kas.xAmzUserAgent,
      amzTargets,
      body: {
        origin: asString(bodyRaw.origin) ?? fb.kas.body.origin,
        agentMode: asString(bodyRaw.agentMode) ?? fb.kas.body.agentMode,
        // 一次 "ping" 抓不到 subagent,只能用内置实测值(fixture 可手工覆盖)
        subagentAgentMode: asString(bodyRaw.subagentAgentMode) ?? fb.kas.body.subagentAgentMode,
        agentTaskType: asString(bodyRaw.agentTaskType) ?? fb.kas.body.agentTaskType,
        chatTriggerType: asString(bodyRaw.chatTriggerType) ?? fb.kas.body.chatTriggerType,
      },
    },
    shell: {
      staticHeaders: asStringRecord(shellRaw.staticHeaders) ?? fb.shell.staticHeaders,
      userAgent: asString(shellRaw.userAgent) ?? fb.shell.userAgent,
      xAmzUserAgent: asString(shellRaw.xAmzUserAgent) ?? fb.shell.xAmzUserAgent,
      amzTargets: fb.shell.amzTargets,
    },
  };

  // optout 是隐私硬约束,不管 fixture 写了什么都强制 'true'
  for (const headers of [
    profile.kas.staticHeaders,
    profile.kas.mcpStaticHeaders,
    profile.shell.staticHeaders,
  ]) {
    headers['x-amzn-codewhisperer-optout'] = 'true';
  }
  return normalizeProfileOs(profile);
}

function resolveDefaultFixturePath(): string | undefined {
  // fixtures/ 在仓库根（`packages/` 的上层），容器里紧挨 dist/ 一层——
  // 距离随布局变化，见 `shared/paths.ts` 的 `findUpwards()`。
  try {
    const from = path.dirname(fileURLToPath(import.meta.url));
    return findUpwards(from, path.join('fixtures', 'kiro-cli-profile.json')).hit?.path;
  } catch {
    // import.meta.url 在某些测试环境下不可用
    return undefined;
  }
}

let cached: KiroClientProfile | undefined;

/**
 * 获取当前进程生效的 client profile。首次调用会加载并缓存；
 * 后续调用直接返回缓存值。
 */
export function getKiroClientProfile(): KiroClientProfile {
  if (cached) return cached;

  const explicitPath = process.env.KIRO2CLAUDE_CLIENT_PROFILE_PATH?.trim();
  const fixturePath =
    explicitPath && explicitPath.length > 0
      ? expandTilde(explicitPath)
      : resolveDefaultFixturePath();

  if (fixturePath) {
    try {
      const text = fs.readFileSync(fixturePath, 'utf-8');
      const profile = parseCaptured(JSON.parse(text));
      logger.info(
        `Loaded kiro-cli client profile from ${fixturePath} (kiro-cli ${profile.kiroCliVersion})`,
      );
      cached = profile;
      return profile;
    } catch (e) {
      logger.warn(
        `Failed to load kiro-cli client profile from ${fixturePath}, falling back to built-in: ${e}`,
      );
    }
  } else {
    logger.info('No kiro-cli client profile fixture found, using built-in defaults');
  }

  // Fallback 也要归一化 os —— 保持与 fixture 路径同构
  cached = normalizeProfileOs(FALLBACK_PROFILE);
  return cached;
}

/** 仅用于测试：重置内部缓存，让下次 `getKiroClientProfile()` 重新加载 */
export function _resetKiroClientProfileCacheForTesting(): void {
  cached = undefined;
}

/**
 * 启动期 auto-capture 完成后调用：用新写入的 fixture 替换掉缓存，
 * 避免应用已经缓存了旧值导致新抓结果失效。
 */
export function reloadKiroClientProfile(): KiroClientProfile {
  cached = undefined;
  return getKiroClientProfile();
}

// ---------------------------------------------------------------------------
// 便捷方法:渲染 UA / 取 target
// ---------------------------------------------------------------------------

function renderPlaceholders(template: string): string {
  return template
    .replace('{jsOs}', JS_OS_TOKEN)
    .replace('{os}', currentOsToken())
    .replace('{service}', SHELL_SERVICE_ID);
}

export function renderKasUserAgent(profile: KiroClientProfile): string {
  return renderPlaceholders(profile.kas.userAgent);
}

export function renderKasXAmzUserAgent(profile: KiroClientProfile): string {
  return renderPlaceholders(profile.kas.xAmzUserAgent);
}

export function renderShellUserAgent(profile: KiroClientProfile): string {
  return renderPlaceholders(profile.shell.userAgent);
}

export function renderShellXAmzUserAgent(profile: KiroClientProfile): string {
  return renderPlaceholders(profile.shell.xAmzUserAgent);
}

/** 按 target key 取出 KAS 的 x-amz-target 头值;未定义时抛错 */
export function requireKasTarget(profile: KiroClientProfile, key: KasTargetKey): string {
  const v = profile.kas.amzTargets[key];
  if (!v) throw new Error(`kiro-cli client profile missing kas.amzTargets.${key}`);
  return v;
}
