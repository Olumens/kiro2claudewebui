/**
 * @kiro2claude/plugin-api — Plugin contract types.
 *
 * Zero runtime dependencies: types, an abstract base class and a few pure
 * helpers (`isValidPlugin` / `assertApiVersion` / `parseEnvBool`). Plugin authors
 * depend on this package; the host (@kiro2claude/core) ships the implementation.
 *
 * Stability: BREAKING changes to exported types are major bumps. Add new
 * optional fields freely (minor bump). Renaming or removing exported names
 * cascades to every third-party plugin — gate hard.
 */

import type { FastifyInstance } from 'fastify';

// ─────────────────────────────────────────────────────────────────────────────
// Plugin manifest
// ─────────────────────────────────────────────────────────────────────────────

export interface KiroPlugin {
  /** Stable identifier; used in dependsOn graph and logs. Lowercase-kebab. */
  readonly name: string;
  /** SemVer of this plugin. */
  readonly version: string;
  /** Contract version this plugin targets. The host only accepts the literal '1.x' (`assertApiVersion`). */
  readonly apiVersion: '1.x';
  /**
   * Names of plugins to register before this one (loader topo-sorts). Ordering
   * only: a missing or failed dependency is logged, not enforced; a cycle
   * aborts discovery of all plugins.
   */
  readonly dependsOn?: readonly string[];
  /** Called once during host startup after capabilities are ready. */
  register(ctx: PluginContext): Promise<void> | void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Host-provided context (read-only from the plugin's view)
// ─────────────────────────────────────────────────────────────────────────────

export interface PluginContext {
  /** Fastify instance. Plugins may register routes/hooks against it. */
  readonly app: FastifyInstance;
  /** Minimal logger surface (does not leak pino types). */
  readonly logger: PluginLogger;
  /** Environment variables. Plugins read their own KIRO2CLAUDE_* keys. */
  readonly env: NodeJS.ProcessEnv;
  /** Auth API key the host expects on incoming requests. */
  readonly apiKey: string;
  /** Register usage-finish hooks. */
  readonly registerHook: HookRegistrar;
  /**
   * Look up host-provided capabilities by name. Returns undefined if the
   * capability is not registered. Use this instead of importing concrete
   * host types — keeps the contract upstream-agnostic.
   *
   * Well-known names registered by @kiro2claude/core:
   *   'usage-limits' → UsageLimitsProvider
   */
  getCapability<T = unknown>(name: string): T | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Logger contract (minimal subset of pino)
// ─────────────────────────────────────────────────────────────────────────────

export interface PluginLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  debug?(obj: object, msg?: string): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook registry
// ─────────────────────────────────────────────────────────────────────────────

export interface HookRegistrar {
  /**
   * Called at most once per upstream response, before the host writes the
   * SSE / non-stream usage. Plugins may read upstream meta and inject
   * additional usage fields or override standard ones. Also fires on upstream
   * error paths once a metering frame arrived (so credits are still booked);
   * changes made then never reach the wire. A throwing handler is logged and
   * skipped.
   */
  onUsageFinish(handler: UsageFinishHook): void;
}

export type UsageFinishHook = (event: UsageFinishEvent) => void | Promise<void>;

// ─────────────────────────────────────────────────────────────────────────────
// Upstream capabilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Capability name 'usage-limits' — exposes upstream quota snapshot.
 * The host adapts its token manager's GetUsageLimits (first usage breakdown)
 * into this shape; plugins consume it via
 * ctx.getCapability<UsageLimitsProvider>('usage-limits').
 */
export interface UsageLimitsProvider {
  getUsageLimits(): Promise<UsageSnapshot>;
}

export interface UsageSnapshot {
  /** Total quota for the current billing window (credits). */
  readonly limit: number;
  /** Credits already consumed within the window. */
  readonly current: number;
  /** Window reset timestamp (ms since epoch). The current host never fills it (always undefined). */
  readonly resetAt?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Usage finish event
// ─────────────────────────────────────────────────────────────────────────────

/** Standard Anthropic-protocol usage fields a plugin may override. */
export type StandardUsageField =
  | 'input_tokens'
  | 'output_tokens'
  | 'cache_creation_input_tokens'
  | 'cache_read_input_tokens';

/**
 * Gateway path that produced this finalization. Deliberately a single-member
 * union today ('http-direct' is the only path) — kept as a reserved extension
 * seam so a future alternate transport can be added as a non-breaking minor
 * bump. Do not delete just because it currently has one member.
 */
export type UsageFinishSource = 'http-direct';

/**
 * Indicates how reliable inputTokens is for downstream computation.
 *
 * - 'client-estimate':   tokenizer estimate on the client request body.
 * - 'upstream-reported': upstream returned an authoritative count.
 */
export type InputTokensSource = 'client-estimate' | 'upstream-reported';

export interface UsageFinishEvent {
  /** Model identifier as advertised to the downstream SDK. */
  readonly model: string;
  /** Gateway path that produced this finalization (currently always 'http-direct'). */
  readonly source: UsageFinishSource;
  /** Reliability label for the inputTokens reading. */
  readonly inputTokensSource: InputTokensSource;

  /**
   * Read host-provided upstream metadata. Keys follow the 'kiro.*' namespace
   * for kiro-specific data. Plugins should treat all values as untrusted
   * and validate types.
   *
   * Well-known keys (`?` = the key is always present but the VALUE may be
   * undefined — see listMetaKeys below):
   *   'kiro.inputTokens'      number
   *   'kiro.outputTokens'     number
   *   'kiro.creditsUsed'      number?   raw kiro credit for this request
   *   'kiro.pricedModel'      string    model id for price-table lookups
   *   'kiro.upstreamRaw'      unknown?  full upstream metering payload
   *   'kiro.meteringMissing'  boolean   upstream billed us but the metering
   *                                     frame never arrived, so creditsUsed is
   *                                     undefined for a request that DID cost
   *                                     money. Distinguishes real lost billing
   *                                     from a genuinely empty response.
   *
   * This list is the contract; the host pins it against its own implementation
   * with a static guard, so anything absent here is not emitted.
   */
  getMeta<T = unknown>(key: string): T | undefined;
  /**
   * All meta keys the host populated on this event.
   *
   * ⚠ Presence is NOT availability: the host writes every well-known key on
   * every event, so an unavailable reading shows up as a key whose VALUE is
   * `undefined`, not as a missing key. Test with
   * `getMeta(k) === undefined`, never with `listMetaKeys().includes(k)`.
   * Use this for debugging and for detecting keys a newer host added.
   */
  listMetaKeys(): readonly string[];

  /**
   * Add a namespaced extension field to the wire payload's `usage` object.
   * Multiple calls to the same namespace overwrite (last writer wins, across
   * plugins too), so plugins should claim their own namespace (e.g.
   * `kiro_metering`, `kiro_derived`, or vendor-prefixed for third parties).
   * A namespace equal to a field already on `usage` (standard fields such as
   * `input_tokens`, or OpenAI's `prompt_tokens_details`) is ignored — use
   * overrideStandardField to change standard fields.
   */
  addExtension(namespace: string, value: unknown): void;

  /**
   * Override one of Anthropic's standard usage fields. The reason is kept
   * for traceability: if two plugins override the same field within a single
   * finalization, the host emits a `warn` log identifying both (with reasons).
   */
  overrideStandardField(name: StandardUsageField, value: number, reason: string): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience base class
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal base class for plugins that prefer not to spell out the readonly
 * fields. Subclasses still need to implement `register`.
 */
export abstract class BasePlugin implements KiroPlugin {
  abstract readonly name: string;
  abstract readonly version: string;
  readonly apiVersion = '1.x' as const;
  readonly dependsOn?: readonly string[];
  abstract register(ctx: PluginContext): Promise<void> | void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime guards (used by host's loader, exported so plugin tests can reuse)
// ─────────────────────────────────────────────────────────────────────────────

export function isValidPlugin(value: unknown): value is KiroPlugin {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Partial<KiroPlugin>;
  return (
    typeof v.name === 'string' &&
    v.name.length > 0 &&
    typeof v.version === 'string' &&
    typeof v.apiVersion === 'string' &&
    typeof v.register === 'function' &&
    // dependsOn (optional) must be a string[]; a malformed non-array (e.g. a
    // hand-written manifest with dependsOn: 'foo') would otherwise be iterated
    // character-by-character by the loader's topoSort, silently mis-ordering
    // load instead of being rejected here at discovery time.
    (v.dependsOn === undefined ||
      (Array.isArray(v.dependsOn) && v.dependsOn.every((d) => typeof d === 'string')))
  );
}

/**
 * Throws if the plugin's apiVersion is not '1.x'. The host calls this right
 * before invoking register() (the loader itself only checks it is a string).
 */
export function assertApiVersion(plugin: KiroPlugin): void {
  if (plugin.apiVersion !== '1.x') {
    throw new Error(
      `plugin "${plugin.name}" declares apiVersion "${String(plugin.apiVersion)}" ` +
        `which is incompatible with host's '1.x'`,
    );
  }
}
