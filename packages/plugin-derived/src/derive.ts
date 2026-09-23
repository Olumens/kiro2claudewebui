/**
 * Reverse-engineer Kiro `meteringEvent.usage` (credits) into the standard
 * Anthropic Claude API cache usage shape.
 *
 * Closed-form formula fitted offline from credit-calibration data:
 *
 *     credits ≈ (k_in · P_in · T_eff + k_out · P_out · T_out) / overage_rate
 *     T_eff   = T_nonread + KIRO_CACHE_READ_RATIO · T_cache_read
 *
 * with k_in = 0.0556, k_out = 0.6705 fitted on Opus 4.5/4.6 cache-miss data
 * (R²=0.9999).
 *
 * Two DISTINCT cache economics live in this file — do not conflate them:
 * the credits equation (and therefore the INVERSION divisor) uses Kiro's
 * own cache-hit price ratio (KIRO_CACHE_READ_RATIO — value, provenance and
 * refit guidance live in its jsdoc), while the Anthropic public cache
 * prices in CLAUDE_PRICE_USD_PER_TOK are used ONLY to price the derived
 * breakdown into `claudeEquivalentCostUsd`.
 *
 * Given (model, input_tokens_total, output_tokens, credits) we solve for
 * `T_eff_in` (the "uncached-equivalent" input volume), then compare with
 * the upstream-reported total to attribute the difference as cache_read.
 * cache_creation vs uncached split: measured against real Claude Code via
 * `claude -p` + raw request capture (genuine Anthropic
 * usage) — the non-read remainder is written to cache (cache_creation) except a
 * small fixed input tail (CLAUDE_CODE_INPUT_TAIL_TOKENS ~10, constant structural
 * framing, not user content). This holds for both cold start (cacheRead=0 → all
 * creation) and steady state (large cacheRead → small creation): the main path
 * attributes `input = min(nonRead, tail)` and the rest → cache_creation; only
 * `below_threshold` (whole prompt too small to cache) stays pure input.
 * Kiro shows no separate cache-WRITE premium — UUID-clean first sends sit
 * on the plain k_in line — so writes need no extra term in the inversion.
 *
 * The Anthropic protocol identity
 *     input_tokens + cache_creation_input_tokens + cache_read_input_tokens
 *       == upstream input_tokens (`inputTokensTotal`)
 * holds for every status.
 *
 * Multi-instance note: like metering-counter, the cost multiplier is a
 * module-level singleton initialized once at startup. There's no shared
 * state across requests, so concurrent calls are safe.
 */

// ============================================================================
// Tunable constants (fitted offline from credit-calibration data)
// ============================================================================

export const KIRO_K_IN = 0.0556;
export const KIRO_K_OUT = 0.6705;
export const KIRO_OVERAGE_RATE = 0.04;
/**
 * Kiro's cached-input price as a fraction of its own miss price — the
 * inversion divisor is (1 - this). Measured from same-prompt resend
 * probes: round6 2026-07-02 opus-4.8 @37k = 0.52758 (two independent
 * anchor pairs, bit-reproducible) and sonnet-4.5 @24.6k = 0.52822;
 * round2/round5 2026-04 sonnet-4.5 @17.7k = 0.5264. Constant pinned to
 * the opus anchor (0.5276) — opus dominates typical traffic and is
 * the only deterministic multi-anchor measurement. NOT the Anthropic
 * 0.1× cache-read price — using that here caps the derivable hit ratio
 * at ~52%, so derived cache ratios plateau around 30% on real (~99%
 * cached) traffic.
 *
 * Probe scripts + raw data live outside this repo (offline calibration
 * dataset, not shipped) — rerun those to refit if upstream changes its
 * cache discount (symptom: estimatedCacheHitRatio drifts and true
 * full-hit resends stop deriving ~1.0).
 *
 * Known residual: haiku is billed well below the global k_in line (its
 * round6 miss anchors already derive 0.66-0.89 hit ratios), so haiku
 * requests over-attribute cache. The round6 2-point per-model solve was
 * adversarially audited as ill-conditioned (anchors self-contradictory,
 * ×22.8 error amplification) — do NOT add haiku constants without a
 * dedicated byte-stable grid with a large output-tokens lever.
 *
 * This is the MEASURED default. It can be overridden at runtime via the
 * `KIRO2CLAUDE_CACHE_READ_RATIO` env (see index.ts → `initCacheReadRatio`),
 * but that is a deliberate DISPLAY/POLICY knob, NOT a recalibration:
 * raising it inflates the reported `cache_read` split (and lowers
 * `claudeEquivalentCostUsd`, since cache_read prices at 0.1×), diverging the
 * wire numbers from what upstream actually billed. It cannot exceed the real
 * aggregate ceiling (~87.7% on typical traffic — cold-start input can
 * never enter the cache_read numerator), and values ≥1 are rejected
 * (divisor `1 - ratio` would hit zero / go negative). Leave it unset to keep
 * the faithful, measurement-backed inversion.
 */
