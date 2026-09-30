/**
 * The daily Gmail call tally (Solution Design §7.3, §9; epic #13 decisions 4
 * and 17): the `state.gmailCalls` codec, and the pure day rollover. The unit
 * cost of each `GmailPort` method is `GMAIL_UNIT_COST` in `./run-limits.ts`.
 * The counting wrapper and the store are in `src/app/counting-gmail.ts`.
 *
 * Stored as `{"v": 1, "day": "YYYY-MM-DD", "count": <int>}`.
 */
import { z } from 'zod';

import { InvalidArgumentError } from './errors.ts';
import { defineStateCodec } from './state-codec.ts';
import type { JsonValue } from './state-types.ts';
import { isCalendarDay } from './token-budget.ts';

/** The Script Properties key. */
export const GMAIL_CALLS_KEY = 'state.gmailCalls';

export type GmailCallTally = {
  /** The calendar day in the script's time zone, `YYYY-MM-DD`. */
  readonly day: string;
  /** Gmail calls made that day. A non-negative safe integer. */
  readonly count: number;
};

/**
 * `decode(GMAIL_CALLS_KEY, raw)` throws `StateError` `version` for an unknown
 * `v`, and `schema` for a missing `v` or a bad shape. `encode` writes `v` first.
 */
export const gmailCallsCodec = defineStateCodec({
  version: 1,
  schema: z.strictObject({
    day: z.string().refine(isCalendarDay, 'Expected a calendar day as YYYY-MM-DD'),
    count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }),
});

/** Decodes a `state.gmailCalls` value. The caller handles an absent key. Throws `StateError`. */
export function decodeGmailCalls(raw: unknown): GmailCallTally {
  return gmailCallsCodec.decode(GMAIL_CALLS_KEY, raw);
}

/** The JSON to store under `state.gmailCalls`. */
export function encodeGmailCalls(tally: GmailCallTally): JsonValue {
  return gmailCallsCodec.encode(tally);
}

/**
 * The tally for `today`: `stored` when it is for today, otherwise a fresh one
 * at 0 (an absent key, an older day, or a later one after the clock moved
 * back). Throws `InvalidArgumentError` if `today` isn't a `YYYY-MM-DD`
 * calendar day.
 */
export function gmailCallsForDay(
  stored: GmailCallTally | undefined,
  today: string,
): GmailCallTally {
  if (!isCalendarDay(today)) {
    throw new InvalidArgumentError('today must be a calendar day as YYYY-MM-DD', {
      argument: 'today',
      reason: 'not_a_day',
    });
  }
  if (stored !== undefined && stored.day === today) return stored;
  return { day: today, count: 0 };
}

/** A new tally with `calls` added (a safe integer ≥ 0), saturating at `Number.MAX_SAFE_INTEGER`. */
export function addGmailCalls(tally: GmailCallTally, calls: number): GmailCallTally {
  if (!Number.isSafeInteger(calls) || calls < 0) {
    throw new InvalidArgumentError('calls must be a safe integer of at least 0', {
      argument: 'calls',
      reason: 'invalid_number',
    });
  }
  return { day: tally.day, count: Math.min(Number.MAX_SAFE_INTEGER, tally.count + calls) };
}
