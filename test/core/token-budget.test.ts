import { describe, expect, it } from 'vitest';

import { InvalidArgumentError, StateError, type StateErrorReason } from '../../src/core/errors.ts';
import {
  addInputTokens,
  BUDGET_KEY,
  budgetCodec,
  budgetForDay,
  dayInTimeZone,
  decodeBudget,
  encodeBudget,
  isBudgetReached,
  remainingTokens,
  type Budget,
} from '../../src/core/token-budget.ts';

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

describe('budget codec', () => {
  it('uses the state.budget key', () => {
    expect(BUDGET_KEY).toBe('state.budget');
    expect(budgetCodec.version).toBe(1);
  });

  it.each([
    ['zero tokens', { day: '2026-09-29', inputTokens: 0 }],
    ['a typical day', { day: '2026-09-29', inputTokens: 1_234_567 }],
    ['a leap day', { day: '2028-02-29', inputTokens: 5 }],
    ['the largest safe integer', { day: '2026-12-31', inputTokens: Number.MAX_SAFE_INTEGER }],
  ])('round-trips %s, with v first', (_name, budget) => {
    const encoded = encodeBudget(budget);
    expect(JSON.stringify(encoded)).toBe(
      `{"v":1,"day":"${budget.day}","inputTokens":${String(budget.inputTokens)}}`,
    );
    expect(decodeBudget(JSON.parse(JSON.stringify(encoded)))).toEqual(budget);
  });

  it.each<[string, unknown, StateErrorReason]>([
    ['a missing v', { day: '2026-09-29', inputTokens: 0 }, 'schema'],
    ['an unknown v', { v: 2, day: '2026-09-29', inputTokens: 0 }, 'version'],
    ['v 0', { v: 0, day: '2026-09-29', inputTokens: 0 }, 'version'],
    ['a numeric day', { v: 1, day: 20260929, inputTokens: 0 }, 'schema'],
    ['a string inputTokens', { v: 1, day: '2026-09-29', inputTokens: '5' }, 'schema'],
    ['a missing day', { v: 1, inputTokens: 0 }, 'schema'],
    ['a missing inputTokens', { v: 1, day: '2026-09-29' }, 'schema'],
    ['a negative inputTokens', { v: 1, day: '2026-09-29', inputTokens: -1 }, 'schema'],
    ['a fractional inputTokens', { v: 1, day: '2026-09-29', inputTokens: 1.5 }, 'schema'],
    ['an unsafe inputTokens', { v: 1, day: '2026-09-29', inputTokens: 2 ** 53 }, 'schema'],
    ['an infinite inputTokens', { v: 1, day: '2026-09-29', inputTokens: Infinity }, 'schema'],
    ['a malformed day', { v: 1, day: '2026-9-29', inputTokens: 0 }, 'schema'],
    ['a day with a time', { v: 1, day: '2026-09-29T00:00', inputTokens: 0 }, 'schema'],
    ['an impossible day (Feb 30)', { v: 1, day: '2026-02-30', inputTokens: 0 }, 'schema'],
    ['an impossible day (month 13)', { v: 1, day: '2026-13-01', inputTokens: 0 }, 'schema'],
    ['Feb 29 in a common year', { v: 1, day: '2026-02-29', inputTokens: 0 }, 'schema'],
    ['day 00', { v: 1, day: '2026-09-00', inputTokens: 0 }, 'schema'],
    ['an extra key', { v: 1, day: '2026-09-29', inputTokens: 0, extra: true }, 'schema'],
    ['not an object', '2026-09-29', 'schema'],
  ])('throws StateError %s', (_name, raw, reason) => {
    const error = caught(() => decodeBudget(raw));
    expect(error).toBeInstanceOf(StateError);
    expect(error).toMatchObject({ key: 'state.budget', reason });
  });

  it('never puts the stored value in the message', () => {
    const error = caught(() => decodeBudget({ v: 1, day: '2026-02-30', inputTokens: 987654321.5 }));
    expect(error).toBeInstanceOf(StateError);
    const message = error instanceof Error ? error.message : '';
    expect(message).not.toBe('');
    expect(message).not.toContain('2026-02-30');
    expect(message).not.toContain('987654321');
  });
});

