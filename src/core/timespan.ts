/**
 * The `MANUAL_TIMESPAN` grammar and its `after:` bound (Solution Design §6.6,
 * epic #14 decision 2). Pure: no ports, no clock, no config. The caller passes
 * the text and the time.
 *
 * Grammar, after trimming: 1 to 5 ASCII digits with no leading zero, directly
 * followed by one unit letter in either case: `h` hours, `d` days, `w` weeks.
 * Nothing else is valid, and nothing is guessed, rounded or repaired.
 *
 * `m` and `y` are refused on purpose. `m` would mean minutes here and months in
 * Gmail's own `newer_than:`, so the user writes days instead (`30d`, `365d`).
 */

import { InvalidArgumentError } from './errors.ts';
import { fail, ok } from './result.ts';
import type { Fail, Result } from './result.ts';

/** A parsed `MANUAL_TIMESPAN`. */
export type Timespan = {
  /** The span in milliseconds: a safe integer above 0. */
  readonly ms: number;
  /** The canonical text: the digits, then the lower-case unit, such as `36h`. */
  readonly text: string;
};

const TIMESPAN_PATTERN = /^([1-9][0-9]{0,4})([hdw])$/i;

const UNIT_MS: Readonly<Record<string, number>> = {
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** Parses a `MANUAL_TIMESPAN` value. An invalid value is an expected failure. */
export function parseTimespan(text: string): Result<Timespan, Fail<'invalid_timespan'>> {
  const match = TIMESPAN_PATTERN.exec(text.trim());
  const digits = match?.[1];
  const unit = match?.[2]?.toLowerCase();
  const unitMs = unit === undefined ? undefined : UNIT_MS[unit];
  if (digits === undefined || unit === undefined || unitMs === undefined) {
    return fail('invalid_timespan');
  }
  return ok({ ms: Number(digits) * unitMs, text: `${digits}${unit}` });
}

function requireSafeNonNegative(value: number, argument: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidArgumentError(`${argument} must be a safe integer of 0 or more`, {
      argument,
      reason: 'not_a_safe_non_negative_integer',
    });
  }
}

/**
 * The `after:` bound, in epoch seconds, for a span that ends at `nowMs`:
 * `max(0, floor((nowMs - spanMs) / 1000))`. A span longer than the time since
 * 1970 gives `0` (`after:0`, no lower bound in practice).
 *
 * `startManualJob` calls this once, when the job starts, with `clock.now()`;
 * the bound is then fixed for the job's life. Gmail's epoch `after:S` is
 * inclusive and exact to the second (spike 23, C1). It doesn't build the
 * string `after:<s>`: the caller does.
 *
 * Throws `InvalidArgumentError` when an argument isn't a safe integer of 0 or
 * more: a caller bug, not user input.
 */
export function timespanAfterSeconds(nowMs: number, spanMs: number): number {
  requireSafeNonNegative(nowMs, 'nowMs');
  requireSafeNonNegative(spanMs, 'spanMs');
  return Math.max(0, Math.floor((nowMs - spanMs) / 1000));
}
