/**
 * The pure half of the resumable expired-history fallback (Solution Design
 * §6.3 "Expired position", §7.3; epic #9 decisions 1, 4, 5 and 15; story #72,
 * option B). `ingest` (#73) wires it in. Nothing here reads or writes state or
 * calls Gmail.
 *
 * When Gmail no longer accepts the saved position (a 404), ingest catches up by
 * searching **fixed time windows**, oldest first, from an hour before the last
 * successful ingest up to the moment of the 404, and saves a `FallbackCursor`
 * after each window, across as many runs as it takes. It uses `after:` and
 * `before:` epoch-second bounds, not `threads.list` page tokens: the bounds are
 * exact to the second and **both inclusive** (`spikes/23-exclusion-query.md`,
 * group C1), so windows `[a, b]` and `[b + 1, c]` cover every second exactly
 * once.
 *
 * Units: `oldSavedAt`, `startedAt` and every `now` are epoch **milliseconds**.
 * `nextAfter`, `until` and the window bounds are epoch **seconds**.
 *
 * A caller loop, for one window:
 * 1. `fallbackWindow(cursor)` gives the query.
 * 2. Search it, page by page, collecting distinct thread IDs. After each page,
 *    stop when `canStopEarly` is true, or when `FALLBACK_MAX_PAGES` pages have
 *    been read (`complete: false` either way).
 * 3. `planWindow` says what to do: queue every match (`take_all`, then
 *    `advanceFallback`), search again with a smaller window (`shrink`, then
 *    `shrinkWindow`), stop for this run (`wait`), or queue some and report the
 *    rest (`take_some`, then `advanceFallback`).
 * 4. Save the queue, then the cursor. When `isFallbackDone`, finish.
 */
import { z } from 'zod';

import { JevClassifierError } from './errors.ts';
import { defineStateCodec } from './state-codec.ts';
import { QUEUE_MAX_ITEMS, type WorkQueue } from './work-queue.ts';

/** The state key of the cursor. It exists only while a fallback is running. */
export const FALLBACK_KEY = 'state.fallback';

/** The first window starts this long before the old position's `savedAt`. */
export const FALLBACK_LOOKBACK_SECONDS = 3600;

/** The starting window size, and the most a window grows back to (1 day). */
export const FALLBACK_MAX_WINDOW_SECONDS = 86_400;

/** The smallest window. */
export const FALLBACK_MIN_WINDOW_SECONDS = 60;

/** A search that reaches this many pages without finishing "doesn't fit". */
export const FALLBACK_MAX_PAGES = 20;

/**
 * The fallback's progress (`state.fallback`, version 1). About 200 bytes.
 * Stored as `{"v": 1, ...cursor}`.
 */
export type FallbackCursor = {
  /** From `getProfile()` at the 404: the position to resume history from. */
  readonly historyId: string;
  /** Epoch ms: the expired position's `savedAt`. */
  readonly oldSavedAt: number;
  /** Epoch s: the next window's `after:` bound. */
  readonly nextAfter: number;
  /** Epoch s: `Math.floor(startedAt / 1000)`, the last second to search. */
  readonly until: number;
  /** The next window's size in seconds. */
  readonly windowSeconds: number;
  /** Epoch ms: when the 404 was seen. */
  readonly startedAt: number;
  /** Threads queued so far, for logs. */
  readonly queued: number;
  /** Threads merged into existing items so far, for logs. */
  readonly merged: number;
};

const nonNegativeInteger = z.number().int().min(0);

/**
 * `historyId` is 1 to 20 decimal digits (the same rule as the position's).
 * Times and counts are non-negative integers. A bad value throws `StateError`
 * and is never reset.
 */
export const fallbackCursorCodec = defineStateCodec({
  version: 1,
  schema: z.strictObject({
    historyId: z.string().regex(/^[0-9]{1,20}$/),
    oldSavedAt: nonNegativeInteger,
    nextAfter: nonNegativeInteger,
    until: nonNegativeInteger,
    windowSeconds: z
      .number()
      .int()
      .min(FALLBACK_MIN_WINDOW_SECONDS)
      .max(FALLBACK_MAX_WINDOW_SECONDS),
    startedAt: nonNegativeInteger,
    queued: nonNegativeInteger,
    merged: nonNegativeInteger,
  }),
});

/** One window's search: inclusive epoch-second bounds and the Gmail query. */
export type FallbackWindow = {
  readonly after: number;
  readonly before: number;
  /** `after:<after> before:<before>`. */
  readonly q: string;
};

/** What to do with a window's matches. */
export type WindowPlan =
  /** Queue every match. */
  | { readonly kind: 'take_all' }
  /** Halve the window and search again (`shrinkWindow`). */
  | { readonly kind: 'shrink' }
  /** Stop for this run (back-pressure): a later run gets room. */
  | { readonly kind: 'wait' }
  /**
   * Queue `take` and report `missed`, a lower bound when the search was
   * incomplete. `take` keeps the order of `matchedIds`.
   */
  | { readonly kind: 'take_some'; readonly take: readonly string[]; readonly missed: number };

/**
 * Starts a fallback. `historyId` is from `getProfile()`; `oldSavedAt` and
 * `now` are epoch ms. A `nextAfter` below the epoch is 0. An `oldSavedAt` in
 * the future (a clock problem) gives a cursor that is done at once.
 * Throws `JevClassifierError` when `oldSavedAt` or `now` isn't a non-negative
 * integer.
 */