describe('dayInTimeZone', () => {
  // Every row is an instant and zone for which Apps Script returned this day, both from
  // Intl.DateTimeFormat and from Utilities.formatDate (spikes/99-time-zone-day.md).
  it.each<[string, string, string]>([
    ['Etc/UTC', '2026-09-28T23:59:00Z', '2026-09-28'],
    ['Etc/UTC', '2026-09-29T00:00:00Z', '2026-09-29'],
    ['Etc/UTC', '2026-09-29T00:01:00Z', '2026-09-29'],
    ['America/Chicago', '2026-09-29T04:59:00Z', '2026-09-28'],
    ['America/Chicago', '2026-09-29T05:00:00Z', '2026-09-29'],
    ['America/Chicago', '2026-09-29T05:01:00Z', '2026-09-29'],
    ['Asia/Kolkata', '2026-09-28T18:29:00Z', '2026-09-28'],
    ['Asia/Kolkata', '2026-09-28T18:30:00Z', '2026-09-29'],
    ['Asia/Kolkata', '2026-09-28T18:31:00Z', '2026-09-29'],
    ['Pacific/Kiritimati', '2026-09-28T09:59:00Z', '2026-09-28'],
    ['Pacific/Kiritimati', '2026-09-28T10:00:00Z', '2026-09-29'],
    ['Pacific/Kiritimati', '2026-09-28T10:01:00Z', '2026-09-29'],
    ['Australia/Lord_Howe', '2026-09-28T13:29:00Z', '2026-09-28'],
    ['Australia/Lord_Howe', '2026-09-28T13:30:00Z', '2026-09-29'],
    ['Australia/Lord_Howe', '2026-09-28T13:31:00Z', '2026-09-29'],
    ['Pacific/Pago_Pago', '2026-09-29T10:59:00Z', '2026-09-28'],
    ['Pacific/Pago_Pago', '2026-09-29T11:00:00Z', '2026-09-29'],
    ['Pacific/Pago_Pago', '2026-09-29T11:01:00Z', '2026-09-29'],
    ['America/Chicago', '2026-03-08T05:59:00Z', '2026-03-07'],
    ['America/Chicago', '2026-03-08T06:00:00Z', '2026-03-08'],
    ['America/Chicago', '2026-03-08T06:01:00Z', '2026-03-08'],
    ['America/Chicago', '2026-03-08T07:59:00Z', '2026-03-08'],
    ['America/Chicago', '2026-03-08T08:00:00Z', '2026-03-08'],
    ['America/Chicago', '2026-03-08T08:01:00Z', '2026-03-08'],
    ['America/Chicago', '2026-03-09T04:59:00Z', '2026-03-08'],
    ['America/Chicago', '2026-03-09T05:00:00Z', '2026-03-09'],
    ['America/Chicago', '2026-03-09T05:01:00Z', '2026-03-09'],
    ['America/Chicago', '2026-11-01T04:59:00Z', '2026-10-31'],
    ['America/Chicago', '2026-11-01T05:00:00Z', '2026-11-01'],
    ['America/Chicago', '2026-11-01T05:01:00Z', '2026-11-01'],
    ['America/Chicago', '2026-11-01T06:59:00Z', '2026-11-01'],
    ['America/Chicago', '2026-11-01T07:00:00Z', '2026-11-01'],
    ['America/Chicago', '2026-11-01T07:01:00Z', '2026-11-01'],
    ['America/Chicago', '2026-11-02T05:59:00Z', '2026-11-01'],
    ['America/Chicago', '2026-11-02T06:00:00Z', '2026-11-02'],
    ['America/Chicago', '2026-11-02T06:01:00Z', '2026-11-02'],
  ])('%s at %s is %s', (zone, instant, day) => {
    expect(dayInTimeZone(Date.parse(instant), zone)).toBe(day);
  });

  it('gives the same answer from the cached formatter', () => {
    const ms = Date.parse('2026-09-29T04:59:00Z');
    expect(dayInTimeZone(ms, 'America/Chicago')).toBe('2026-09-28');
    expect(dayInTimeZone(ms, 'America/Chicago')).toBe('2026-09-28');
  });

  it.each<[string, number, string, string]>([
    ['NaN', Number.NaN, 'Etc/UTC', 'epochMs'],
    ['Infinity', Number.POSITIVE_INFINITY, 'Etc/UTC', 'epochMs'],
    ['beyond the Date range', 8.64e15 + 1, 'Etc/UTC', 'epochMs'],
    ['an invalid zone', 0, 'Not/AZone', 'timeZone'],
    ['an empty zone', 0, '', 'timeZone'],
  ])('throws InvalidArgumentError for %s', (_name, epochMs, zone, argument) => {
    const error = caught(() => dayInTimeZone(epochMs, zone));
    expect(error).toBeInstanceOf(InvalidArgumentError);
    expect(error).toMatchObject({ argument });
  });

  it('keeps the RangeError as the cause for an invalid zone', () => {
    const error = caught(() => dayInTimeZone(0, 'Not/AZone'));
    expect(error instanceof Error && 'cause' in error && error.cause instanceof RangeError).toBe(
      true,
    );
  });
});

