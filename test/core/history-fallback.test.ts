import { describe, expect, it } from 'vitest';

import { JevClassifierError, StateError } from '../../src/core/errors.ts';
import {
  advanceFallback,
  canStopEarly,
  FALLBACK_KEY,
  FALLBACK_LOOKBACK_SECONDS,
  FALLBACK_MAX_PAGES,
  FALLBACK_MAX_WINDOW_SECONDS,
  FALLBACK_MIN_WINDOW_SECONDS,
  type FallbackCursor,
  type FallbackWindow,
  fallbackCursorCodec,
  fallbackWindow,
  isFallbackDone,
  planWindow,
  shrinkWindow,
  startFallback,
} from '../../src/core/history-fallback.ts';
import {
  QUEUE_MAX_ITEMS,
  QUEUE_MAX_MANUAL_ITEMS,
  type WorkItem,
  type WorkQueue,
} from '../../src/core/work-queue.ts';

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

const CURSOR: FallbackCursor = {
  historyId: '1234567890',
  oldSavedAt: 1_790_000_000_000,
  nextAfter: 1_789_996_400,
  until: 1_790_100_000,
  windowSeconds: 86_400,
  startedAt: 1_790_100_000_000,
  queued: 3,
  merged: 1,
};

function cursor(fields: Partial<FallbackCursor> = {}): FallbackCursor {
  return { ...CURSOR, ...fields };
}

function scheduled(threadId: string): WorkItem {
  return { threadId, source: 'scheduled', enqueuedAt: 1, strikes: 0 };
}

function manual(threadId: string): WorkItem {
  return { threadId, source: 'manual', enqueuedAt: 1, strikes: 0 };
}

/** Canonical order: scheduled first, then manual. */
function queueOf(nScheduled: number, nManual = 0): WorkQueue {
  return [
    ...Array.from({ length: nScheduled }, (_, i) => scheduled(`s${String(i)}`)),
    ...Array.from({ length: nManual }, (_, i) => manual(`m${String(i)}`)),
  ];
}

