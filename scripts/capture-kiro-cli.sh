#!/usr/bin/env bash
#
# capture-kiro-cli.sh —— 在本地捕获真实 kiro-cli 发出的 HTTP 请求头与 body，
# 生成 fixtures/kiro-cli-profile.json。生成后 kiro2claude 启动时会优先读取该文件
# 来模拟与 kiro-cli 完全一致的请求形态。
#
# 网关对齐的是 kiro-cli **V3**(`chat --v3`):对话、工具、subagent 都由 KAS(kiro-cli 内嵌的
# Node 子进程 `@kiro/agent`)发出;登录、额度查询等仍由 Rust 外壳发。fixture 因此分两个身份:
#   - `kas`  :GenerateAssistantResponse / InvokeMCP 的头、UA、target 与 body 语义字段
#   - `shell`:Rust 外壳的 UA(网关用它发 GetUsageLimits)
#
# 工作原理(都指向本地明文 mock,不做 TLS MITM,也不会打到真实上游):
#   1. 启动 Node mock:应答 KAS 启动时的预检(ListAvailableModels / GetProfile /
#      GetFeatureConfiguration / InvokeMCP tools/list),GAR 录下后回 500 让它停下。
#   2. KAS:`KIRO_KAS_ENDPOINT` / `KIRO_KAS_CONTROL_PLANE_ENDPOINT` 指向 mock,跑
#      `kiro-cli chat --v3 --no-interactive "ping"`(2.23.1 起非交互路径认这两个变量)。
#   3. Rust 外壳:临时把 `api.codewhisperer.service` 等 settings 指向 mock,跑
#      `kiro-cli profile` 录它的 UA,结束即删除这些 settings。
#   4. 把捕获结果规范化、脱敏成 profile JSON。
#
# 前置条件:本机已安装并登录 kiro-cli(whoami 能通过),已安装 node(≥18)。
#
# 用法：
#   ./scripts/capture-kiro-cli.sh                    # 捕获并写入默认路径
#   ./scripts/capture-kiro-cli.sh --out path.json    # 自定义输出路径
#   ./scripts/capture-kiro-cli.sh --port 18443       # mock 监听端口(默认 18443)
#   KIRO2CLAUDE_CLI_BIN=/path/to/kiro-cli ./scripts/capture-kiro-cli.sh   # 或 --bin <path>
#
# fixture 是 kiro-cli 版本的**唯一真相源**：这个脚本只更新 fixture，
# Dockerfile 通过 `pnpm docker:build` 自动从 fixture 派生版本号，
# FALLBACK_PROFILE 的 kiroCliVersion 永远是 'unknown'（不视作副本）。
# 升级只有两步:1) 跑这个脚本（更新 fixture） 2) git commit fixtures/

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

OUT_PATH="$PROJECT_ROOT/fixtures/kiro-cli-profile.json"
PORT=18443
KIRO2CLAUDE_CLI_BIN="${KIRO2CLAUDE_CLI_BIN:-kiro-cli}"

# Rust 外壳按服务拆分的 endpoint settings key(只用于第 3 步录 shell UA)。
# 未知 key 会被静默跳过，只有成功设置的记进 SET_KEYS 供 cleanup。
ENDPOINT_KEYS=(api.codewhisperer.service api.krs.service api.cps.service)

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)
      OUT_PATH="$2"
      shift 2
      ;;
    --port)
      PORT="$2"
      shift 2
      ;;
    --bin)
      KIRO2CLAUDE_CLI_BIN="$2"
      shift 2
      ;;
    -h|--help)
      sed -n '2,32p' "$0"
      exit 0
      ;;
    *)
      echo "未知参数: $1" >&2
      exit 1
      ;;
  esac
done

