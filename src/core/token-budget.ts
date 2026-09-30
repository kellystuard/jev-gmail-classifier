/**
 * The daily token budget (Solution Design §7.3, §10.2; epic #11 decision 10):
 * the `state.budget` codec, the calendar day in the script's time zone, and
 * the pure functions that roll the day over, add Jev's `usage.input_tokens`
 * and check the limit. The store and the sender that use them are #100.
 *
 * Stored as `{"v": 1, "day": "YYYY-MM-DD", "inputTokens": <int>}`.
 */
import { z } from 'zod';

import { InvalidArgumentError } from './errors.ts';
import { defineStateCodec } from './state-codec.ts';
import type { JsonValue } from './state-types.ts';

/** The Script Properties key. */
export const BUDGET_KEY = 'state.budget';

export type Budget = {
  /** The calendar day in the script's time zone, `YYYY-MM-DD`. */
  readonly day: string;
  /** Jev `usage.input_tokens` summed over that day. A non-negative safe integer. */
  readonly inputTokens: number;
};

const DAY_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** True for `YYYY-MM-DD` that names a real calendar date (`2026-02-30` is not). */
function isCalendarDay(day: string): boolean {
  if (!DAY_SHAPE.test(day)) return false;
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const date = Number(day.slice(8, 10));
  if (month < 1 || month > 12 || date < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return date <= (lengths[month - 1] ?? 0);
}

/**
 * `decode(BUDGET_KEY, raw)` throws `StateError` `version` for an unknown `v`,
 * and `schema` for a missing `v` or a bad shape. `encode` writes `v` first.
 */
export const budgetCodec = defineStateCodec({
  version: 1,
  schema: z.strictObject({
    day: z.string().refine(isCalendarDay, 'Expected a calendar day as YYYY-MM-DD'),
    inputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }),
});

/** Decodes a `state.budget` value. The caller handles an absent key. Throws `StateError`. */
export function decodeBudget(raw: unknown): Budget {
  return budgetCodec.decode(BUDGET_KEY, raw);
}

/** The JSON to store under `state.budget`. */
export function encodeBudget(budget: Budget): JsonValue {
  return budgetCodec.encode(budget);
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached !== undefined) return cached;
  let created: Intl.DateTimeFormat;
  try {
    created = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch (error) {
    throw new InvalidArgumentError(
      `Unknown time zone "${timeZone}"`,
      { argument: 'timeZone', reason: 'unknown_time_zone' },
      { cause: error },
    );
  }
  formatters.set(timeZone, created);
  return created;
}

/**
 * The calendar day of an instant in an IANA time zone, as `YYYY-MM-DD`.
 * `Intl` handles DST and half-hour zones. Apps Script's V8 gives the same
 * days as Node (`spikes/99-time-zone-day.md`). Throws `InvalidArgumentError`
 * for a non-finite `epochMs` or a zone `Intl` rejects.
 */
export function dayInTimeZone(epochMs: number, timeZone: string): string {
  if (!Number.isFinite(epochMs)) {
    throw new InvalidArgumentError('epochMs must be a finite number', {
      argument: 'epochMs',
      reason: 'not_finite',
    });
  }
  const formatter = formatterFor(timeZone);
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = formatter.formatToParts(new Date(epochMs));
  } catch (error) {
    // `Date` rejects instants beyond ±8.64e15 ms.
    throw new InvalidArgumentError(
      'epochMs is outside the range of a Date',
      { argument: 'epochMs', reason: 'out_of_range' },
      { cause: error },
    );
  }
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/**
 * The budget for `today`: `stored` when it is for today, otherwise a fresh
 * one at 0 (an absent key, or any other day). A stored day later than today
 * only happens when the clock or the time zone moved back; starting from 0
 * then is accepted. Throws `InvalidArgumentError` if `today` isn't a
 * `YYYY-MM-DD` calendar day.
 */
export function budgetForDay(stored: Budget | undefined, today: string): Budget {
  if (!isCalendarDay(today)) {
    throw new InvalidArgumentError('today must be a calendar day as YYYY-MM-DD', {
      argument: 'today',
      reason: 'not_a_day',
    });
  }
  if (stored !== undefined && stored.day === today) return stored;
  return { day: today, inputTokens: 0 };
}

function requireSafeInteger(value: number, argument: string, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new InvalidArgumentError(
      `${argument} must be a safe integer of at least ${String(minimum)}`,
      { argument, reason: 'invalid_number' },
    );
  }
}

/**
 * A new budget with `tokens` added. `tokens` is a non-negative safe integer.
 * A sum past `Number.MAX_SAFE_INTEGER` is clamped to it, which keeps the
 * stored value valid (it can't happen in practice).
 */
export function addInputTokens(budget: Budget, tokens: number): Budget {
  requireSafeInteger(tokens, 'tokens', 0);
  return {
    day: budget.day,
    inputTokens: Math.min(Number.MAX_SAFE_INTEGER, budget.inputTokens + tokens),
  };
}

/** True when the day's tokens have reached the limit: `inputTokens >= dailyTokenBudget`. */
export function isBudgetReached(budget: Budget, dailyTokenBudget: number): boolean {
  requireSafeInteger(dailyTokenBudget, 'dailyTokenBudget', 1);
  return budget.inputTokens >= dailyTokenBudget;
}

/** The tokens left today, never negative (for `run.end`, SD §10.5). */
export function remainingTokens(budget: Budget, dailyTokenBudget: number): number {
  requireSafeInteger(dailyTokenBudget, 'dailyTokenBudget', 1);
  return Math.max(0, dailyTokenBudget - budget.inputTokens);
}