function ids(prefix: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}${String(i)}`);
}

describe('constants', () => {
  it('has the decided values', () => {
    expect(FALLBACK_KEY).toBe('state.fallback');
    expect(FALLBACK_LOOKBACK_SECONDS).toBe(3600);
    expect(FALLBACK_MAX_WINDOW_SECONDS).toBe(86_400);
    expect(FALLBACK_MIN_WINDOW_SECONDS).toBe(60);
    expect(FALLBACK_MAX_PAGES).toBe(20);
  });
});

describe('fallbackCursorCodec', () => {
  it('round-trips, with v first', () => {
    const stored = fallbackCursorCodec.encode(CURSOR);
    expect(JSON.stringify(stored).startsWith('{"v":1,')).toBe(true);
    expect(fallbackCursorCodec.decode(FALLBACK_KEY, stored)).toEqual(CURSOR);
  });

  it('round-trips the extremes', () => {
    for (const c of [
      cursor({ windowSeconds: 60, nextAfter: 0, queued: 0, merged: 0 }),
      cursor({ windowSeconds: 86_400, historyId: '9'.repeat(20) }),
    ]) {
      expect(fallbackCursorCodec.decode(FALLBACK_KEY, fallbackCursorCodec.encode(c))).toEqual(c);
    }
  });

  it('stays small', () => {
    expect(JSON.stringify(fallbackCursorCodec.encode(CURSOR)).length).toBeLessThan(260);
  });

  const STORED = { v: 1, ...CURSOR };

  const rejected: readonly (readonly [string, Record<string, unknown>, 'version' | 'schema'])[] = [
    ['an unknown v', { v: 2 }, 'version'],
    ['v 0', { v: 0 }, 'version'],
    ['a non-digit historyId', { historyId: '12a4' }, 'schema'],
    ['an empty historyId', { historyId: '' }, 'schema'],
    ['a 21-digit historyId', { historyId: '1'.repeat(21) }, 'schema'],
    ['a numeric historyId', { historyId: 123 }, 'schema'],
    ['a windowSeconds of 59', { windowSeconds: 59 }, 'schema'],
    ['a windowSeconds of 86,401', { windowSeconds: 86_401 }, 'schema'],
    ['a fractional windowSeconds', { windowSeconds: 60.5 }, 'schema'],
    ['a negative nextAfter', { nextAfter: -1 }, 'schema'],
    ['a fractional until', { until: 1.5 }, 'schema'],
    ['a negative oldSavedAt', { oldSavedAt: -1 }, 'schema'],
    ['a negative startedAt', { startedAt: -1 }, 'schema'],
    ['a negative queued', { queued: -1 }, 'schema'],
    ['a negative merged', { merged: -1 }, 'schema'],
    ['a string merged', { merged: '1' }, 'schema'],
    ['an extra field', { extra: true }, 'schema'],
  ];

  it.each(rejected)('rejects %s', (_name, patch, reason) => {
    const error = thrown(() => fallbackCursorCodec.decode(FALLBACK_KEY, { ...STORED, ...patch }));
    expect(error).toBeInstanceOf(StateError);
    expect(error).toMatchObject({ key: FALLBACK_KEY, reason });
  });

  it('rejects a missing field', () => {
    const raw = Object.fromEntries(Object.entries(STORED).filter(([name]) => name !== 'merged'));
    expect(() => fallbackCursorCodec.decode(FALLBACK_KEY, raw)).toThrow(StateError);
  });

  it('never puts the stored value in the error', () => {
    const raw = { v: 1, historyId: 'SECRET-value', extra: 'SECRET-key' };
    const error = thrown(() => fallbackCursorCodec.decode(FALLBACK_KEY, raw));
    expect(error).toBeInstanceOf(StateError);
    expect(error instanceof Error ? error.message : '').not.toContain('SECRET');
  });
});

describe('startFallback', () => {
  const T = 1_790_000_000_000;
  const cases: readonly (readonly [string, number, number, number, number])[] = [
    // name, oldSavedAt, now, expected nextAfter, expected until
    ['a savedAt on a whole second', T, T + 5000, 1_790_000_000 - 3600, 1_790_000_005],
    ['a savedAt 999 ms past a second', T + 999, T + 5999, 1_790_000_000 - 3600, 1_790_000_005],
    ['a now 999 ms past a second', T, T + 5999, 1_790_000_000 - 3600, 1_790_000_005],
    ['a savedAt under an hour after the epoch', 3_599_999, T, 0, 1_790_000_000],
    ['a savedAt of exactly one hour', 3_600_000, T, 0, 1_790_000_000],
    ['a savedAt one second past an hour', 3_601_000, T, 1, 1_790_000_000],
    ['a savedAt of 0', 0, T, 0, 1_790_000_000],
    ['a savedAt in the future', T + 10_000_000, T, 1_790_010_000 - 3600, 1_790_000_000],
  ];

  it.each(cases)('%s', (_name, oldSavedAt, now, nextAfter, until) => {
    expect(startFallback({ historyId: '42', oldSavedAt, now })).toEqual({
      historyId: '42',
      oldSavedAt,
      nextAfter,
      until,
      windowSeconds: 86_400,
      startedAt: now,
      queued: 0,
      merged: 0,
    });
  });

  it('gives a cursor that passes the codec', () => {
    const started = startFallback({ historyId: '42', oldSavedAt: T, now: T + 1 });
    expect(fallbackCursorCodec.decode(FALLBACK_KEY, fallbackCursorCodec.encode(started))).toEqual(
      started,
    );
  });

  it('is done at once for a savedAt far in the future', () => {
    const started = startFallback({ historyId: '42', oldSavedAt: T + 10_000_000_000, now: T });
    expect(isFallbackDone(started)).toBe(true);
  });

  it.each([
    ['a negative oldSavedAt', -1, T],
    ['a fractional oldSavedAt', 1.5, T],
    ['a negative now', T, -1],
    ['a NaN now', T, Number.NaN],
  ])('throws on %s (a caller bug)', (_name, oldSavedAt, now) => {
    expect(() => startFallback({ historyId: '42', oldSavedAt, now })).toThrow(JevClassifierError);
  });
});

describe('fallbackWindow', () => {
  const cases: readonly (readonly [string, Partial<FallbackCursor>, number, number, string])[] = [
    [
      'a full 1-day window',
      { nextAfter: 1_000_000, windowSeconds: 86_400, until: 2_000_000 },
      1_000_000,
      1_086_399,
      'after:1000000 before:1086399',
    ],
    [
      'the last window, clipped at until',
      { nextAfter: 1_000_000, windowSeconds: 86_400, until: 1_050_000 },
      1_000_000,
      1_050_000,
      'after:1000000 before:1050000',
    ],
    [
      'a one-second window when nextAfter equals until',
      { nextAfter: 1_050_000, windowSeconds: 3600, until: 1_050_000 },
      1_050_000,
      1_050_000,
      'after:1050000 before:1050000',
    ],
    [
      'a window that ends exactly at until',
      { nextAfter: 1_000_000, windowSeconds: 60, until: 1_000_059 },
      1_000_000,
      1_000_059,
      'after:1000000 before:1000059',
    ],
    [
      'the smallest window',
      { nextAfter: 1_000_000, windowSeconds: 60, until: 2_000_000 },
      1_000_000,
      1_000_059,
      'after:1000000 before:1000059',
    ],
    [
      'a window from the epoch',
      { nextAfter: 0, windowSeconds: 60, until: 2_000_000 },
      0,
      59,
      'after:0 before:59',
    ],
  ];

  it.each(cases)('%s', (_name, patch, after, before, q) => {
    expect(fallbackWindow(cursor(patch))).toEqual({ after, before, q });
  });

  it('throws on a done cursor', () => {
    expect(() => fallbackWindow(cursor({ nextAfter: 11, until: 10 }))).toThrow(JevClassifierError);
  });
});

describe('isFallbackDone', () => {
  it.each([
    ['nextAfter well before until', 5, 10, false],
    ['nextAfter equal to until', 10, 10, false],
    ['nextAfter one past until', 11, 10, true],
    ['nextAfter far past until', 100, 10, true],
  ])('%s', (_name, nextAfter, until, done) => {
    expect(isFallbackDone(cursor({ nextAfter, until }))).toBe(done);
  });
});

describe('planWindow', () => {
  const FULL = QUEUE_MAX_ITEMS;

  it('takes all when they fit', () => {
    expect(
      planWindow({
        queue: queueOf(10),
        matchedIds: ids('n', 50),
        complete: true,
        windowSeconds: 86_400,
      }),
    ).toEqual({ kind: 'take_all' });
  });

  it('takes all of an empty result', () => {
    expect(
      planWindow({ queue: queueOf(0), matchedIds: [], complete: true, windowSeconds: 86_400 }),
    ).toEqual({ kind: 'take_all' });
  });

  it('takes all when the new matches exactly fill the room', () => {
    expect(
      planWindow({
        queue: queueOf(FULL - 5),
        matchedIds: ids('n', 5),
        complete: true,
        windowSeconds: 86_400,
      }),
    ).toEqual({ kind: 'take_all' });
  });

  it('takes all when only merges hit a full queue', () => {
    const queue = queueOf(FULL);
    expect(
      planWindow({
        queue,
        matchedIds: ['s0', 's1', 's999'],
        complete: true,
        windowSeconds: 86_400,
      }),
    ).toEqual({ kind: 'take_all' });
  });

  it('counts a duplicate ID once', () => {
    expect(
      planWindow({
        queue: queueOf(FULL - 1),
        matchedIds: ['n0', 'n0', 'n0'],
        complete: true,
        windowSeconds: 86_400,
      }),
    ).toEqual({ kind: 'take_all' });
  });

  it('counts merges as no room used, mixed with new matches', () => {
    // 995 queued: room 5. Two merges plus five new: fits.
    expect(
      planWindow({
        queue: queueOf(FULL - 5),
        matchedIds: ['s0', 's1', ...ids('n', 5)],
        complete: true,
        windowSeconds: 86_400,
      }),
    ).toEqual({ kind: 'take_all' });
  });

  it.each([86_400, 43_200, 120, 61])(
    'shrinks at %i s when the new matches exceed the room',
    (w) => {
      expect(
        planWindow({
          queue: queueOf(FULL - 5),
          matchedIds: ids('n', 6),
          complete: true,
          windowSeconds: w,
        }),
      ).toEqual({ kind: 'shrink' });
    },
  );

  it('shrinks a full queue with a new match', () => {
    expect(
      planWindow({
        queue: queueOf(FULL),
        matchedIds: ['n0'],
        complete: true,
        windowSeconds: 3600,
      }),
    ).toEqual({ kind: 'shrink' });
  });

  it('never takes all when the search is incomplete', () => {
    for (const w of [86_400, 120, 60]) {
      const plan = planWindow({
        queue: queueOf(0),
        matchedIds: ids('n', 3),
        complete: false,
        windowSeconds: w,
      });
      expect(plan.kind).not.toBe('take_all');
    }
  });

  it('shrinks an incomplete search above the smallest window', () => {
    expect(
      planWindow({
        queue: queueOf(0),
        matchedIds: ids('n', 3),
        complete: false,
        windowSeconds: 120,
      }),
    ).toEqual({ kind: 'shrink' });
  });

  it('waits at 60 s when it does not fit and a scheduled item is queued', () => {
    expect(
      planWindow({
        queue: queueOf(FULL - 5),
        matchedIds: ids('n', 6),
        complete: true,
        windowSeconds: 60,
      }),
    ).toEqual({ kind: 'wait' });
  });

  it('waits at 60 s with a scheduled item queued among manual ones', () => {
    expect(
      planWindow({
        queue: queueOf(1, QUEUE_MAX_MANUAL_ITEMS),
        matchedIds: ids('n', 2000),
        complete: false,
        windowSeconds: 60,
      }),
    ).toEqual({ kind: 'wait' });
  });

  it('takes some at 60 s when only manual items are queued', () => {
    const queue = queueOf(0, QUEUE_MAX_MANUAL_ITEMS);
    const room = FULL - QUEUE_MAX_MANUAL_ITEMS; // 800
    const matchedIds = ids('n', room + 7);
    const plan = planWindow({ queue, matchedIds, complete: true, windowSeconds: 60 });
    expect(plan.kind).toBe('take_some');
    if (plan.kind !== 'take_some') {
      return;
    }
    expect(plan.take).toEqual(matchedIds.slice(0, room));
    expect(plan.missed).toBe(7);
  });

  it('takes the first matches as returned, whatever they are, and every queued match', () => {
    const queue = queueOf(0, QUEUE_MAX_MANUAL_ITEMS);
    const room = FULL - QUEUE_MAX_MANUAL_ITEMS;
    // The queued match sits after the room's worth of new ones: it is still taken.
    const matchedIds = [...ids('z', room), 'm3', 'extra1', 'extra2'];
    const plan = planWindow({ queue, matchedIds, complete: true, windowSeconds: 60 });
    expect(plan).toEqual({
      kind: 'take_some',
      take: [...ids('z', room), 'm3'],
      missed: 2,
    });
  });

  it('takes some of an incomplete search at 60 s, reporting a lower bound of 0', () => {
    expect(
      planWindow({
        queue: queueOf(0),
        matchedIds: ids('n', 3),
        complete: false,
        windowSeconds: 60,
      }),
    ).toEqual({ kind: 'take_some', take: ids('n', 3), missed: 0 });
  });

  it('ignores duplicates when taking some', () => {
    const queue = queueOf(0, QUEUE_MAX_MANUAL_ITEMS);
    const room = FULL - QUEUE_MAX_MANUAL_ITEMS;
    const matchedIds = [...ids('n', room), 'n0', 'n1', 'x', 'x'];
    expect(planWindow({ queue, matchedIds, complete: true, windowSeconds: 60 })).toEqual({
      kind: 'take_some',
      take: ids('n', room),
      missed: 1,
    });
  });
});

describe('canStopEarly', () => {
  const FULL = QUEUE_MAX_ITEMS;
  it.each([
    ['no matches', queueOf(0), [], false],
    ['new matches equal to the room', queueOf(FULL - 3), ids('n', 3), false],
    ['one more new match than the room', queueOf(FULL - 3), ids('n', 4), true],
    ['only merges into a full queue', queueOf(FULL), ['s0', 's1'], false],
    ['a new match into a full queue', queueOf(FULL), ['s0', 'n0'], true],
    ['duplicates of one new match', queueOf(FULL - 1), ['n0', 'n0', 'n0'], false],
  ])('%s', (_name, queue, matchedIds, expected) => {
    expect(canStopEarly({ queue, matchedIds })).toBe(expected);
  });
});

describe('shrinkWindow', () => {
  it.each([
    [86_400, 43_200],
    [43_200, 21_600],
    [121, 60],
    [120, 60],
    [100, 60],
    [60, 60],
  ])('halves %i to %i', (from, to) => {
    expect(shrinkWindow(cursor({ windowSeconds: from })).windowSeconds).toBe(to);
  });

  it('takes 11 halvings to get from 1 day to 60 s, and keeps the rest', () => {
    let c = cursor({ windowSeconds: 86_400 });
    let steps = 0;
    while (c.windowSeconds > FALLBACK_MIN_WINDOW_SECONDS) {
      c = shrinkWindow(c);
      steps += 1;
    }
    expect(steps).toBe(11);
    expect(c).toEqual({ ...CURSOR, windowSeconds: 60 });
  });
});

describe('advanceFallback', () => {
  it('moves past the window and adds the totals', () => {
    const c = cursor({ nextAfter: 1000, windowSeconds: 60, queued: 3, merged: 1 });
    const window = fallbackWindow(c);
    expect(advanceFallback(c, window, { queued: 5, merged: 2 })).toEqual({
      ...c,
      nextAfter: 1060,
      windowSeconds: 120,
      queued: 8,
      merged: 3,
    });
  });

  it('does not change its input', () => {
    const c = cursor();
    const copy = { ...c };
    advanceFallback(c, fallbackWindow(c), { queued: 1, merged: 1 });
    expect(c).toEqual(copy);
  });

  it('advances past a clipped last window, and is then done', () => {
    const c = cursor({ nextAfter: 1000, until: 1010, windowSeconds: 3600 });
    const next = advanceFallback(c, fallbackWindow(c), { queued: 0, merged: 0 });
    expect(next.nextAfter).toBe(1011);
    expect(isFallbackDone(next)).toBe(true);
  });

  it.each([
    [60, 120],
    [1000, 2000],
    [43_200, 86_400],
    [50_000, 86_400],
    [86_400, 86_400],
  ])('doubles %i to %i and never past 86,400', (from, to) => {
    const c = cursor({ windowSeconds: from });
    expect(advanceFallback(c, fallbackWindow(c), { queued: 0, merged: 0 }).windowSeconds).toBe(to);
  });

  it('grows back to 1 day after a shrink and successes', () => {
    let c = cursor({ windowSeconds: 86_400, until: 10_000_000, nextAfter: 0 });
    for (let i = 0; i < 11; i += 1) {
      c = shrinkWindow(c);
    }
    expect(c.windowSeconds).toBe(60);
    let successes = 0;
    while (c.windowSeconds < FALLBACK_MAX_WINDOW_SECONDS) {
      c = advanceFallback(c, fallbackWindow(c), { queued: 0, merged: 0 });
      successes += 1;
    }
    expect(successes).toBe(11);
  });
});

describe('a whole fallback', () => {
  const T = 1_790_000_000_000;

  function walk(started: FallbackCursor, shrinkAt: ReadonlySet<number>): FallbackWindow[] {
    const windows: FallbackWindow[] = [];
    let c = started;
    let step = 0;
    while (!isFallbackDone(c)) {
      if (shrinkAt.has(step)) {
        c = shrinkWindow(c);
        step += 1;
        continue;
      }
      const window = fallbackWindow(c);
      windows.push(window);
      c = advanceFallback(c, window, { queued: 1, merged: 0 });
      step += 1;
    }
    return windows;
  }

  it.each([
    ['a 3-day outage', T - 3 * 86_400_000 - 12_345, T + 777, new Set<number>()],
    ['a 3-day outage with shrinks', T - 3 * 86_400_000, T + 999, new Set([0, 1, 2, 5, 9, 14])],
    ['an outage shorter than the lookback', T - 60_000, T, new Set<number>()],
    ['an outage of one second', T - 1000, T, new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])],
    ['a savedAt near the epoch', 5000, 3 * 86_400_000, new Set([0, 1])],
  ])('%s: no gap, no overlap, ends at until', (_name, oldSavedAt, now, shrinkAt) => {
    const started = startFallback({ historyId: '1', oldSavedAt, now });
    const windows = walk(started, shrinkAt);
    expect(windows.length).toBeGreaterThan(0);
    expect(windows[0]?.after).toBe(started.nextAfter);
    for (let i = 1; i < windows.length; i += 1) {
      expect(windows[i]?.after).toBe((windows[i - 1]?.before ?? Number.NaN) + 1);
    }
    for (const window of windows) {
      expect(window.before).toBeGreaterThanOrEqual(window.after);
    }
    expect(windows[windows.length - 1]?.before).toBe(started.until);
  });

  it('covers every second exactly once', () => {
    const started = startFallback({ historyId: '1', oldSavedAt: 10_000_000, now: 10_500_000 });
    const counts = new Map<number, number>();
    for (const window of walk(started, new Set([0, 3]))) {
      for (let s = window.after; s <= window.before; s += 1) {
        counts.set(s, (counts.get(s) ?? 0) + 1);
      }
    }
    expect(counts.size).toBe(started.until - started.nextAfter + 1);
    expect([...counts.values()].every((n) => n === 1)).toBe(true);
  });
});