if ! command -v "$KIRO2CLAUDE_CLI_BIN" >/dev/null 2>&1; then
  if [[ "$KIRO2CLAUDE_CLI_BIN" == "kiro-cli" ]]; then
    echo "错误: 未找到 kiro-cli，请先安装（参见 https://kiro.dev/docs/cli/installation/）" >&2
  else
    echo "错误: 未找到 $KIRO2CLAUDE_CLI_BIN" >&2
  fi
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "错误: 未找到 node（需要 Node.js ≥18）" >&2
  exit 1
fi

if ! "$KIRO2CLAUDE_CLI_BIN" whoami >/dev/null 2>&1; then
  echo "错误: kiro-cli whoami 失败，请先登录 (kiro-cli login)" >&2
  exit 1
fi

# KAS 的非交互路径 2.23.1 起才认 KIRO_KAS_ENDPOINT;更老的版本无视重定向,抓包用的 "ping" 会
# 直连真实上游并消耗 credits。触发前校验,版本读不出也中止。
MIN_KAS_ENDPOINT_VERSION="2.23.1"
KIRO2CLAUDE_CLI_VERSION="$("$KIRO2CLAUDE_CLI_BIN" --version 2>/dev/null | awk '{print $NF}')"
if ! node -e '
  const [v, min] = process.argv.slice(1).map((s) => s.split(".").map((n) => Number.parseInt(n, 10)));
  if (v.length < 3 || v.some(Number.isNaN)) process.exit(1);
  for (let i = 0; i < 3; i++) if (v[i] !== min[i]) process.exit(v[i] > min[i] ? 0 : 1);
' "$KIRO2CLAUDE_CLI_VERSION" "$MIN_KAS_ENDPOINT_VERSION"; then
  echo "错误: kiro-cli 版本 \"${KIRO2CLAUDE_CLI_VERSION:-unknown}\" 低于 $MIN_KAS_ENDPOINT_VERSION 或无法识别," >&2
  echo "      KIRO_KAS_ENDPOINT 重定向不保证生效,继续会直连真实上游并消耗 credits。中止。" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT_PATH")"
# GNU / BSD mktemp 的 `-t` 语义不一样，最小公约数写法是
# `mktemp -d "${TMPDIR:-/tmp}/name.XXXXXX"`：macOS (BSD) 和 Linux (GNU)
# 都接受这种绝对路径模板。
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/kiro-cli-capture.XXXXXX")"
trap 'cleanup' EXIT INT TERM

CAPTURE_FILE="$WORKDIR/raw.json"
SERVER_PID=""
# 实际成功设置的 endpoint key（cleanup 据此只删自己设过的，不碰未设置的 key）。
# 注意是 delete 而非恢复原值——脚本不保存原值，原本配过自定义 endpoint 的会丢。
# 顶部声明，保证 trap 在脚本任意早期失败时引用都安全（set -u 下空数组也合法）。
declare -a SET_KEYS=()

cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [[ "${#SET_KEYS[@]}" -gt 0 ]]; then
    echo "→ 清理 kiro-cli 设置 (删除本次注入的 endpoint 覆盖)"
    for k in "${SET_KEYS[@]}"; do
      "$KIRO2CLAUDE_CLI_BIN" settings --delete "$k" >/dev/null 2>&1 || true
    done
  fi
  rm -rf "$WORKDIR"
}

# ---------------------------------------------------------------------------
# 1) 启动本地捕获服务器
# ---------------------------------------------------------------------------
cat > "$WORKDIR/server.cjs" <<'NODE_EOF'
const http = require('http');
const fs = require('fs');
const path = process.env.CAPTURE_FILE;
const port = parseInt(process.env.CAPTURE_PORT || '18443', 10);
const records = [];
// 对每个 method + path + target + UA 只保留首条:KAS 与 Rust 外壳会打同名 target
// (GetProfile / ListAvailableModels),靠 UA 区分;retry 不重复膨胀。
const seen = new Set();

function writeOut() {
  fs.writeFileSync(path, JSON.stringify(records, null, 2));
}