export function startFallback(input: {
  readonly historyId: string;
  readonly oldSavedAt: number;
  readonly now: number;
}): FallbackCursor {
  const { historyId, oldSavedAt, now } = input;
  for (const [field, value] of [
    ['oldSavedAt', oldSavedAt],
    ['now', now],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new JevClassifierError('A fallback time must be a non-negative integer of ms', {
        field,
      });
    }
  }
  return {
    historyId,
    oldSavedAt,
    nextAfter: Math.max(Math.floor(oldSavedAt / 1000) - FALLBACK_LOOKBACK_SECONDS, 0),
    until: Math.floor(now / 1000),
    windowSeconds: FALLBACK_MAX_WINDOW_SECONDS,
    startedAt: now,
    queued: 0,
    merged: 0,
  };
}

/** True when every second up to `until` has been searched. */
export function isFallbackDone(cursor: FallbackCursor): boolean {
  return cursor.nextAfter > cursor.until;
}

/**
 * The next window: `[nextAfter, min(nextAfter + windowSeconds - 1, until)]`.
 * Throws `JevClassifierError` when the cursor is done (a caller bug).
 */
export function fallbackWindow(cursor: FallbackCursor): FallbackWindow {
  if (isFallbackDone(cursor)) {
    throw new JevClassifierError('The fallback is done: there is no next window', {
      nextAfter: cursor.nextAfter,
      until: cursor.until,
    });
  }
  const after = cursor.nextAfter;
  const before = Math.min(after + cursor.windowSeconds - 1, cursor.until);
  return { after, before, q: `after:${String(after)} before:${String(before)}` };
}

type Matches = {
  /** The distinct matches, in the order given. */
  readonly distinct: readonly string[];
  /** The distinct matches that aren't in the queue, in the order given. */
  readonly fresh: readonly string[];
  /** How many more items the queue can hold. */
  readonly room: number;
};

function classifyMatches(queue: WorkQueue, matchedIds: readonly string[]): Matches {
  const inQueue = new Set(queue.map((item) => item.threadId));
  const distinct = [...new Set(matchedIds)];
  return {
    distinct,
    fresh: distinct.filter((id) => !inQueue.has(id)),
    room: Math.max(QUEUE_MAX_ITEMS - queue.length, 0),
  };
}

/**
 * Decides what to do with a window's matches. `matchedIds` are the thread IDs
 * the search returned so far (duplicates are ignored); `complete` is false when
 * it stopped early (at the page bound, or because `canStopEarly`). A merge
 * (a match already queued) always succeeds and uses no room; room is
 * `QUEUE_MAX_ITEMS` minus the queue's length.
 *
 * 1. `complete` and the new matches fit: `take_all`.
 * 2. Otherwise, above the smallest window: `shrink`.
 * 3. Otherwise, with a `scheduled` item queued: `wait` (processing drains
 *    scheduled items first).
 * 4. Otherwise (at most `QUEUE_MAX_MANUAL_ITEMS` manual items, so at least 800
 *    free places): `take_some`, the queued matches plus the first `room` new
 *    ones as returned, and `missed` the other new ones.
 */
export function planWindow(input: {
  readonly queue: WorkQueue;
  readonly matchedIds: readonly string[];
  readonly complete: boolean;
  readonly windowSeconds: number;
}): WindowPlan {
  const { queue, matchedIds, complete, windowSeconds } = input;
  const { distinct, fresh, room } = classifyMatches(queue, matchedIds);
  if (complete && fresh.length <= room) {
    return { kind: 'take_all' };
  }
  if (windowSeconds > FALLBACK_MIN_WINDOW_SECONDS) {
    return { kind: 'shrink' };
  }
  if (queue.some((item) => item.source === 'scheduled')) {
    return { kind: 'wait' };
  }
  const dropped = new Set(fresh.slice(room));
  return {
    kind: 'take_some',
    take: distinct.filter((id) => !dropped.has(id)),
    missed: dropped.size,
  };
}

/**
 * True once the new matches exceed the room, so paging the window further
 * can't make it fit. The caller stops paging and passes `complete: false`.
 */
export function canStopEarly(input: {
  readonly queue: WorkQueue;
  readonly matchedIds: readonly string[];
}): boolean {
  const { fresh, room } = classifyMatches(input.queue, input.matchedIds);
  return fresh.length > room;
}

/** Halves the window, to at least `FALLBACK_MIN_WINDOW_SECONDS`. */
export function shrinkWindow(cursor: FallbackCursor): FallbackCursor {
  return {
    ...cursor,
    windowSeconds: Math.max(Math.floor(cursor.windowSeconds / 2), FALLBACK_MIN_WINDOW_SECONDS),
  };
}

/**
 * Moves past a finished window: `nextAfter` becomes `window.before + 1`, the
 * window doubles (to at most `FALLBACK_MAX_WINDOW_SECONDS`), and the totals
 * grow by what this window queued and merged.
 */
export function advanceFallback(
  cursor: FallbackCursor,
  window: FallbackWindow,
  totals: { readonly queued: number; readonly merged: number },
): FallbackCursor {
  return {
    ...cursor,
    nextAfter: window.before + 1,
    windowSeconds: Math.min(cursor.windowSeconds * 2, FALLBACK_MAX_WINDOW_SECONDS),
    queued: cursor.queued + totals.queued,
    merged: cursor.merged + totals.merged,
  };
}
