import { describe, expect, it } from 'vitest';

import { createDeadline } from '../../src/core/deadline.ts';
import { InvalidArgumentError } from '../../src/core/errors.ts';
import { FakeClock } from '../fakes/fake-clock.ts';

const LIMITS = { softLimitMs: 30_000, reserveMs: 10_000 };

function setup(limits = LIMITS) {
  const clock = new FakeClock({ now: '2026-10-01T00:00:00Z' });
  const deadline = createDeadline(() => clock.now(), limits);
  return { clock, deadline };
}

const TABLE: [number, number, number, boolean][] = [
  [0, 30_000, 40_000, false],
  [1, 29_999, 39_999, false],
  [29_999, 1, 10_001, false],
  [30_000, 0, 10_000, true],
  [30_001, 0, 9_999, true],
  [39_999, 0, 1, true],
  [40_000, 0, 0, true],
  [100_000, 0, 0, true],
];

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

describe('createDeadline', () => {
  it('fixes startedAt at creation', () => {
    const { clock, deadline } = setup();
    const at = deadline.startedAt;
    expect(at).toBe(Date.parse('2026-10-01T00:00:00Z'));
    clock.advance(5_000);
    expect(deadline.startedAt).toBe(at);
  });

  it.each(TABLE)('at %i ms elapsed', (elapsed, remaining, withReserve, past) => {
    const { clock, deadline } = setup();
    clock.advance(elapsed);
    expect(deadline.elapsed()).toBe(elapsed);
    expect(deadline.remaining()).toBe(remaining);
    expect(deadline.remainingWithReserve()).toBe(withReserve);
    expect(deadline.pastSoftLimit()).toBe(past);
  });

  it('reads the clock on every call', () => {
    const { clock, deadline } = setup();
    const first = deadline.remaining();
    clock.advance(5_000);
    expect(deadline.remaining()).toBe(first - 5_000);
  });

  it('never gives more time when the clock steps backwards', () => {
    const { clock, deadline } = setup();
    clock.set(deadline.startedAt - 10_000);
    expect(deadline.elapsed()).toBe(0);
    expect(deadline.remaining()).toBe(30_000);
  });

  it('accepts a soft limit of 0', () => {
    const { deadline } = setup({ softLimitMs: 0, reserveMs: 10_000 });
    expect(deadline.remaining()).toBe(0);
    expect(deadline.pastSoftLimit()).toBe(true);
    expect(deadline.remainingWithReserve()).toBe(10_000);
  });

  it.each(TABLE)('with no reserve, at %i ms', (elapsed) => {
    const { clock, deadline } = setup({ softLimitMs: 30_000, reserveMs: 0 });
    clock.advance(elapsed);
    expect(deadline.remainingWithReserve()).toBe(deadline.remaining());
  });

  it('has detachable methods', () => {
    const { clock, deadline } = setup();
    const { remaining, elapsed, remainingWithReserve, pastSoftLimit } = deadline;
    clock.advance(31_000);
    expect(remaining()).toBe(deadline.remaining());
    expect(elapsed()).toBe(31_000);
    expect(remainingWithReserve()).toBe(9_000);
    expect(pastSoftLimit()).toBe(true);
  });

  it.each([
    ['softLimitMs', -1, 'negative'],
    ['softLimitMs', NaN, 'not_finite'],
    ['softLimitMs', Infinity, 'not_finite'],
    ['reserveMs', -1, 'negative'],
    ['reserveMs', NaN, 'not_finite'],
    ['reserveMs', Infinity, 'not_finite'],
  ])('rejects %s = %s', (argument, value, reason) => {
    const error = caught(() => createDeadline(() => 0, { ...LIMITS, [argument]: value }));
    expect(error).toBeInstanceOf(InvalidArgumentError);
    expect(error).toMatchObject({ argument, reason });
    expect(error instanceof Error && error.message).not.toContain(String(value));
  });

  it('rejects a non-finite now()', () => {
    const error = caught(() => createDeadline(() => NaN, LIMITS));
    expect(error).toBeInstanceOf(InvalidArgumentError);
    expect(error).toMatchObject({ argument: 'now', reason: 'not_finite' });
  });

  it('works with the manual limits', () => {
    const { clock, deadline } = setup({ softLimitMs: 270_000, reserveMs: 10_000 });
    clock.advance(269_000);
    expect(deadline.remaining()).toBe(1_000);
  });
});
