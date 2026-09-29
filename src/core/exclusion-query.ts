/**
 * The exclusion search string for a set of threads (Solution Design §6.4 step
 * 2, ADR-0017): `(<excludeQuery>) after:<lo> before:<hi>`. Pure: no ports, no
 * clock, no logging. The exclusion search (#209) calls `buildExclusionQuery`
 * once for a whole chunk, and again with one thread for the per-thread fallback.
 *
 * The window must cover every message of every thread, because the search
 * matches per message and a thread whose only match is its oldest message
 * (or one in Spam or Trash) still has to be found (spike 23 A2, D). A window
 * that is too wide can only exclude more, which is the safe direction.
 */

import type { GmailMessage, GmailThread } from './gmail-types.ts';

/** One day, in seconds: the margin on each side of the window. */
export const EXCLUSION_WINDOW_MARGIN_SECONDS = 86_400;

/**
 * Every usable time of one message, in epoch milliseconds:
 *
 * - its `internalDate`, when it is a string of decimal digits that is a safe
 *   integer;
 * - and every header named `Date` (any letter case) that `Date.parse` turns
 *   into a finite number. An unparseable `Date` header adds nothing.
 *
 * The result may hold two times, one, or none. Labels don't matter: a draft, a
 * Spam message and a Trash message all have times (SD §6.4 step 2).
 */
export function messageTimesMs(message: GmailMessage): number[] {
  const times: number[] = [];

  const internalDate = message.internalDate;
  if (internalDate !== undefined && /^\d+$/.test(internalDate)) {
    const ms = Number(internalDate);
    if (Number.isSafeInteger(ms)) {
      times.push(ms);
    }
  }

  for (const header of message.payload?.headers ?? []) {
    if (header.name.toLowerCase() === 'date') {
      const ms = Date.parse(header.value);
      if (Number.isFinite(ms)) {
        times.push(ms);
      }
    }
  }

  return times;
}

/**
 * Build `(<excludeQuery>) after:<lo> before:<hi>` for the given threads, in
 * epoch seconds.
 *
 * - `excludeQuery` goes in **verbatim** inside one pair of parentheses: never
 *   parsed, escaped or trimmed.
 * - `lo` is one day before the earliest usable time of any message, floored to
 *   the second. When any message has no usable time, or `lo` would be 0 or
 *   less, the `after:` term is left out (no lower bound).
 * - `hi` is one day after the later of `nowMs` and the latest usable time,
 *   rounded up to the second.
 *
 * `threads` are threads as a metadata `threads.get` returns them
 * (`metadataHeaders: ['Date']`); full-format threads work too. `nowMs` is the
 * caller's `clock.now()`.
 *
 * @throws Error when `threads` holds no messages at all, or `nowMs` isn't
 * finite. Both are caller bugs.
 */
export function buildExclusionQuery(
  excludeQuery: string,
  threads: readonly GmailThread[],
  nowMs: number,
): string {
  if (!Number.isFinite(nowMs)) {
    throw new Error('buildExclusionQuery: nowMs must be a finite number');
  }

  let messageCount = 0;
  let allDated = true;
  let earliestMs = Infinity;
  let latestMs = nowMs;

  for (const thread of threads) {
    for (const message of thread.messages ?? []) {
      messageCount += 1;
      const times = messageTimesMs(message);
      if (times.length === 0) {
        allDated = false;
      }
      for (const time of times) {
        earliestMs = Math.min(earliestMs, time);
        latestMs = Math.max(latestMs, time);
      }
    }
  }

  if (messageCount === 0) {
    throw new Error('buildExclusionQuery: there are no messages to build a window for');
  }

  const hi = Math.ceil(latestMs / 1000) + EXCLUSION_WINDOW_MARGIN_SECONDS;
  const before = `before:${String(hi)}`;

  if (allDated) {
    const lo = Math.floor(earliestMs / 1000) - EXCLUSION_WINDOW_MARGIN_SECONDS;
    if (lo > 0) {
      return `(${excludeQuery}) after:${String(lo)} ${before}`;
    }
  }
  return `(${excludeQuery}) ${before}`;
}
