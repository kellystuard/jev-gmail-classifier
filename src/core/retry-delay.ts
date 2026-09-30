/**
 * The retry policy for Jev requests: how long to wait, and which header values
 * to honour (Solution Design §8.5). Pure: the sender (`app/jev-sender.ts`)
 * passes in its `RandomPort` and the clock's `now()`.
 */

import { InvalidArgumentError } from './errors.ts';

/** SD §8.5: the first send plus two retries. The sender decides who is retried. */
export const MAX_ATTEMPTS = 3;

/** SD §8.5: the backoff before jitter after the first failed attempt. */
export const BASE_DELAY_MS = 500;

/** SD §8.5: the backoff before jitter never exceeds this. */
export const MAX_BACKOFF_MS = 5000;

/** SD §8.5: jitter shortens the backoff by up to this fraction of it. */
export const JITTER_FRACTION = 0.25;

/** SD §8.5: a header asking for a longer wait means "don't retry in this run". */
export const MAX_RETRY_AFTER_MS = 60_000;

/** A source of numbers in [0, 1). `RandomPort` fits it; core can't import ports/. */
export type RandomSource = { next(): number };

/**
 * The wait before retrying a request whose attempt `attempt` (1-based) just
 * failed, in whole ms, or `undefined` when it must not be retried in this run
 * (`retryAfterMs` is over `MAX_RETRY_AFTER_MS`).
 *
 * The wait is the larger of the header's value and the backoff,
 * `min(MAX_BACKOFF_MS, BASE_DELAY_MS × 2^(attempt − 1))` times
 * `1 − JITTER_FRACTION × random.next()`, rounded up. With `MAX_ATTEMPTS = 3`
 * only attempts 1 and 2 are retried, so the backoff is 375–500 ms and
 * 750–1,000 ms; the 5 s cap applies only if `MAX_ATTEMPTS` is raised.
 * `random.next()` is called once per call, even when the header wins.
 *
 * Throws `InvalidArgumentError` for an `attempt` that isn't an integer >= 1, a
 * `retryAfterMs` that is negative or not finite, or a random value outside
 * [0, 1). It doesn't know `MAX_ATTEMPTS`: the caller decides whether an
 * attempt is retried at all.
 */
export function retryDelay(
  attempt: number,
  retryAfterMs: number | undefined,
  random: RandomSource,
): number | undefined {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new InvalidArgumentError('attempt must be an integer of at least 1', {
      argument: 'attempt',
      reason: 'not_a_positive_integer',
    });
  }
  if (retryAfterMs !== undefined && !(Number.isFinite(retryAfterMs) && retryAfterMs >= 0)) {
    throw new InvalidArgumentError('retryAfterMs must be a non-negative finite number', {
      argument: 'retryAfterMs',
      reason: 'negative_or_not_finite',
    });
  }
  const draw = random.next();
  if (!(draw >= 0 && draw < 1)) {
    throw new InvalidArgumentError('random.next() must return a number in [0, 1)', {
      argument: 'random',
      reason: 'outside_unit_interval',
    });
  }
  if (retryAfterMs !== undefined && retryAfterMs > MAX_RETRY_AFTER_MS) {
    return undefined;
  }
  const backoff =
    Math.min(MAX_BACKOFF_MS, BASE_DELAY_MS * 2 ** (attempt - 1)) * (1 - JITTER_FRACTION * draw);
  return Math.ceil(Math.max(backoff, retryAfterMs ?? 0));
}

const DECIMAL = /^\d+(?:\.\d+)?$/;

/** A non-negative decimal number, or `undefined`. */
function parseDecimal(value: string): number | undefined {
  return DECIMAL.test(value) ? Number(value) : undefined;
}

/**
 * The wait the response's headers ask for, in ms, or `undefined` if none is
 * usable. Header names are lower-case (the `HttpPort` contract).
 *
 * `retry-after-ms` (milliseconds) wins when usable. Otherwise `retry-after`
 * is seconds (times 1,000) or an HTTP date (`max(0, date − nowMs)`). A value
 * that is none of these is ignored, so the next header is tried. Never throws:
 * the values come from the server. Nothing is rounded here.
 */
export function parseRetryAfter(
  headers: Readonly<Record<string, string>>,
  nowMs: number,
): number | undefined {
  const ms = parseDecimal((headers['retry-after-ms'] ?? '').trim());
  if (ms !== undefined) {
    return ms;
  }
  const value = (headers['retry-after'] ?? '').trim();
  const seconds = parseDecimal(value);
  if (seconds !== undefined) {
    return seconds * 1000;
  }
  // An HTTP date has a day or month name; this keeps `Date.parse` from reading
  // a stray number such as "-1" as a year.
  if (/[A-Za-z]/.test(value)) {
    const date = Date.parse(value);
    if (Number.isFinite(date)) {
      return Math.max(0, date - nowMs);
    }
  }
  return undefined;
}