export const KIRO_CACHE_READ_RATIO = 0.5276;

// ============================================================================
// Claude API public pricing (USD per token)
// ============================================================================

interface ClaudePrice {
  in: number;
  out: number;
  cacheRead: number;
  cacheCreation: number;
}

const CLAUDE_PRICE_USD_PER_TOK: Record<string, ClaudePrice> = {
  'claude-haiku-4-5': {
    in: 1e-6,
    out: 5e-6,
    cacheRead: 0.1e-6,
    cacheCreation: 1.25e-6,
  },
  'claude-sonnet-4-5': {
    in: 3e-6,
    out: 15e-6,
    cacheRead: 0.3e-6,
    cacheCreation: 3.75e-6,
  },
  'claude-sonnet-4-6': {
    in: 3e-6,
    out: 15e-6,
    cacheRead: 0.3e-6,
    cacheCreation: 3.75e-6,
  },
  // 标准价 $3/$15;促销价 $2/$10 截至 2026-08-31,静态表按标准价避免到期后失真
  'claude-sonnet-5': {
    in: 3e-6,
    out: 15e-6,
    cacheRead: 0.3e-6,
    cacheCreation: 3.75e-6,
  },
  'claude-opus-4-5': {
    in: 5e-6,
    out: 25e-6,
    cacheRead: 0.5e-6,
    cacheCreation: 6.25e-6,
  },
  'claude-opus-4-6': {
    in: 5e-6,
    out: 25e-6,
    cacheRead: 0.5e-6,
    cacheCreation: 6.25e-6,
  },
  'claude-opus-4-7': {
    in: 5e-6,
    out: 25e-6,
    cacheRead: 0.5e-6,
    cacheCreation: 6.25e-6,
  },
  'claude-opus-4-8': {
    in: 5e-6,
    out: 25e-6,
    cacheRead: 0.5e-6,
    cacheCreation: 6.25e-6,
  },
  // Opus 5 单价与 Opus 4.8 逐项相同（platform.claude.com/pricing 实测）。key 用
  // dash-form 'claude-opus-5'：上游 modelId 本就无小数点，normalizeModelId 对
  // 'claude-opus-5' / 'claude-opus-5-thinking' 归一到此 key（-5 尾不被当日期）。
  'claude-opus-5': {
    in: 5e-6,
    out: 25e-6,
    cacheRead: 0.5e-6,
    cacheCreation: 6.25e-6,
  },
  // claude-fable-5-1 故意不列:Kiro 标 6x,偏离上面各模型「倍率 / 输入单价 ≈ 0.44」的线,
  // 按标价反演会低估 cache_read,故走 unknown_model 透传;要反演须先用真实 credit 标定。
};

/** Anthropic 最小可缓存前缀(prompt-caching 文档,各平台一致);随代际不单调。 */
const MODEL_CACHE_THRESHOLD: Record<string, number> = {
  'claude-haiku-4-5': 4096,
  'claude-sonnet-4-5': 1024,
  'claude-sonnet-4-6': 1024,
  'claude-sonnet-5': 1024,
  'claude-opus-4-5': 4096,
  'claude-opus-4-6': 4096,
  'claude-opus-4-7': 2048,
  'claude-opus-4-8': 1024,
  'claude-opus-5': 512,
};

/**
 * Fixed `input_tokens` tail kept on the main (cacheable) path. Captured from
 * real Claude Code (claude -p + raw request capture): Claude
 * Code puts its last `cache_control` breakpoint on the FINAL message block, so no
 * user content falls outside the cache — yet Anthropic still reports a small,
 * CONSTANT `input_tokens` (~10, independent of prompt size: a 1-token "hi" and a
 * 40k-token prompt both bill input_tokens=10). It is per-request structural/turn
 * framing, not user content. We attribute `input = min(nonRead, this)` and put
 * the rest on cache_creation, so the wire mirrors real Claude Code instead of a
 * bare 0. Model-independent (framing, not content); credits can't recover it
 * anyway (input and creation are same-priced in Kiro), so this is a display knob.
 */
