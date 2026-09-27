import type { UsageFinishHook } from '@kiro2claude/plugin-api';
import { getLogger } from '../shared/logger.js';
import type { UsageFinishEventImpl } from './usage-finish-event.js';

interface RegisteredHook {
  pluginName: string;
  handler: UsageFinishHook;
}

/**
 * HookBus collects plugin-registered handlers and invokes them sequentially
 * during wire finalization, in registration order (= the loader's dependsOn
 * topological order). Sequential so that order is deterministic: for the same
 * extension namespace the later hook's write wins, and conflicting standard
 * field overrides are attributed in order.
 */
export class HookBus {
  readonly #usageFinish: RegisteredHook[] = [];

  /** Plugin-facing: register a usage-finish handler. */
  registerUsageFinish(pluginName: string, handler: UsageFinishHook): void {
    this.#usageFinish.push({ pluginName, handler });
  }

  /** Host-facing: run all registered usage-finish handlers in order. */
  async runUsageFinish(event: UsageFinishEventImpl): Promise<void> {
    for (const { pluginName, handler } of this.#usageFinish) {
      event._setActivePlugin(pluginName);
      try {
        const result = handler(event);
        if (result instanceof Promise) await result;
      } catch (err) {
        // One plugin's failure must not break finalization: the upstream call
        // already succeeded (and may be billed), so the wire must still ship.
        // An uncaught throw here would 500 a billed request on the non-stream
        // path and leave the SSE truncated (no message_stop) on the stream
        // path. Log and continue to the next plugin instead of aborting.
        getLogger().warn({
          msg: 'usage-finish hook failed — skipping this plugin',
          plugin: pluginName,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  size(): number {
    return this.#usageFinish.length;
  }
}

export class HookExecutionError extends Error {
  constructor(
    public readonly pluginName: string,
    public readonly cause: unknown,
  ) {
    super(`hook execution failed in plugin "${pluginName}"`);
    this.name = 'HookExecutionError';
  }
}
