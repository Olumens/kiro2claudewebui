# 手工探针与检测器

非 CI、vitest 不收(唯一例外 `live-conversation-provider.test.ts`,见表)。标 💰 的打真实上游会计费,其余零上游。默认测试模型统一 `claude-opus-5`(读 `_harness.mjs` 的 `CLAUDE_MODEL`)。跑完打真实上游或起本地服务器的脚本要 `pkill` 掉 tsx 子进程,kill pnpm 包装进程杀不掉它,旧代码会继续占端口。

| 脚本 | 用途 |
|---|---|
| `_harness.mjs` | 所有脚本共用:env / 发请求 / 解 SSE / 号段校验 / **两套协议不变量** / 汇总退出码。新脚本从这里拿,别各写一份缩水的不变量集 |
| `_real-provider.ts` / `_marker-png.mjs` | 共用件:直打上游的探针从前者拿 provider + token manager(读仓库根 `.env` 与 kiro-cli 凭据);后者生成确定性 5×7 点阵数字图,图片探针共用 |
| `kiro-cli-capture-proxy.mjs` 💰 | 转发型录制代理:kiro-cli `chat --v3`(`KIRO_KAS_ENDPOINT` / `KIRO_KAS_CONTROL_PLANE_ENDPOINT` 指过来,2.23.1+ 非交互也认)→ 本机端口 → 真实上游,请求脱敏、响应原始字节 + 解码帧落盘;看上游怎么回、下一轮 history 怎么回传。V2 三个 endpoint setting 仍可用于对照 |
| `reasoning-roundtrip-live.mjs` 💰 | 走网关的原生 reasoning 验收:签名回传 / 坏签名剥离重试 / `display: omitted` / effort 计费 / GPT·sonnet-4.6 / 流式不变量;改 thinking·effort 相关 converter **必跑** |
| `reasoning-wire-probe.ts` 💰 | 直打上游:effort 放法 × thinking disabled/omitted × 顶层 systemPrompt × history `reasoningContent` 正常/坏签名/无签名(body 取 profile 的 KAS 形态);`K2C_PROBE_ONLY` 挑场景、`K2C_PROBE_PROMPT` 换题 |
| `kiro-cli-probe.ts` | 反向驱动真实 kiro-cli:伪造 event-stream 让它执行工具、注入错误码看重试策略、`PROBE_STREAM_SHAPE=text-eof` 看它对无尾帧 EOF 的处理 |
| `protocol-integrity.mjs` / `backpressure-integrity.mjs` / `concurrency-integrity.mjs` | 流式完整性三件套:确定性序列 + 协议不变量(block start/stop 配对、`message_delta` 恰一次、Responses `sequence_number` 无洞、done 回填 == delta 累积)/ 慢客户端背压下终结段是否完整 / 并发号段隔离(混入外区间数字即串扰) |
| `opus5-effort-matrix.mjs` 💰 / `gpt-tool-matrix.mjs` 💰 | 手工点验矩阵:Opus 5 走 Messages(effort × tools/images/search);GPT 工具往返(effort × 协议 × 流/非流,可选图片)。不重试,失败原样留在报告里(前者 `K2C_REPORT_DIR`,后者 `K2C_REPORT`) |
| `conversation-fault-server.ts` | 会话完整性故障服务器:真实网关转换/传输 + 脚本化上游,只按历史里的工具回执推进、按场景注入故障(`text-eof-once` 等);`live-*` 场景经 `_live-conversation-provider.ts` 打真实上游 💰;它的离线单测 `live-conversation-provider.test.ts` 不打上游、会被 vitest 收进 `pnpm test` |
| `claude-conversation-probe.mjs` / `codex-conversation-probe.mjs` | 真实 CLI 三轮持久会话 + Docker 工作区文件任务,独立验收(`_conversation-workspace.mjs`) |
| `empty-cli-server.ts` + `claude-empty-probe.mjs` / `codex-empty-probe.mjs` | 空响应 9 场景 × 两款真实 CLI |
| `live-coding-conversation.mjs` 💰 / `codex-live-coding-conversation.mjs` 💰 | 真实模型三轮编码会话;预算默认 65 次上游调用,`K2C_LIVE_MAX_CALLS` 可放宽(opus-5 三阶段 ~75+、Codex ~46);oracle `_live-coding-workspace.mjs`,服务器即 `conversation-fault-server.ts`(`K2C_CONVERSATION_PORT=18943`) |
| `claude-unicode-input-probe.mjs` | 客户端侧 Unicode 转义改写复现(本地假 Anthropic 服务);结论见 README「已知限制」 |
| `multi-image-attribution-probe.mjs` 💰 / `multi-image-cli-probe.mjs` 💰 | 多图归属:API 直打(反序回执 / 交错标签 / 相同图计数)/ Docker 真 CLI 读 N 张数字图按文件判分,错误分归属错位 / OCR 误读 |
| `replay-conversation-history.ts` / `audit-conversation-fixes.mjs` | 不调模型:重放录得请求验证历史保留 / 审计探针产物 |
| `replay-content-preservation.ts` | 不调模型:录得的 5923 条真实 Claude Code 请求过一遍**当前** convertRequest,核对客户端文本是否上 wire、`role:system` 插入落点、history 形态。**改 converter 必跑** |
| `session-isolation-live.mjs` 💰 | 同一 `prompt_cache_key` 下全新会话不串、同键第二轮命中缓存、GPT / Claude 推理信封回传上游照收;见 PITFALLS「会话身份映射到 kiro-cli」 |
| `session-concurrency-live.mjs` 💰 | 同一会话键下并发在途的串话检测:Messages(Claude Code 形态含 `x-claude-code-agent-id` subagent)/ Chat / Responses(Codex 子线程)四组同时开跑,埋暗号、问回、新对话同时在途 |
| `cache-scope-probe.ts` 💰 | 直打上游,用 credits 反推缓存作用域:同 id 交替多段对话 / 插旁路请求 / 换 id / acid 相撞时是否命中;GPT 与 Claude 分别跑(`K2C_MODEL`) |
| `inserted-content-live.mjs` 💰 | 中途插入内容的 7 种客户端形态各埋一个 nonce 打真实上游,看回复是否含 nonce |
| `codex-subagent-{probe,lifecycle}-server.ts` | Codex multi-agent v2 信封与生命周期矩阵;见 `docs/PITFALLS.md`「Codex code mode」 |