const MOCK_MODEL = {
  modelId: 'auto',
  modelName: 'Auto',
  description: 'mock',
  rateMultiplier: 1,
  rateUnit: 'Credit',
  tokenLimits: { maxInputTokens: 200000, maxOutputTokens: 64000 },
};

function reply(res, obj, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/x-amz-json-1.0' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const target = String(req.headers['x-amz-target'] || '(none)');
    const key = `${req.method} ${req.url.split('?')[0]} ${target} ${req.headers['user-agent'] || ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      records.push({
        timestamp: new Date().toISOString(),
        method: req.method,
        url: req.url,
        headers: req.headers,
        bodyText: (() => { try { return body.toString('utf-8'); } catch { return null; } })(),
        bodyLength: body.length,
      });
      writeOut();
    }
    // 预检请求给最小合法响应,让 KAS 一路走到 GenerateAssistantResponse
    if (target.endsWith('ListAvailableModels')) {
      return reply(res, { models: [MOCK_MODEL], defaultModel: { modelId: 'auto' } });
    }
    if (target.endsWith('GetProfile')) {
      return reply(res, {
        profile: { arn: 'arn:aws:codewhisperer:us-east-1:000000000000:profile/MOCK', profileName: 'MOCK' },
        arn: 'arn:aws:codewhisperer:us-east-1:000000000000:profile/MOCK',
        profileName: 'MOCK',
      });
    }
    if (target.endsWith('GetFeatureConfiguration')) return reply(res, { configuration: {} });
    if (target.endsWith('InvokeMCP')) {
      let id = 'tools_list';
      try { id = JSON.parse(body.toString('utf-8')).id ?? id; } catch {}
      return reply(res, { id, jsonrpc: '2.0', result: { tools: [] } });
    }
    // 其它请求(GAR 等)返回错误即可，我们只关心请求本身
    reply(res, { __type: 'InternalServerException', message: 'capture-only' }, 500);
  });
});
server.listen(port, '127.0.0.1', () => {
  process.stdout.write('LISTEN\n');
});
NODE_EOF

echo "→ 启动本地捕获服务器 (127.0.0.1:$PORT)"
CAPTURE_FILE="$CAPTURE_FILE" CAPTURE_PORT="$PORT" node "$WORKDIR/server.cjs" > "$WORKDIR/server.log" 2>&1 &
SERVER_PID=$!

# 等捕获服务器就绪
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if grep -q LISTEN "$WORKDIR/server.log" 2>/dev/null; then break; fi
  sleep 0.1
done
if ! grep -q LISTEN "$WORKDIR/server.log" 2>/dev/null; then
  echo "错误: 捕获服务器启动失败，日志:" >&2
  cat "$WORKDIR/server.log" >&2
  exit 1
fi

MOCK_URL="http://127.0.0.1:$PORT"

# ---------------------------------------------------------------------------
# 2) KAS:环境变量把 runtime + control plane 都指向 mock
# ---------------------------------------------------------------------------
# `--model auto` 与 mock 的 MOCK_MODEL 一致:不写则 KAS 用本机 `chat.defaultModel`,fixture 随机器设置漂移
echo "→ 触发 chat --v3 --no-interactive (捕获 KAS 的 GenerateAssistantResponse / InvokeMCP 等)"
(cd "$WORKDIR" && KIRO_KAS_ENDPOINT="$MOCK_URL" KIRO_KAS_CONTROL_PLANE_ENDPOINT="$MOCK_URL" \
  "$KIRO2CLAUDE_CLI_BIN" chat --v3 --no-interactive --model auto --trust-tools= "ping" >/dev/null 2>&1) || true

# ---------------------------------------------------------------------------
# 3) Rust 外壳:临时 settings 覆盖,录它的 UA
# ---------------------------------------------------------------------------
SETTING_VALUE="{\"endpoint\":\"$MOCK_URL\",\"region\":\"us-east-1\"}"
for k in "${ENDPOINT_KEYS[@]}"; do
  if "$KIRO2CLAUDE_CLI_BIN" settings "$k" "$SETTING_VALUE" >/dev/null 2>&1; then
    SET_KEYS+=("$k")
  fi
done
if [[ "${#SET_KEYS[@]}" -gt 0 ]]; then
  echo "→ 触发 profile (捕获 Rust 外壳的 UA)"
  "$KIRO2CLAUDE_CLI_BIN" profile >/dev/null 2>&1 || true
else
  echo "→ 跳过 Rust 外壳捕获(当前 kiro-cli 不接受 endpoint settings),shell UA 走内置兜底"
fi

# 等捕获落盘
sleep 0.5

if [[ ! -s "$CAPTURE_FILE" ]]; then
  echo "错误: 没有捕获到任何请求，检查 kiro-cli 是否能正常启动 --v3" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 4) 规范化生成 profile JSON
# ---------------------------------------------------------------------------
echo "→ 规范化为 profile JSON: $OUT_PATH"


KIRO2CLAUDE_CAPTURE_CWD="$WORKDIR" KIRO2CLAUDE_CAPTURE_HOME="$HOME" \
  node - "$CAPTURE_FILE" "$OUT_PATH" "$KIRO2CLAUDE_CLI_VERSION" <<'NODE_EOF'
const fs = require('fs');
const [,, rawPath, outPath, kiroCliVersion] = process.argv;
const raw = JSON.parse(fs.readFileSync(rawPath, 'utf-8'));

const isKas = (r) => /\baws-sdk-js\//.test(r.headers['user-agent'] || '');
const isShell = (r) => /\baws-sdk-rust\//.test(r.headers['user-agent'] || '');
const find = (pred, suffix) => raw.find((r) => pred(r) && String(r.headers['x-amz-target'] || '').endsWith(suffix));

const gar = find(isKas, '.GenerateAssistantResponse');
const mcp = find(isKas, '.InvokeMCP');
const shellSample = raw.find(isShell);

if (!gar) {
  console.error('错误: 没有捕获到 KAS 的 GenerateAssistantResponse。kiro-cli 可能不支持 --v3,');
  console.error('      或不认 KIRO_KAS_ENDPOINT(需 2.23.1+)。fixture 未写入。');
  process.exit(1);
}

// KAS 的 UA 有两个平台 token:`os/darwin#25.6.0`(Node 的 platform#release)与 kiro-cli 风格的
// `os/macos`,分别抽成 `{jsOs}` / `{os}`,runtime 按实际平台还原。`md/nodejs#…` 是 kiro-cli
// 自带 Node 的版本,不是网关的,原样保留。先替换 `{jsOs}`,否则 `os/linux#…` 会被第二条吞掉。
function templateKasUa(ua) {
  if (!ua) return null;
  return ua
    .replace(/\bos\/(darwin|linux|win32)#[^\s]+/g, 'os/{jsOs}')
    .replace(/\bos\/(macos|linux|windows)\b/g, 'os/{os}');
}

// Rust 外壳的 UA:`api/<service>/<ver>` 的 service 抽成 `{service}`,os 抽成 `{os}`。
function templateShellUa(ua) {
  if (!ua) return null;
  return ua.replace(/api\/[a-z]+\//i, 'api/{service}/').replace(/\bos\/(macos|linux|windows)\b/g, 'os/{os}');
}

const REDACTED_ARN = 'arn:aws:codewhisperer:us-east-1:000000000000:profile/REDACTED';

function redactBody(bodyText) {
  if (!bodyText) return null;
  let body;
  try { body = JSON.parse(bodyText); } catch { return null; }
  const visit = (obj) => {
    if (obj && typeof obj === 'object') {
      for (const k of Object.keys(obj)) {
        if (k === 'profileArn' && typeof obj[k] === 'string') {
          obj[k] = REDACTED_ARN;
        } else if (k === 'clientId' && typeof obj[k] === 'string' && obj[k].length > 10) {
          obj[k] = '00000000-0000-0000-0000-000000000000';
        } else if (k === 'clientToken' && typeof obj[k] === 'string') {
          obj[k] = '00000000-0000-0000-0000-000000000000';
        } else if ((k === 'conversationId' || k === 'rootConversationId') && typeof obj[k] === 'string') {
          obj[k] = obj[k].startsWith('sess_') ? 'sess_00000000-0000-0000-0000-000000000000' : '00000000-0000-0000-0000-000000000000';
        } else if (k === 'agentContinuationId' && typeof obj[k] === 'string') {
          obj[k] = '00000000-0000-0000-0000-000000000000';
        } else if (k === 'content' && typeof obj[k] === 'string') {
          // KAS 注入的时间戳 / 路径每次不同,归一化后重抓不产生无意义 diff
          obj[k] = obj[k].replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})/g, '<captured_at>');
          const cwd = process.env.KIRO2CLAUDE_CAPTURE_CWD;
          if (cwd) obj[k] = obj[k].split(cwd).join('<cwd>');
          const home = process.env.KIRO2CLAUDE_CAPTURE_HOME;
          if (home) obj[k] = obj[k].split(home).join('<home>');
          // 截断过长的 prompt / tool spec 描述，避免 fixture 膨胀
          if (obj[k].length > 200) obj[k] = obj[k].slice(0, 200) + '… <truncated>';
        } else if (k === 'description' && typeof obj[k] === 'string' && obj[k].length > 200) {
          obj[k] = obj[k].slice(0, 200) + '… <truncated>';
        } else if (k === 'tools' && Array.isArray(obj[k])) {
          // KAS 自己的工具定义与网关无关(网关转发客户端的工具),只留名字
          obj[k] = obj[k].map((t) => t?.toolSpecification?.name ?? t?.name ?? '<tool>');
        } else {
          visit(obj[k]);
        }
      }
    }
  };
  visit(body);
  return body;
}