const CLAUDE_CODE_INPUT_TAIL_TOKENS = 10;

// ============================================================================
// Public types
// ============================================================================

export type DerivedStatus =
  | 'unknown_model'
  | 'below_threshold'
  | 'ok_derived'
  // GPT-5.6 分支(sol/terra/luna 及 Codex 别名):成本锚定 credits,缓存由 credits 反演;
  // 下游可能已依赖这个取值,勿改名。含义见 `gptCacheDerivedBreakdown` 头注释。
  | 'gpt_credit_anchored';

/** Metadata sub-object attached as `usage.kiro_derived` on responses. */
export interface KiroDerivedMetadata {
  inputTokensTotal: number;
  estimatedCacheHitRatio: number;
  claudeEquivalentCostUsd: number;
  finalCostUsd: number;
  costMultiplier: number;
  derivedStatus: DerivedStatus;
  /**
   * True when the per-request upstream cost floor (`credits × KIRO_OVERAGE_RATE`)
   * exceeded `claudeEquivalentCostUsd × multiplier` and was used as `finalCostUsd`.
   * Always false when `multiplier === 0` (explicit free-tier bypass).
   */
  floorApplied: boolean;
}

/**
 * The full breakdown returned by `deriveKiroUsage`. The handler reads
 * `inputTokens` / `cacheCreationInputTokens` / `cacheReadInputTokens` to
 * fill the top-level Anthropic-protocol `usage` fields, and attaches
 * `derived` as the `kiro_derived` sub-object.
 */
export interface DerivedUsageBreakdown {
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  derived: KiroDerivedMetadata;
}

// ============================================================================
// Module-level singleton: cost multiplier
// ============================================================================

let _multiplier = 1.0;

/**
 * Effective cache-read price ratio used as the inversion divisor `(1 - this)`.
 * Defaults to the MEASURED constant; overridable via `initCacheReadRatio`
 * (env `KIRO2CLAUDE_CACHE_READ_RATIO`) as an explicit display/policy knob.
 */
let _cacheReadRatio = KIRO_CACHE_READ_RATIO;

/**
 * Set the cost multiplier — the single gate for its range. Accepts `[0, 1000]`;
 * non-finite / negative / `>1000` are rejected (returns `false`), leaving the
 * current value in place. Returns whether the value was applied so the env-layer
 * caller can log the *effective* outcome without re-encoding the bound.
 * `multiplier === 0` is an explicit free-tier bypass (see `applyFloor`).
 */
export function initCreditDerive(multiplier: number): boolean {
  if (!Number.isFinite(multiplier) || multiplier < 0 || multiplier > 1000) {
    return false;
  }
  _multiplier = multiplier;
  return true;
}

/**
 * Override the cache-read price ratio (inversion divisor). This is the single
 * gate for the `[0, 1)` invariant: `≥1` (divisor `1 - ratio` → 0 / negative)
 * and negatives are rejected, leaving the measured default in place. Returns
 * whether the override was applied so the env-layer caller can log the outcome
 * (structured, through its own logger) without re-encoding the bound. A
 * deliberate display/policy knob — see the `KIRO_CACHE_READ_RATIO` jsdoc for
 * the trade-offs (inflated cache_read, lowered claudeEquivalentCostUsd, ~87.7%
 * aggregate ceiling).
 */
export function initCacheReadRatio(ratio: number): boolean {
  if (!Number.isFinite(ratio) || ratio < 0 || ratio >= 1) {
    return false;
  }
  _cacheReadRatio = ratio;
  return true;
}

