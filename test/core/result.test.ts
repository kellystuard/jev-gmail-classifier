import { describe, expect, expectTypeOf, it } from 'vitest';

import { assertNever } from '../../src/core/assert-never.ts';
import { type Fail, type Ok, type Result, fail, ok } from '../../src/core/result.ts';

type ListResult = Result<
  { labels: readonly string[] },
  Fail<'scope'> | Fail<'rate_limited', { retryAfterMs: number }> | Fail<'history_expired'>
>;

function describeResult(result: ListResult): string {
  if (result.ok) {
    return `labels:${result.labels.join(',')}`;
  }
  // Exhaustive: this compiles only while every failure kind has a case.
  switch (result.kind) {
    case 'scope':
      return 'scope';
    case 'rate_limited':
      return `rate_limited:${String(result.retryAfterMs)}`;
    case 'history_expired':
      return 'history_expired';
    default:
      return assertNever(result);
  }
}

describe('ok()', () => {
  it('builds a flat success', () => {
    expect(ok({ labels: ['a'] })).toEqual({ ok: true, labels: ['a'] });
  });

  it('builds an empty success from {}', () => {
    expect(ok({})).toEqual({ ok: true });
  });

  it('has the Ok type', () => {
    expectTypeOf(ok({ id: 'x' })).toEqualTypeOf<Ok<{ id: string }>>();
    expectTypeOf(ok({ id: 'x' }).ok).toEqualTypeOf<true>();
  });
});

describe('fail()', () => {
  it('builds a failure with only a kind', () => {
    expect(fail('scope')).toEqual({ ok: false, kind: 'scope' });
  });

  it('builds a flat failure with fields', () => {
    expect(fail('rate_limited', { retryAfterMs: 500 })).toEqual({
      ok: false,
      kind: 'rate_limited',
      retryAfterMs: 500,
    });
  });

  it('keeps ok and kind when the fields name them too', () => {
    expect(fail('scope', { ok: true, kind: 'other' })).toEqual({ ok: false, kind: 'scope' });
  });

  it('has the Fail type with a literal kind', () => {
    expectTypeOf(fail('scope')).toEqualTypeOf<Fail<'scope'>>();
    expectTypeOf(fail('rate_limited', { retryAfterMs: 1 })).toEqualTypeOf<
      Fail<'rate_limited', { retryAfterMs: number }>
    >();
    expectTypeOf(fail('scope').kind).toEqualTypeOf<'scope'>();
  });
});

describe('Result narrowing', () => {
  it.each<[ListResult, string]>([
    [ok({ labels: ['a', 'b'] }), 'labels:a,b'],
    [fail('scope'), 'scope'],
    [fail('rate_limited', { retryAfterMs: 250 }), 'rate_limited:250'],
    [fail('history_expired'), 'history_expired'],
  ])('handles %o', (result, expected) => {
    expect(describeResult(result)).toBe(expected);
  });

  it('narrows on ok and on kind', () => {
    const check = (result: ListResult): void => {
      if (result.ok) {
        expectTypeOf(result.labels).toEqualTypeOf<readonly string[]>();
      } else {
        expectTypeOf(result.kind).toEqualTypeOf<'scope' | 'rate_limited' | 'history_expired'>();
        if (result.kind === 'rate_limited') {
          expectTypeOf(result.retryAfterMs).toEqualTypeOf<number>();
        }
      }
    };
    expect(() => {
      check(fail('rate_limited', { retryAfterMs: 1 }));
    }).not.toThrow();
  });
});
