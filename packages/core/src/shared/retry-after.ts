/**
 * `Retry-After` header extraction for the token-refresh / GetUsageLimits error paths
 * (`kiro/token-manager.ts` → `KiroHttpError`). Conversation errors take a different
 * route: `RetryExecutor` parses Retry-After itself (`parseRetryAfter`) and
 * `classifyProviderError` (claude/error-mapper.ts) owns the downstream status mapping.
 */

/**
 * Extract the `Retry-After` header value from a response headers map.
 *
 * Tolerates the few shapes we encounter in practice: axios's lower-cased
 * header object, fetch's `Headers` interface, and plain `Record<string, _>`.
 * The value is returned **verbatim** as a string (RFC 9110 allows either
 * `delta-seconds` or `HTTP-date`); we do not parse or validate it. Callers
 * pass it through to the downstream `Retry-After` header unchanged.
 *
 * Returns `undefined` when the header is missing or empty.
 */
export function extractRetryAfter(headers: unknown): string | undefined {
  if (!headers) return undefined;

  // fetch-style Headers interface
  if (typeof (headers as { get?: unknown }).get === 'function') {
    const v = (headers as { get(name: string): string | null }).get('retry-after');
    return v && v.length > 0 ? v : undefined;
  }

  // Plain object — try a few capitalisations.
  if (typeof headers === 'object') {
    const h = headers as Record<string, unknown>;
    for (const key of ['retry-after', 'Retry-After', 'RETRY-AFTER']) {
      const v = h[key];
      if (typeof v === 'string' && v.length > 0) return v;
      if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    }
  }

  return undefined;
}
