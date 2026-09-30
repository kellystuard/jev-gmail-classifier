import { describe, expect, it } from 'vitest';
import { InvalidArgumentError } from '../../src/core/errors.ts';
import {
  MAX_ATTEMPTS,
  MAX_RETRY_AFTER_MS,
  parseRetryAfter,
  retryDelay,
} from '../../src/core/retry-delay.ts';
import { FakeRandom } from '../fakes/fake-random.ts';

const NEAR_ONE = 1 - Number.EPSILON;

describe('retryDelay', () => {
  it('starts with three attempts', () => {
    expect(MAX_ATTEMPTS).toBe(3);
  });

  it.each([
    [1, 0, 500],
    [2, 0, 1000],
    [3, 0, 2000],
    [4, 0, 4000],
    [5, 0, 5000],
    [6, 0, 5000],
    [1, NEAR_ONE, 375],
    [2, NEAR_ONE, 750],
    [3, NEAR_ONE, 1500],
    [4, NEAR_ONE, 3000],
    [5, NEAR_ONE, 3750],
    [1, 0.5, 438],
  ])('attempt %d with random %d waits %d ms', (attempt, random, expected) => {
    expect(retryDelay(attempt, undefined, FakeRandom.sequence([random]))).toBe(expected);
  });

  it.each([
    [1, 100, 500],
    [1, 500, 500],
    [1, 501, 501],
    [1, 2000, 2000],
    [1, 1500.2, 1501],
    [2, 0, 1000],
    [1, MAX_RETRY_AFTER_MS, MAX_RETRY_AFTER_MS],
    [1, MAX_RETRY_AFTER_MS + 1, undefined],
    [3, 1_000_000, undefined],
  ])('attempt %d with retryAfterMs %d gives %s', (attempt, retryAfterMs, expected) => {
    expect(retryDelay(attempt, retryAfterMs, FakeRandom.sequence([0]))).toBe(expected);
  });

  it('calls random.next() once per call, whatever the header does', () => {
    let calls = 0;
    const random = {
      next: () => {
        calls++;
        return 0.5;
      },
    };
    retryDelay(1, undefined, random);
    retryDelay(1, 10_000, random);
    retryDelay(1, 70_000, random);
    expect(calls).toBe(3);
  });

  it('uses successive random values', () => {
    const random = FakeRandom.sequence([0, NEAR_ONE]);
    expect(retryDelay(1, undefined, random)).toBe(500);
    expect(retryDelay(1, undefined, random)).toBe(375);
  });

  it.each([
    ['attempt', 0, undefined, 0],
    ['attempt', -1, undefined, 0],
    ['attempt', 1.5, undefined, 0],
    ['attempt', Number.NaN, undefined, 0],
    ['retryAfterMs', 1, -1, 0],
    ['retryAfterMs', 1, Number.NaN, 0],
    ['retryAfterMs', 1, Number.POSITIVE_INFINITY, 0],
    ['random', 1, undefined, 1],
    ['random', 1, undefined, -0.1],
    ['random', 1, undefined, Number.NaN],
  ])('throws InvalidArgumentError for %s', (argument, attempt, retryAfterMs, draw) => {
    let error: unknown;
    try {
      retryDelay(attempt, retryAfterMs, { next: () => draw });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(InvalidArgumentError);
    expect(error instanceof InvalidArgumentError && error.argument).toBe(argument);
  });
});

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-09-30T12:00:00Z');

  it.each<[string, Record<string, string>, number | undefined]>([
    ['no header', {}, undefined],
    ['other headers only', { 'content-type': 'application/json' }, undefined],
    ['seconds', { 'retry-after': '2' }, 2000],
    ['fractional seconds', { 'retry-after': '1.5' }, 1500],
    ['zero seconds', { 'retry-after': '0' }, 0],
    ['milliseconds', { 'retry-after-ms': '1500' }, 1500],
    ['fractional milliseconds', { 'retry-after-ms': '250.5' }, 250.5],
    ['both: ms wins', { 'retry-after-ms': '1500', 'retry-after': '9' }, 1500],
    ['HTTP date 3 s ahead', { 'retry-after': 'Wed, 30 Sep 2026 12:00:03 GMT' }, 3000],
    ['HTTP date in the past', { 'retry-after': 'Wed, 30 Sep 2026 11:00:00 GMT' }, 0],
    ['negative', { 'retry-after': '-1' }, undefined],
    ['empty', { 'retry-after': '' }, undefined],
    ['soon', { 'retry-after': 'soon' }, undefined],
    ['bad date', { 'retry-after': 'Wed, 99 Foo 2026 12:00:03 GMT' }, undefined],
    ['bad ms falls through', { 'retry-after-ms': 'soon', 'retry-after': '2' }, 2000],
    ['negative ms falls through', { 'retry-after-ms': '-5', 'retry-after': '2' }, 2000],
    ['whitespace, seconds', { 'retry-after': '  2  ' }, 2000],
    ['whitespace, ms', { 'retry-after-ms': ' 1500\t' }, 1500],
    ['whitespace, date', { 'retry-after': ' Wed, 30 Sep 2026 12:00:03 GMT ' }, 3000],
    ['exponent is not decimal', { 'retry-after': '1e3' }, undefined],
  ])('%s', (_name, headers, expected) => {
    expect(parseRetryAfter(headers, now)).toBe(expected);
  });
});
