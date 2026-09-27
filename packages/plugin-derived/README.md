# plugin-derived

> **first-party runtime plugin**(作为 `@kiro2claude/core` 的依赖随镜像默认启用):通过 [`@kiro2claude/plugin-api`](../plugin-api/) 接入 core gateway,把 Kiro 原始 credit 反演成 Anthropic 风格的 token 拆分。plugin 名(`derived`)与注入的 wire 字段(`usage.kiro_derived`)一致。

## 解决什么问题

Kiro 上游 `meteringUsage` 只给一个聚合 credit 数,缺失下游 Anthropic 客户端期望的 `cache_creation_input_tokens` / `cache_read_input_tokens` 拆分。本 plugin 在 `onUsageFinish` hook 里读 `'kiro.creditsUsed'` meta key,基于回归拟合常数(`KIRO_K_IN` / `KIRO_K_OUT`)反演 cache 字段,通过 `overrideStandardField` 或 `addExtension('kiro_derived', ...)` 注入。

### GPT-5.6 系列(独立反演,成本锚定 credit)

GPT-5.6(sol/terra/luna 及 Codex 别名)走 `deriveKiroUsage` 顶部的**专属分支**,用自己的计费公式反演缓存:

```
credits = 倍率 × [ GPT_K_IN · (未命中 + 0.1 · 命中) + GPT_K_OUT · 输出 ]
```

2026-09 直打标定:缓存价恰为冷价的 0.1×、命中 = 同 conversationId 里此前请求的前缀、换 conversationId 不命中;倍率即上游 rateMultiplier(sol 4.4 / terra 2.2 / luna 1.1)。隐藏的推理 token 无法观测,按 0 解,推理只会让 `cache_read` **低估**;可见输出由 core 估算,估多 Δ 会虚报约 6.3Δ(2026-09-24 端到端验收见 docs/PITFALLS.md「GPT credit 锚定与缓存反演」);`cache_creation` 恒 0(OpenAI 缓存没有写入溢价)。成本不按单价重算,仍锚定 `credits × KIRO_OVERAGE_RATE`(× multiplier),`derivedStatus = 'gpt_credit_anchored'`。**切勿给 GPT 填 `CLAUDE_PRICE_USD_PER_TOK`**——Claude 的系数与缓存比例和 GPT 不同。常数与证据见 `src/derive.ts` 的 `gptCacheDerivedBreakdown` 头注释。

## 依赖

无 `dependsOn`。反演只读 host 注入的 `'kiro.creditsUsed'` meta key(任何路径都存在),不依赖 `metering` 插件的 wire 输出,故与 metering 的加载顺序无关。

## 关键真相源

| 想看 | 文件 |
|---|---|
| KiroPlugin manifest + hook 注册 | `src/index.ts` |
| 反演公式 / 数学常数 `KIRO_K_IN` `KIRO_K_OUT` `KIRO_CACHE_READ_RATIO` | `src/derive.ts` |
| 成本倍率(`KIRO2CLAUDE_COST_MULTIPLIER`)数学边界 + 不亏公式推导 | [`docs/cost-multiplier.md`](./docs/cost-multiplier.md) |

## markup 入口

```bash
KIRO2CLAUDE_COST_MULTIPLIER=1.0   # 默认;客户看到 = Anthropic 公示价
# 0.67 = 任意请求形态数学上不亏(详见 docs/cost-multiplier.md §3)

# cache 反演比例旋钮:未设 = 测量默认 0.5276。调高 → 展示 cache_read 变大 +
# 下游成本变低;只接受 [0,1),聚合封顶 ~87.7%(详见 docs/cost-multiplier.md §「cache 比例旋钮」)
#KIRO2CLAUDE_CACHE_READ_RATIO=0.5276
```

## 测试

```bash
pnpm --filter @kiro2claude/plugin-derived test
```
