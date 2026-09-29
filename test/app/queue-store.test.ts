import { describe, expect, it } from 'vitest';

import { loadQueue, saveQueue } from '../../src/app/queue-store.ts';
import { StateError } from '../../src/core/errors.ts';
import {
  STATE_STORE_MAX_BYTES,
  STATE_VALUE_MAX_BYTES,
  utf8ByteLength,
} from '../../src/core/state-limits.ts';
import {
  dequeue,
  enqueue,
  QUEUE_MAX_ITEMS,
  QUEUE_MAX_SHARDS,
  type WorkItem,
  type WorkQueue,
} from '../../src/core/work-queue.ts';
import { createFakePorts } from '../fakes/fake-ports.ts';
import type { FakeState } from '../fakes/fake-state.ts';

const PREFIX = 'state.queue.';
const BASE = 9_999_999_999_000;

/** The largest item the type allows, with a distinct `enqueuedAt` so the list stays in canonical order. */
function worstCase(i: number, source: WorkItem['source'] = 'scheduled'): WorkItem {
  return {
    threadId: String(i).padStart(4, '0').padEnd(32, 'Z'),
    source,
    enqueuedAt: BASE + i,
    strikes: 2,
    positionSavedAt: 9_999_999_999_999,
    firstClassification: false,
    applyMoves: false,
  };
}

function worstCases(count: number, source: WorkItem['source'] = 'scheduled', from = 0): WorkItem[] {
  return Array.from({ length: count }, (_, i) => worstCase(from + i, source));
}

function newState(): FakeState {
  return createFakePorts().state;
}

function shardKeys(state: FakeState): string[] {
  return Object.keys(state.snapshot()).filter((key) => key.startsWith(PREFIX));
}

function writeCalls(state: FakeState): string[] {
  return state.calls
    .filter((call) => call.method === 'set' || call.method === 'delete')
    .map((call) => `${call.method} ${String(call.args[0])}`);
}

function setCount(state: FakeState): number {
  return state.calls.filter((call) => call.method === 'set').length;
}

function ids(queue: WorkQueue): string[] {
  return queue.map((entry) => entry.threadId);
}