export function resetCreditDerive(): void {
  _multiplier = 1.0;
  _cacheReadRatio = KIRO_CACHE_READ_RATIO;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Collapse model-id variants to one price-table key — the single place that
 * defines the key space, so the exported API and the wire path canonicalize
 * identically. The priced model is the raw wire model the client sent (handlers
 * pass `payload.model` through), so it can be an alias (`claude-haiku-4-5`), a
 * dated snapshot (`claude-haiku-4-5-20251001`, advertised in models-catalog), a
 * dot-form id (`claude-opus-4.6`, if a client sends one), or a `-thinking`
 * variant. Normalize non-leading dots to dashes, strip `-thinking`, then strip a
 * trailing `-20YYMMDD` snapshot date — anchored to a `20xx` year so an arbitrary
 * 8-digit tail (e.g. `-12345678`) is NOT mistaken for a date — so all of them map
 * to the undated dash-form key. (Alias `-4-5`/`-5` tails aren't dates → kept.)
 */
function normalizeModelId(model: string): string {
  // Dot-form → dash-form: a client may send 'claude-opus-4.6' but the table is
  // keyed dash-form. (Kiro's own dot-form mapModel output never reaches here —
  // the plugin is fed the raw client `payload.model`, so this is a defensive
  // guard, not a coupling to mapModel.)
  const dashed = model.replace(/(?<=\w)\.(?=\w)/g, '-');
  const noThinking = dashed.endsWith('-thinking') ? dashed.slice(0, -'-thinking'.length) : dashed;
  return noThinking.replace(/-20\d{6}$/, '');
}

/**
 * GPT 判别 + 变体(决定上游倍率)—— 与 core `mapModel` 的 GPT 分支**同规则**(`includes('gpt')` + 变体
 * token sol/terra/luna/codex),而非宽泛的 `startsWith('gpt')`。理由:`mapModel` 用
 * `includes` 路由,故 provider 前缀(`openai/gpt-5.6-sol`)、前后空格也会被映射到 GPT
 * 上游、按 GPT 真实计费;若这里用 `startsWith` 会漏判它们 → 误落 Claude 价格表 →
 * `unknown_model`,在 markup(μ>1)下少收费。反之 `gpt-opus`(被 `mapModel` 路由到
 * Claude Opus)不含变体 token → 不误命中。plugin 不能 import core,故复制判定 token
 * ——新增 GPT 变体时需与 `converter.ts` 的 `mapModel` 同步。大小写由 `toLowerCase` 兜。
 * 判定顺序同 `mapModel`:sol → terra → luna → codex 别名归 sol。
 */
function gptVariant(model: string): keyof typeof GPT_RATE_MULTIPLIER | undefined {
  const lower = model.toLowerCase();
  if (!lower.includes('gpt')) return undefined;
  if (lower.includes('sol')) return 'sol';
  if (lower.includes('terra')) return 'terra';
  if (lower.includes('luna')) return 'luna';
  if (lower.includes('codex')) return 'sol';
  return undefined;
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

/**
 * Apply the per-request upstream cost floor: `finalUsd` never falls below
 * `credits × KIRO_OVERAGE_RATE`. Setting `multiplier === 0` is treated as an
 * explicit free-tier bypass (no floor applied).
 */
function applyFloor(
  claudeUsd: number,
  credits: number,
): {
  finalUsd: number;
  floorApplied: boolean;
} {
  if (_multiplier === 0) {
    return { finalUsd: 0, floorApplied: false };
  }
  const algoUsd = claudeUsd * _multiplier;
  const floorUsd = credits * KIRO_OVERAGE_RATE;
  if (floorUsd > algoUsd) {
    return { finalUsd: floorUsd, floorApplied: true };
  }
  return { finalUsd: algoUsd, floorApplied: false };
}

function passthroughBreakdown(
  inputTokensTotal: number,
  outputTokens: number,
  credits: number,
  cp: ClaudePrice | undefined,
  status: DerivedStatus,
): DerivedUsageBreakdown {
  const claudeUsd = cp == null ? 0 : inputTokensTotal * cp.in + outputTokens * cp.out;
  const { finalUsd, floorApplied } = applyFloor(claudeUsd, credits);
  return {
    inputTokens: inputTokensTotal,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    derived: {
      inputTokensTotal,
      estimatedCacheHitRatio: 0,
      claudeEquivalentCostUsd: claudeUsd,
      finalCostUsd: finalUsd,
      costMultiplier: _multiplier,
      derivedStatus: status,
      floorApplied,
    },
  };
}

// ============================================================================
// GPT-5.6 pricing (fitted 2026-09 against the KiroRuntimeService target)
// ============================================================================

/**
 * GPT 的 credit 公式(2026-09-23 直打标定,effort=none + 单词输出压掉推理与输出):
 *
 *     credits = 倍率 × [ GPT_K_IN · (未命中 + GPT_CACHE_READ_RATIO · 命中) + GPT_K_OUT · 输出 ]
 *
 * - luna 冷请求 13.6K / 25.7K / 49.8K / 98.0K token 四点共线,斜率 ÷ 1.1 = GPT_K_IN;sol / terra
 *   逐点等于 luna × 4 / × 2,即上游 `rateMultiplier`(4.4 / 2.2 / 1.1)。
 * - 同 conversationId 重发:斜率恰为冷价的 1/10 → 缓存价 0.1×(OpenAI 公开折扣),命中 = 同会话
 *   此前请求的前缀,只差约 7 token 的固定尾巴。**换 conversationId 完全不命中**,每请求
 *   随机 id 测不出任何缓存。
 * - 输出:数到 100 / 400 / 1600 的差分,GPT_K_OUT / GPT_K_IN = 6.66(公开价 $1.5 / $10 同比)。
 * - `kiro.inputTokens`(contextUsage × 窗口)**含本次输出**(可见 + 推理),所有模型都如此。
 */
const GPT_K_IN = 1.6584e-5;
const GPT_K_OUT = 1.1048e-4;
const GPT_CACHE_READ_RATIO = 0.1;
/** 上游 `ListAvailableModels` 的 rateMultiplier;新增 GPT 变体时与 core `mapModel` 同改。 */
const GPT_RATE_MULTIPLIER = { sol: 4.4, terra: 2.2, luna: 1.1 } as const;

/**
 * GPT-5.6 系列:由 credits 反演缓存命中,成本仍锚定 credits×0.04。
 *
 * 已知 T = `kiro.inputTokens`(含输出)、v = 可见输出估计、credits;未知命中 C 与隐藏推理 h。
 * 按 h = 0 解:
 *
 *     C = (GPT_K_IN · (T − v) + GPT_K_OUT · v − credits / 倍率) / ((1 − 0.1) · GPT_K_IN)
 *
 * 截到 `[0, T − v]`。推理把真实 credits 抬高 → 这里把它当成未命中输入 → C 只会**低估**,
 * 不会虚报命中。Codex 长会话回放:effort=low 命中 95.9–99.6%、high 85.5–97.8%(同会话上一请求
 * 总量为近似真值),首个冷请求反演 ≈ 0。
 *
 * 上报沿用 Claude 路径的恒等式 `input + cache_creation + cache_read == T`:OpenAI 的缓存没有
 * 写入溢价,cache_creation 恒 0,未命中部分(含输出)记 input。成本不按单价重算:credits 本身
 * 就是上游账单,`claudeEquivalentCostUsd` 锚定 credits × KIRO_OVERAGE_RATE。
 *
 * ⚠ 绝不要给 GPT 填 `CLAUDE_PRICE_USD_PER_TOK`:Claude 的 k_in / 缓存比例与 GPT 不同,走标准
 * 反演会把 GPT 的 credits 拆错。`gptVariant` 在价格表查询前分流正是这道防线。
 */
function gptCacheDerivedBreakdown(
  variant: keyof typeof GPT_RATE_MULTIPLIER,
  inputTokensTotal: number,
  outputTokens: number,
  credits: number,
): DerivedUsageBreakdown {
  const total = Math.max(0, inputTokensTotal);
  const visibleOut = clamp(outputTokens, 0, total);
  const mult = GPT_RATE_MULTIPLIER[variant];
  const promptTokens = total - visibleOut;
  const raw =
    (GPT_K_IN * promptTokens + GPT_K_OUT * visibleOut - credits / mult) /
    ((1 - GPT_CACHE_READ_RATIO) * GPT_K_IN);
  const cacheRead = clamp(Math.round(raw), 0, promptTokens);

  const anchoredUsd = credits * KIRO_OVERAGE_RATE;
  // 复用 applyFloor,与 Claude 路径同一套 floor 语义:μ=0 free-tier 归零;μ<1 时
  // anchoredUsd×μ 会跌破上游成本地板 credits×0.04,floor 兜住(运营商不亏)。
  const { finalUsd, floorApplied } = applyFloor(anchoredUsd, credits);
  return {
    inputTokens: total - cacheRead,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: cacheRead,
    derived: {
      inputTokensTotal: total,
      estimatedCacheHitRatio: total > 0 ? cacheRead / total : 0,
      claudeEquivalentCostUsd: anchoredUsd,
      finalCostUsd: finalUsd,
      costMultiplier: _multiplier,
      derivedStatus: 'gpt_credit_anchored',
      floorApplied,
    },
  };
}

// ============================================================================
// Main reverse-engineering function
// ============================================================================

export function deriveKiroUsage(
  model: string,
  inputTokensTotal: number,
  outputTokens: number,
  credits: number,
): DerivedUsageBreakdown {
  const normalizedModel = normalizeModelId(model);

  // GPT-5.6 系列:专属反演分支。必须在价格表查询**之前**分流——GPT 的计价与缓存比例
  // 与 Claude 不同(见 `gptCacheDerivedBreakdown`),也为拦住"误填 GPT 价格表"导致的误拆。
  // 判别用**原始** model(与 mapModel 对齐,兼容 provider 前缀 / 空格);normalizeModelId
  // 只服务下面的价格表 key。
  const variant = gptVariant(model);
  if (variant) {
    return gptCacheDerivedBreakdown(variant, inputTokensTotal, outputTokens, credits);
  }

  const cp = CLAUDE_PRICE_USD_PER_TOK[normalizedModel];

  if (cp == null) {
    return passthroughBreakdown(
      inputTokensTotal,
      outputTokens,
      credits,
      undefined,
      'unknown_model',
    );
  }

  if (inputTokensTotal <= 0) {
    return passthroughBreakdown(0, outputTokens, credits, cp, 'below_threshold');
  }

  const threshold = MODEL_CACHE_THRESHOLD[normalizedModel] ?? 1024;
  if (inputTokensTotal < threshold) {
    return passthroughBreakdown(inputTokensTotal, outputTokens, credits, cp, 'below_threshold');
  }

  // Step 2: invert credits → effective uncached input
  const kiroUsd = credits * KIRO_OVERAGE_RATE;
  const kiroInputUsd = Math.max(0, kiroUsd - KIRO_K_OUT * cp.out * outputTokens);
  const tEffIn = kiroInputUsd / (KIRO_K_IN * cp.in);

  let cacheRead: number;
  if (tEffIn >= inputTokensTotal) {
    cacheRead = 0;
  } else {
    // Divisor uses the runtime-effective ratio (measured default unless the
    // KIRO2CLAUDE_CACHE_READ_RATIO knob overrides it). _cacheReadRatio is
    // constrained to [0, 1), so (1 - _cacheReadRatio) is always > 0.
    const raw = (inputTokensTotal - tEffIn) / (1 - _cacheReadRatio);
    // Round first, then clamp: clamping before rounding could let a fractional
    // cap round up past inputTokensTotal (harmless today — token counts are
    // integers — but this keeps cacheRead ≤ total unconditionally).
    cacheRead = clamp(Math.round(raw), 0, inputTokensTotal);
  }

  // Step 3: attribute the non-read remainder. Calibrated against real Claude
  // Code (claude -p + raw request capture): the non-read part
  // is written to cache (cache_creation) except a small fixed structural input
  // tail (CLAUDE_CODE_INPUT_TAIL_TOKENS ~10, model-independent, not user content).
  // Holds for both cold start (cacheRead=0) and steady state; no cache_hit_ratio
  // branch. estimatedCacheHitRatio is still reported (diagnostic), not used here.
  const cacheHitRatio = cacheRead / inputTokensTotal;
  const nonRead = inputTokensTotal - cacheRead;
  const uncached = Math.min(nonRead, CLAUDE_CODE_INPUT_TAIL_TOKENS);
  const cacheCreation = nonRead - uncached;

  // Step 4: cost — using Anthropic public price table, then floor against
  // upstream cost so finalCostUsd never falls below `credits × KIRO_OVERAGE_RATE`.
  const claudeUsd =
    uncached * cp.in +
    cacheCreation * cp.cacheCreation +
    cacheRead * cp.cacheRead +
    outputTokens * cp.out;
  const { finalUsd, floorApplied } = applyFloor(claudeUsd, credits);

  return {
    inputTokens: uncached,
    cacheCreationInputTokens: cacheCreation,
    cacheReadInputTokens: cacheRead,
    derived: {
      inputTokensTotal,
      estimatedCacheHitRatio: cacheHitRatio,
      claudeEquivalentCostUsd: claudeUsd,
      finalCostUsd: finalUsd,
      costMultiplier: _multiplier,
      derivedStatus: 'ok_derived',
      floorApplied,
    },
  };
}