function redactUrl(p) {
  if (!p) return p;
  return p.replace(/profileArn=[^&]+/g, 'profileArn=arn%3Aaws%3Acodewhisperer%3Aus-east-1%3A000000000000%3Aprofile%2FREDACTED');
}

// 重试三件套：值随 attempt 变，抓包时点不同就抓到不同的值，进 fixture 只会制造无谓
// 的 diff churn 并诱人「照 fixture 改代码」。owner 与格式证据在 `applyRetryHeaders`
// （packages/core/src/kiro/retry-executor.ts）——加成员时两处同改。
const RETRY_HEADERS = new Set(['amz-sdk-invocation-id', 'amz-sdk-request', 'x-kiro-attempt']);
// 每请求变化或由网关按请求填写的头,不进静态头
const DYNAMIC_HEADERS = new Set(['authorization', 'host', 'content-length', 'x-amz-target', 'user-agent', 'x-amz-user-agent']);

function redactHeaders(h, templateUa) {
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    if (k === 'authorization' || k === 'host' || k === 'content-length' || RETRY_HEADERS.has(k)) continue;
    if (k === 'x-amzn-codewhisperer-optout') {
      // 项目隐私硬约束:始终 opt-out,不随抓包机的 telemetry 设置漂移
      out[k] = 'true';
    } else if ((k === 'user-agent' || k === 'x-amz-user-agent') && typeof v === 'string') {
      out[k] = templateUa(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** 静态头:抓包里除动态头与重试头以外的全部头,optout 一律强制 'true'。 */
function staticHeadersOf(sample) {
  const out = {};
  for (const [k, v] of Object.entries(sample.headers)) {
    if (DYNAMIC_HEADERS.has(k) || RETRY_HEADERS.has(k)) continue;
    out[k] = v;
  }
  // 隐私硬约束:staticHeaders 会原样塞进网关发往上游的每个请求,强制 opt-out 训练
  out['x-amzn-codewhisperer-optout'] = 'true';
  return out;
}

const garBody = redactBody(gar.bodyText) || {};
const cs = garBody.conversationState || {};
const uim = (cs.currentMessage && cs.currentMessage.userInputMessage) || {};

const kasTargets = {};
for (const r of raw.filter(isKas)) {
  const t = String(r.headers['x-amz-target'] || '');
  const op = t.split('.').pop();
  if (!op) continue;
  const key = op.charAt(0).toLowerCase() + op.slice(1);
  if (key === 'invokeMCP') kasTargets.invokeMcp = t;
  else kasTargets[key] = t;
}

// 稳定化输出:递归按 key 排序;samples 按 (UA 家族, target, method, urlPath) 排序;
// 不写 capturedAt,相同输入产出相同 JSON。
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeys(value[k]);
    return out;
  }
  return value;
}

const samples = raw
  .map((r) => ({
    engine: isKas(r) ? 'kas' : isShell(r) ? 'shell' : 'unknown',
    target: r.headers['x-amz-target'] || null,
    method: r.method,
    urlPath: redactUrl(r.url),
    headers: redactHeaders(r.headers, isKas(r) ? templateKasUa : templateShellUa),
    body: redactBody(r.bodyText),
  }))
  .sort((a, b) => {
    const ka = `${a.engine}\u0000${a.target || ''}\u0000${a.method}\u0000${a.urlPath || ''}`;
    const kb = `${b.engine}\u0000${b.target || ''}\u0000${b.method}\u0000${b.urlPath || ''}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

const profile = {
  kiroCliVersion,
  note: [
    'Generated by scripts/capture-kiro-cli.sh from a real local kiro-cli instance (chat --v3).',
    'kas = requests sent by the KAS agent process (GenerateAssistantResponse / InvokeMCP); shell = the Rust CLI shell.',
    'Sensitive fields (Authorization / profileArn / cwd / clientId / conversation ids) have been redacted.',
    'All objects sorted by key alphabetically; samples sorted by (engine, target, method, urlPath). Identical input produces identical JSON.',
  ],
  kas: {
    staticHeaders: staticHeadersOf(gar),
    ...(mcp ? { mcpStaticHeaders: staticHeadersOf(mcp) } : {}),
    userAgent: templateKasUa(gar.headers['user-agent']),
    xAmzUserAgent: templateKasUa(gar.headers['x-amz-user-agent']),
    amzTargets: kasTargets,
    body: {
      origin: uim.origin,
      agentMode: garBody.agentMode,
      agentTaskType: cs.agentTaskType,
      chatTriggerType: cs.chatTriggerType,
    },
  },
  ...(shellSample
    ? {
        shell: {
          staticHeaders: staticHeadersOf(shellSample),
          userAgent: templateShellUa(shellSample.headers['user-agent']),
          xAmzUserAgent: templateShellUa(shellSample.headers['x-amz-user-agent']),
        },
      }
    : {}),
  samples,
};

fs.writeFileSync(outPath, JSON.stringify(sortKeys(profile), null, 2) + '\n');
console.log(`✓ 写入 ${outPath}`);
console.log(`  kiroCliVersion  : ${kiroCliVersion}`);
console.log(`  kas user-agent  : ${profile.kas.userAgent}`);
console.log(`  kas targets     : ${Object.values(profile.kas.amzTargets).join(', ')}`);
console.log(`  kas body        : ${JSON.stringify(profile.kas.body)}`);
console.log(`  shell user-agent: ${profile.shell ? profile.shell.userAgent : '(未捕获,走内置兜底)'}`);
NODE_EOF

echo "→ 完成。fixture 是 kiro-cli 版本号的唯一真相源。"
echo "  下一步："
echo "    git diff fixtures/kiro-cli-profile.json   # 检视改动"
echo "    pnpm docker:build -- -t kiro2claude  # 验证新版本能 build"
echo "    git add fixtures/ && git commit"