/** The IDs in both queues: the items a save must never lose, wherever it stops. */
function survivors(before: WorkQueue, after: WorkQueue): string[] {
  const kept = new Set(ids(after));
  return ids(before).filter((id) => kept.has(id));
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

describe('loadQueue and saveQueue', () => {
  it('loads an empty queue from an empty store', () => {
    expect(loadQueue(newState())).toEqual([]);
  });

  it('leaves no state.queue.* key when saving an empty queue', () => {
    const state = newState();
    saveQueue(state, []);
    expect(shardKeys(state)).toEqual([]);
    expect(writeCalls(state)).toEqual([]);
  });

  it('round-trips a small queue, in canonical order', () => {
    const state = newState();
    const queue: WorkQueue = [
      { threadId: 'abc', source: 'scheduled', enqueuedAt: 10, strikes: 1, positionSavedAt: 5 },
      {
        threadId: 'def',
        source: 'manual',
        enqueuedAt: 1,
        strikes: 0,
        firstClassification: false,
        applyMoves: true,
      },
    ];
    saveQueue(state, queue);
    expect(shardKeys(state)).toEqual(['state.queue.0']);
    expect(state.snapshot()['state.queue.0']).toBe(JSON.stringify({ v: 1, items: queue }));
    expect(loadQueue(state)).toEqual(queue);
  });

  it('puts a stored queue in canonical order whatever order it is stored in', () => {
    const state = newState();
    const manual: WorkItem = { threadId: 'm', source: 'manual', enqueuedAt: 1, strikes: 0 };
    const late: WorkItem = { threadId: 'late', source: 'scheduled', enqueuedAt: 9, strikes: 0 };
    const early: WorkItem = { threadId: 'early', source: 'scheduled', enqueuedAt: 2, strikes: 0 };
    state.seedRaw('state.queue.0', JSON.stringify({ v: 1, items: [manual, late] }));
    state.seedRaw('state.queue.1', JSON.stringify({ v: 1, items: [early] }));
    expect(loadQueue(state)).toEqual([early, late, manual]);
  });

  it('round-trips 1,000 worst-case items in at most 24 shards, under the store limits', () => {
    const state = newState();
    const queue = worstCases(QUEUE_MAX_ITEMS);
    saveQueue(state, queue);
    const keys = shardKeys(state);
    expect(keys.length).toBeLessThanOrEqual(QUEUE_MAX_SHARDS);
    for (const key of keys) {
      expect(utf8ByteLength(state.snapshot()[key] ?? '')).toBeLessThanOrEqual(
        STATE_VALUE_MAX_BYTES,
      );
    }
    expect(state.bytesUsed()).toBeLessThan(STATE_STORE_MAX_BYTES);
    expect(loadQueue(state)).toEqual(queue);
  });

  it('round-trips a full queue of the caps: 800 scheduled and 200 manual worst-case items', () => {
    const state = newState();
    const queue = [...worstCases(800), ...worstCases(200, 'manual', 800)];
    saveQueue(state, queue);
    expect(shardKeys(state).length).toBeLessThanOrEqual(QUEUE_MAX_SHARDS);
    expect(loadQueue(state)).toEqual(queue);
  });

  it('deletes the shards past the new last one when the queue shrinks', () => {
    const state = newState();
    saveQueue(state, worstCases(150));
    const before = shardKeys(state);
    expect(before.length).toBeGreaterThanOrEqual(3);
    const small = worstCases(10);
    saveQueue(state, small);
    expect(shardKeys(state)).toEqual(['state.queue.0']);
    expect(loadQueue(state)).toEqual(small);
    saveQueue(state, []);
    expect(shardKeys(state)).toEqual([]);
  });

  it('makes no set call when saving an unchanged queue', () => {
    const state = newState();
    const queue = worstCases(150);
    saveQueue(state, queue);
    const calls = state.calls.length;
    saveQueue(state, queue);
    expect(state.calls.slice(calls).filter((call) => call.method === 'set')).toEqual([]);
    expect(writeCalls(state).length).toBe(state.calls.filter((c) => c.method === 'set').length);
  });

  it('makes no set call when saving a queue that was just loaded', () => {
    const state = newState();
    saveQueue(state, worstCases(150));
    const loaded = loadQueue(state);
    const sets = setCount(state);
    saveQueue(state, loaded);
    expect(setCount(state)).toBe(sets);
  });

  it('rewrites only the shards that changed', () => {
    const state = newState();
    const queue = worstCases(150);
    saveQueue(state, queue);
    const sets = setCount(state);
    // The last item's strike count changes, so only the last shard's text does.
    const last = queue[queue.length - 1];
    if (last === undefined) throw new Error('empty');
    saveQueue(state, [...queue.slice(0, -1), { ...last, strikes: 1 }]);
    expect(setCount(state) - sets).toBe(1);
  });

  it('reads state.queue.10 after state.queue.9, not after state.queue.1', () => {
    const state = newState();
    const item = (threadId: string): WorkItem => ({
      threadId,
      source: 'scheduled',
      enqueuedAt: 5,
      strikes: 0,
    });
    for (const [n, threadId] of [
      [10, 'ten'],
      [2, 'two'],
      [1, 'one'],
      [9, 'nine'],
    ] as const) {
      state.seedRaw(`state.queue.${String(n)}`, JSON.stringify({ v: 1, items: [item(threadId)] }));
    }
    // Equal times keep the load order, which is the shard order.
    expect(ids(loadQueue(state))).toEqual(['one', 'two', 'nine', 'ten']);
  });

  it('removes a duplicate by threadId, keeping the first in shard order', () => {
    const state = newState();
    const first: WorkItem = { threadId: 'dup', source: 'scheduled', enqueuedAt: 1, strikes: 1 };
    const second: WorkItem = { threadId: 'dup', source: 'scheduled', enqueuedAt: 1, strikes: 2 };
    state.seedRaw('state.queue.0', JSON.stringify({ v: 1, items: [first] }));
    state.seedRaw('state.queue.1', JSON.stringify({ v: 1, items: [second] }));
    expect(loadQueue(state)).toEqual([first]);
  });
});

describe('invalid state', () => {
  it.each<[string, string, 'version' | 'schema' | 'parse']>([
    ['an unknown version', '{"v":2,"items":[]}', 'version'],
    [
      '3 strikes',
      '{"v":1,"items":[{"threadId":"a","source":"scheduled","enqueuedAt":1,"strikes":3}]}',
      'schema',
    ],
    ['bad JSON', '{"v":1,"items":[', 'parse'],
  ])('throws StateError for %s and leaves the store alone', (_name, text, reason) => {
    const state = newState();
    state.seedRaw('state.queue.0', text);
    const error = thrown(() => loadQueue(state));
    expect(error).toBeInstanceOf(StateError);
    expect(error).toMatchObject({ reason });
    expect(state.snapshot()).toEqual({ 'state.queue.0': text });
  });

  it('throws StateError bad_key for a key that is not a shard number', () => {
    const state = newState();
    state.seedRaw('state.queue.x', '{"v":1,"items":[]}');
    expect(thrown(() => loadQueue(state))).toMatchObject({ reason: 'bad_key' });
  });

  it('throws StateError too_large, and writes nothing, when the queue needs more than 24 shards', () => {
    const state = newState();
    saveQueue(state, worstCases(10));
    const before = state.snapshot();
    const writes = writeCalls(state).length;
    const error = thrown(() => {
      saveQueue(state, worstCases(1300));
    });
    expect(error).toBeInstanceOf(StateError);
    expect(error).toMatchObject({ reason: 'too_large' });
    expect(state.snapshot()).toEqual(before);
    expect(writeCalls(state)).toHaveLength(writes);
  });
});

describe('a save that fails part-way', () => {
  const boom = new Error('boom');

  /**
   * Saves `before`, then saves `after` with the `k`th `set` (counting from 0)
   * failing, for every `k` up to the number of writes the save makes. After
   * each, `loadQueue` must return every item that is in both `before` and
   * `after`: a duplicate, or a removed item coming back, is allowed. A loss
   * isn't.
   */
  function expectNoLossAtEveryStep(before: WorkQueue, after: WorkQueue): void {
    const dry = newState();
    saveQueue(dry, before);
    const start = dry.calls.length;
    saveQueue(dry, after);
    const sets = dry.calls.slice(start).filter((call) => call.method === 'set').length;
    expect(sets).toBeGreaterThanOrEqual(2);

    for (let k = 0; k < sets; k++) {
      const state = newState();
      saveQueue(state, before);
      state.failNext('set', boom, { after: k });
      expect(
        thrown(() => {
          saveQueue(state, after);
        }),
      ).toBe(boom);
      const loaded = ids(loadQueue(state));
      const missing = survivors(before, after).filter((id) => !loaded.includes(id));
      expect(missing, `after ${String(k)} successful sets`).toEqual([]);
    }

    // With no failure, the stored queue is exactly the new one.
    const done = newState();
    saveQueue(done, before);
    saveQueue(done, after);
    expect(loadQueue(done)).toEqual(after);
  }

  it('loses no item when the second set fails after a dequeue from the first shard', () => {
    const before = worstCases(150);
    const first = before[0];
    if (first === undefined) throw new Error('empty');
    const after = dequeue(before, first.threadId);

    const state = newState();
    saveQueue(state, before);
    state.failNext('set', boom, { after: 1 });
    expect(
      thrown(() => {
        saveQueue(state, after);
      }),
    ).toBe(boom);
    const loaded = ids(loadQueue(state));
    expect(survivors(before, after).filter((id) => !loaded.includes(id))).toEqual([]);

    expectNoLossAtEveryStep(before, after);
  });

  it('loses no item when the second set fails after a new scheduled item goes ahead of a full shard of manual items', () => {
    const before = worstCases(120, 'manual');
    const result = enqueue(before, {
      // As long as any stored item, so it can't fit in the free bytes of the first shard.
      threadId: 'n'.repeat(32),
      source: 'scheduled',
      enqueuedAt: 9_999_999_999_999,
      positionSavedAt: 9_999_999_999_999,
      firstClassification: false,
      applyMoves: false,
    });
    if (!result.ok) throw new Error('expected ok');
    const after = result.queue;
    expect(after[0]?.threadId).toBe('n'.repeat(32));

    const state = newState();
    saveQueue(state, before);
    state.failNext('set', boom, { after: 1 });
    expect(
      thrown(() => {
        saveQueue(state, after);
      }),
    ).toBe(boom);
    const loaded = ids(loadQueue(state));
    expect(survivors(before, after).filter((id) => !loaded.includes(id))).toEqual([]);

    expectNoLossAtEveryStep(before, after);
  });

  it('loses no item when items grow and later items move along', () => {
    // A merge that sets positionSavedAt and firstClassification makes an item longer,
    // which can push the last item of a full shard into the next one.
    const before: WorkItem[] = Array.from({ length: 150 }, (_, i) => ({
      threadId: worstCase(i).threadId,
      source: 'scheduled',
      enqueuedAt: BASE + i,
      strikes: 0,
    }));
    const after = before.map((entry, i) =>
      i % 3 === 0
        ? { ...entry, positionSavedAt: 9_999_999_999_999, firstClassification: false }
        : entry,
    );
    expectNoLossAtEveryStep(before, after);
  });
});