describe('budgetForDay', () => {
  const today = '2026-09-29';

  it.each<[string, Budget | undefined, Budget]>([
    ['an absent key', undefined, { day: today, inputTokens: 0 }],
    ['the same day', { day: today, inputTokens: 42 }, { day: today, inputTokens: 42 }],
    ['an earlier day', { day: '2026-09-28', inputTokens: 999 }, { day: today, inputTokens: 0 }],
    ['a later day', { day: '2026-09-30', inputTokens: 999 }, { day: today, inputTokens: 0 }],
  ])('%s', (_name, stored, expected) => {
    expect(budgetForDay(stored, today)).toEqual(expected);
  });

  it('returns the stored budget itself for the same day', () => {
    const stored = { day: today, inputTokens: 7 };
    expect(budgetForDay(stored, today)).toBe(stored);
  });

  it.each(['', '2026-9-29', '2026-02-30', 'today', '2026-09-29T00:00:00Z'])(
    'throws InvalidArgumentError for today = %j',
    (bad) => {
      const error = caught(() => budgetForDay(undefined, bad));
      expect(error).toBeInstanceOf(InvalidArgumentError);
      expect(error).toMatchObject({ argument: 'today' });
    },
  );
});

describe('addInputTokens', () => {
  it.each<[string, number, number, number]>([
    ['adding 0', 10, 0, 10],
    ['adding to zero', 0, 25, 25],
    ['adding to an existing count', 1_000, 234, 1_234],
    ['reaching the largest safe integer', Number.MAX_SAFE_INTEGER - 5, 5, Number.MAX_SAFE_INTEGER],
    ['clamping past it', Number.MAX_SAFE_INTEGER - 5, 6, Number.MAX_SAFE_INTEGER],
    [
      'clamping from the maximum',
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
    ],
  ])('%s', (_name, before, tokens, after) => {
    const budget = { day: '2026-09-29', inputTokens: before };
    const next = addInputTokens(budget, tokens);
    expect(next).toEqual({ day: '2026-09-29', inputTokens: after });
    expect(budget).toEqual({ day: '2026-09-29', inputTokens: before });
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    'throws InvalidArgumentError for tokens = %s',
    (tokens) => {
      const error = caught(() => addInputTokens({ day: '2026-09-29', inputTokens: 0 }, tokens));
      expect(error).toBeInstanceOf(InvalidArgumentError);
      expect(error).toMatchObject({ argument: 'tokens' });
    },
  );
});

describe('isBudgetReached and remainingTokens', () => {
  const limit = 1_000;

  it.each<[string, number, boolean, number]>([
    ['nothing used', 0, false, 1_000],
    ['just under', 999, false, 1],
    ['exactly at the budget', 1_000, true, 0],
    ['over the budget', 1_500, true, 0],
  ])('%s', (_name, used, reached, remaining) => {
    const budget = { day: '2026-09-29', inputTokens: used };
    expect(isBudgetReached(budget, limit)).toBe(reached);
    expect(remainingTokens(budget, limit)).toBe(remaining);
    expect(budget).toEqual({ day: '2026-09-29', inputTokens: used });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    'throws InvalidArgumentError for dailyTokenBudget = %s',
    (bad) => {
      const budget = { day: '2026-09-29', inputTokens: 0 };
      for (const fn of [() => isBudgetReached(budget, bad), () => remainingTokens(budget, bad)]) {
        const error = caught(fn);
        expect(error).toBeInstanceOf(InvalidArgumentError);
        expect(error).toMatchObject({ argument: 'dailyTokenBudget' });
      }
    },
  );
});
