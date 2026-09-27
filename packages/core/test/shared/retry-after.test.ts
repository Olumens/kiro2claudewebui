import { describe, expect, it } from 'vitest';

import { extractRetryAfter } from '../../src/shared/retry-after.js';

describe('extractRetryAfter', () => {
  it('returns undefined when headers is missing or empty', () => {
    expect(extractRetryAfter(null)).toBeUndefined();
    expect(extractRetryAfter(undefined)).toBeUndefined();
    expect(extractRetryAfter({})).toBeUndefined();
  });

  it('reads from lower-cased axios-style header object', () => {
    expect(extractRetryAfter({ 'retry-after': '30' })).toBe('30');
  });

  it('tolerates capitalisation variants', () => {
    expect(extractRetryAfter({ 'Retry-After': '60' })).toBe('60');
    expect(extractRetryAfter({ 'RETRY-AFTER': '5' })).toBe('5');
  });

  it('coerces numeric values to strings (verbatim)', () => {
    expect(extractRetryAfter({ 'retry-after': 42 })).toBe('42');
  });

  it('reads from fetch-style Headers interface (.get)', () => {
    const headers = {
      get(name: string): string | null {
        return name === 'retry-after' ? '120' : null;
      },
    };
    expect(extractRetryAfter(headers)).toBe('120');
  });

  it('returns undefined for empty string values', () => {
    expect(extractRetryAfter({ 'retry-after': '' })).toBeUndefined();
  });

  it('ignores non-finite numbers', () => {
    expect(extractRetryAfter({ 'retry-after': Number.NaN })).toBeUndefined();
    expect(extractRetryAfter({ 'retry-after': Number.POSITIVE_INFINITY })).toBeUndefined();
  });

  it('returns undefined for arbitrary non-object inputs', () => {
    expect(extractRetryAfter('not an object')).toBeUndefined();
    expect(extractRetryAfter(42)).toBeUndefined();
  });
});
