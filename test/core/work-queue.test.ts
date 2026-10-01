import { describe, expect, it } from 'vitest';

import { JevClassifierError, StateError } from '../../src/core/errors.ts';
import { splitIntoShards } from '../../src/core/sharding.ts';
import { STATE_VALUE_MAX_BYTES, utf8ByteLength } from '../../src/core/state-limits.ts';
import {
  addStrike,
  canonicalOrder,
  dequeue,
  enqueue,
  type EnqueueRequest,
  QUEUE_MAX_ITEMS,
  QUEUE_MAX_MANUAL_ITEMS,
  QUEUE_MAX_SHARDS,
  setFirstClassification,
  takeChunk,
  type WorkItem,
  workQueueShardCodec,
  type WorkQueue,
} from '../../src/core/work-queue.ts';

const T0 = 1_790_000_000_000;

function item(threadId: string, fields: Partial<WorkItem> = {}): WorkItem {
  return { threadId, source: 'scheduled', enqueuedAt: T0, strikes: 0, ...fields };
}

function request(threadId: string, fields: Partial<EnqueueRequest> = {}): EnqueueRequest {
  return { threadId, source: 'scheduled', enqueuedAt: T0, ...fields };
}

function ids(queue: WorkQueue): string[] {
  return queue.map((entry) => entry.threadId);
}

/** Enqueues `request` and returns the resulting queue, failing the test on `full`. */
function enqueued(queue: WorkQueue, req: EnqueueRequest): { queue: WorkQueue; outcome: string } {
  const result = enqueue(queue, req);
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.kind}`);
  }
  return result;
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

function fill(count: number, source: WorkItem['source'], from = 0): WorkItem[] {
  return Array.from({ length: count }, (_, i) =>
    item(`${source}${String(from + i)}`, { source, enqueuedAt: T0 + from + i }),
  );
}

describe('canonical order', () => {
  it.each<[string, WorkItem[], string[]]>([
    [
      'scheduled before manual, whatever the times',
      [
        item('m1', { source: 'manual', enqueuedAt: 1 }),
        item('s1', { enqueuedAt: 9 }),
        item('m2', { source: 'manual', enqueuedAt: 2 }),
        item('s2', { enqueuedAt: 8 }),
      ],
      ['s2', 's1', 'm1', 'm2'],
    ],
    [
      'oldest first within a source',
      [item('c', { enqueuedAt: 3 }), item('a', { enqueuedAt: 1 }), item('b', { enqueuedAt: 2 })],
      ['a', 'b', 'c'],
    ],
    [
      'ties keep their existing order',
      [item('x', { enqueuedAt: 5 }), item('y', { enqueuedAt: 5 }), item('z', { enqueuedAt: 5 })],
      ['x', 'y', 'z'],
    ],
    ['an empty queue', [], []],
  ])('%s', (_name, input, expected) => {
    const before = [...input];
    expect(ids(canonicalOrder(input))).toEqual(expected);
    expect(input).toEqual(before);
  });

  it('keeps ties stable in a long run of equal times', () => {
    const input = Array.from({ length: 50 }, (_, i) => item(`t${String(i)}`, { enqueuedAt: 7 }));
    expect(ids(canonicalOrder(input))).toEqual(ids(input));
  });

  it('puts a new item in order, ties after the items already queued', () => {
    const start: WorkQueue = [
      item('s1', { enqueuedAt: 10 }),
      item('s3', { enqueuedAt: 30 }),
      item('m1', { source: 'manual', enqueuedAt: 1 }),
    ];
    const { queue } = enqueued(start, request('s2', { enqueuedAt: 20 }));
    expect(ids(queue)).toEqual(['s1', 's2', 's3', 'm1']);
    const tied = enqueued(start, request('s1b', { enqueuedAt: 10 })).queue;
    expect(ids(tied)).toEqual(['s1', 's1b', 's3', 'm1']);
  });

  it('re-sorts after a merge changes source', () => {
    const start: WorkQueue = [
      item('s1', { enqueuedAt: 10 }),
      item('m1', { source: 'manual', enqueuedAt: 5 }),
      item('m2', { source: 'manual', enqueuedAt: 6 }),
    ];
    const { queue } = enqueued(start, request('m2', { source: 'manual', enqueuedAt: 6 }));
    expect(ids(queue)).toEqual(['s1', 'm1', 'm2']);
    const promoted = enqueued(start, request('m2', { source: 'scheduled', enqueuedAt: 6 })).queue;
    expect(ids(promoted)).toEqual(['m2', 's1', 'm1']);
    expect(promoted[0]?.source).toBe('scheduled');
  });

  it('re-sorts after a merge lowers enqueuedAt', () => {
    const start: WorkQueue = [
      item('a', { enqueuedAt: 10 }),
      item('b', { enqueuedAt: 20 }),
      item('c', { enqueuedAt: 30 }),
    ];
    const { queue } = enqueued(start, request('c', { enqueuedAt: 5 }));
    expect(ids(queue)).toEqual(['c', 'a', 'b']);
  });
});

describe('enqueue: a new thread', () => {
  it('queues it with strikes 0 and no optional fields the request left out', () => {
    const result = enqueued([], request('abc123'));
    expect(result.outcome).toBe('queued');
    expect(result.queue).toEqual([
      { threadId: 'abc123', source: 'scheduled', enqueuedAt: T0, strikes: 0 },
    ]);
    expect(Object.keys(result.queue[0] ?? {})).toEqual([
      'threadId',
      'source',
      'enqueuedAt',
      'strikes',
    ]);
  });

  it('keeps exactly the optional fields the request sets, in the fixed order', () => {
    const result = enqueued(
      [],
      request('abc', {
        applyMoves: false,
        firstClassification: true,
        positionSavedAt: 42,
        source: 'manual',
      }),
    );
    expect(Object.keys(result.queue[0] ?? {})).toEqual([
      'threadId',
      'source',
      'enqueuedAt',
      'strikes',
      'positionSavedAt',
      'firstClassification',
      'applyMoves',
    ]);
    expect(result.queue[0]).toMatchObject({
      positionSavedAt: 42,
      firstClassification: true,
      applyMoves: false,
    });
  });

  it('does not store resetStrikes', () => {
    const result = enqueued([], request('abc', { resetStrikes: true }));
    expect(result.queue[0]).not.toHaveProperty('resetStrikes');
  });

  it('does not change the queue it was given', () => {
    const start: WorkQueue = [item('a')];
    enqueued(start, request('b'));
    expect(start).toEqual([item('a')]);
  });
});

describe('enqueue: merging into an existing thread', () => {
  const existing = (fields: Partial<WorkItem> = {}): WorkQueue => [item('t1', fields)];

  it.each<[string, WorkQueue, EnqueueRequest, Partial<WorkItem>]>([
    [
      'source: scheduled wins over an existing manual',
      existing({ source: 'manual' }),
      request('t1', { source: 'scheduled' }),
      { source: 'scheduled' },
    ],
    [
      'source: scheduled wins over a manual request',
      existing({ source: 'scheduled' }),
      request('t1', { source: 'manual' }),
      { source: 'scheduled' },
    ],
    [
      'source: manual stays manual',
      existing({ source: 'manual' }),
      request('t1', { source: 'manual' }),
      { source: 'manual' },
    ],
    [
      'applyMoves: true if the request says so',
      existing({ source: 'manual' }),
      request('t1', { source: 'manual', applyMoves: true }),
      { applyMoves: true },
    ],
    [
      'applyMoves: true if the existing item has it',
      existing({ source: 'manual', applyMoves: true }),
      request('t1', { source: 'manual', applyMoves: false }),
      { applyMoves: true },
    ],
    [
      'enqueuedAt: the earlier one, when the request is earlier',
      existing({ enqueuedAt: 500 }),
      request('t1', { enqueuedAt: 100 }),
      { enqueuedAt: 100 },
    ],
    [
      'enqueuedAt: the earlier one, when the existing item is earlier',
      existing({ enqueuedAt: 100 }),
      request('t1', { enqueuedAt: 500 }),
      { enqueuedAt: 100 },
    ],
    [
      'firstClassification: a decided value survives, true over false',
      existing({ firstClassification: true }),
      request('t1', { firstClassification: false }),
      { firstClassification: true },
    ],
    [
      'firstClassification: a decided value survives, false over true',
      existing({ firstClassification: false }),
      request('t1', { firstClassification: true }),
      { firstClassification: false },
    ],
    [
      "firstClassification: taken from the request when the item's is unset",
      existing(),
      request('t1', { firstClassification: false }),
      { firstClassification: false },
    ],
    ['firstClassification: stays unset when neither sets it', existing(), request('t1'), {}],
    [
      'positionSavedAt: an existing value survives',
      existing({ positionSavedAt: 111 }),
      request('t1', { positionSavedAt: 999 }),
      { positionSavedAt: 111 },
    ],
    [
      "positionSavedAt: taken from the request when the item's is unset",
      existing(),
      request('t1', { positionSavedAt: 999 }),
      { positionSavedAt: 999 },
    ],
    ['strikes: kept', existing({ strikes: 2 }), request('t1'), { strikes: 2 }],
    [
      'strikes: reset to 0 by resetStrikes',
      existing({ strikes: 2 }),
      request('t1', { resetStrikes: true }),
      { strikes: 0 },
    ],
  ])('%s', (_name, start, req, expected) => {
    const result = enqueued(start, req);
    expect(result.outcome).toBe('merged');
    expect(result.queue).toHaveLength(1);
    const base = start[0];
    expect(result.queue[0]).toEqual({ ...base, ...expected });
  });

  it('leaves applyMoves absent when neither side is true', () => {
    const { queue } = enqueued(
      existing({ source: 'manual', applyMoves: false }),
      request('t1', { source: 'manual', applyMoves: false }),
    );
    expect(queue[0]).not.toHaveProperty('applyMoves');
  });

  it('merges to one item with the fields in the fixed order', () => {
    const result = enqueued(
      existing({ firstClassification: true }),
      request('t1', { positionSavedAt: 9, applyMoves: true }),
    );
    expect(Object.keys(result.queue[0] ?? {})).toEqual([
      'threadId',
      'source',
      'enqueuedAt',
      'strikes',
      'positionSavedAt',
      'firstClassification',
      'applyMoves',
    ]);
  });

  it('does not change the queue it was given', () => {
    const start = existing({ source: 'manual', strikes: 1 });
    enqueued(start, request('t1', { resetStrikes: true }));
    expect(start).toEqual(existing({ source: 'manual', strikes: 1 }));
  });
});

describe('enqueue: the caps', () => {
  it('reports the 1,001st new thread as full (total) and leaves the queue as it was', () => {
    const start = fill(QUEUE_MAX_ITEMS, 'scheduled');
    expect(start).toHaveLength(1000);
    const result = enqueue(start, request('one-too-many'));
    expect(result).toEqual({ ok: false, kind: 'full', cap: 'total' });
    expect(start).toHaveLength(1000);
  });

  it('accepts the 1,000th new thread', () => {
    const start = fill(QUEUE_MAX_ITEMS - 1, 'scheduled');
    expect(enqueued(start, request('last')).queue).toHaveLength(1000);
  });

  it('reports a manual thread as full (total) when the queue is full, before the manual cap', () => {
    const start = fill(QUEUE_MAX_ITEMS, 'scheduled');
    expect(enqueue(start, request('m', { source: 'manual' }))).toEqual({
      ok: false,
      kind: 'full',
      cap: 'total',
    });
  });

  it('merges into a full queue', () => {
    const start = fill(QUEUE_MAX_ITEMS, 'scheduled');
    const result = enqueued(start, request('scheduled500', { enqueuedAt: 1, resetStrikes: true }));
    expect(result.outcome).toBe('merged');
    expect(result.queue).toHaveLength(1000);
    expect(result.queue[0]).toMatchObject({ threadId: 'scheduled500', enqueuedAt: 1 });
  });

  it('reports the 201st manual thread as full (manual)', () => {
    const start = fill(QUEUE_MAX_MANUAL_ITEMS, 'manual');
    expect(start).toHaveLength(200);
    expect(enqueue(start, request('m-extra', { source: 'manual' }))).toEqual({
      ok: false,
      kind: 'full',
      cap: 'manual',
    });
  });

  it('accepts the 200th manual thread', () => {
    const start = fill(QUEUE_MAX_MANUAL_ITEMS - 1, 'manual');
    expect(enqueued(start, request('m-last', { source: 'manual' })).queue).toHaveLength(200);
  });

  it('still queues a scheduled thread when the manual sub-cap is reached', () => {
    const start = fill(QUEUE_MAX_MANUAL_ITEMS, 'manual');
    const result = enqueued(start, request('s', { enqueuedAt: 5 }));
    expect(result.outcome).toBe('queued');
    expect(result.queue).toHaveLength(201);
    expect(result.queue[0]?.threadId).toBe('s');
  });

  it('merges a manual request into an existing item at the manual sub-cap', () => {
    const start = fill(QUEUE_MAX_MANUAL_ITEMS, 'manual');
    const result = enqueued(start, request('manual7', { source: 'manual', applyMoves: true }));
    expect(result.outcome).toBe('merged');
    expect(result.queue).toHaveLength(200);
  });

  it('counts only manual items against the manual sub-cap', () => {
    const start = [...fill(300, 'scheduled'), ...fill(QUEUE_MAX_MANUAL_ITEMS - 1, 'manual')];
    expect(enqueued(start, request('m', { source: 'manual' })).outcome).toBe('queued');
  });
});

describe('takeChunk', () => {
  const queue: WorkQueue = [item('a'), item('b'), item('c'), item('m', { source: 'manual' })];

  it.each<[number, string[]]>([
    [1, ['a']],
    [3, ['a', 'b', 'c']],
    [4, ['a', 'b', 'c', 'm']],
    [10, ['a', 'b', 'c', 'm']],
  ])('takes the first %i in order', (n, expected) => {
    expect(ids(takeChunk(queue, n))).toEqual(expected);
  });

  it('removes nothing', () => {
    takeChunk(queue, 2);
    expect(ids(queue)).toEqual(['a', 'b', 'c', 'm']);
  });

  it('gives an empty chunk from an empty queue', () => {
    expect(takeChunk([], 5)).toEqual([]);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects n = %s', (n) => {
    expect(thrown(() => takeChunk(queue, n))).toBeInstanceOf(JevClassifierError);
  });

  it.each<[string[], number, string[]]>([
    [['a'], 2, ['b', 'c']],
    [['b'], 3, ['a', 'c', 'm']],
    [['a', 'c'], 10, ['b', 'm']],
    [['a', 'b', 'c', 'm'], 5, []],
    [['zzz'], 2, ['a', 'b']],
    [[], 2, ['a', 'b']],
  ])('skips the excluded IDs %j and keeps canonical order', (excluded, n, expected) => {
    expect(ids(takeChunk(queue, n, new Set(excluded)))).toEqual(expected);
  });

  it('still validates n with an exclude set', () => {
    expect(thrown(() => takeChunk(queue, 0, new Set(['a'])))).toBeInstanceOf(JevClassifierError);
  });

  it('leaves the exclude set and the queue unchanged', () => {
    const excluded = new Set(['a']);
    takeChunk(queue, 2, excluded);
    expect([...excluded]).toEqual(['a']);
    expect(ids(queue)).toEqual(['a', 'b', 'c', 'm']);
  });
});

describe('takeChunk with a source', () => {
  const queue: WorkQueue = [
    item('s1'),
    item('m1', { source: 'manual', enqueuedAt: T0 + 1 }),
    item('s2', { enqueuedAt: T0 + 2 }),
    item('m2', { source: 'manual', enqueuedAt: T0 + 3 }),
    item('s3', { enqueuedAt: T0 + 4 }),
  ];

  it.each<[WorkItem['source'], number, string[]]>([
    ['scheduled', 2, ['s1', 's2']],
    ['scheduled', 10, ['s1', 's2', 's3']],
    ['manual', 1, ['m1']],
    ['manual', 10, ['m1', 'm2']],
  ])('takes only %s items (n = %i)', (source, n, expected) => {
    expect(ids(takeChunk(queue, n, undefined, source))).toEqual(expected);
  });

  it.each<[WorkItem['source'], string[], string[]]>([
    ['scheduled', ['s1'], ['s2', 's3']],
    ['manual', ['m1'], ['m2']],
    ['manual', ['s1', 'zzz'], ['m1', 'm2']],
    ['scheduled', ['s1', 's2', 's3'], []],
  ])('with source %s skips the excluded %j', (source, excluded, expected) => {
    expect(ids(takeChunk(queue, 10, new Set(excluded), source))).toEqual(expected);
  });

  it('applies the source with an empty exclude set', () => {
    expect(ids(takeChunk(queue, 10, new Set(), 'manual'))).toEqual(['m1', 'm2']);
  });

  it('gives nothing when no item has the source', () => {
    expect(takeChunk([item('a')], 3, undefined, 'manual')).toEqual([]);
  });

  it('still validates n', () => {
    expect(thrown(() => takeChunk(queue, 0, undefined, 'manual'))).toBeInstanceOf(
      JevClassifierError,
    );
  });
});

describe('dequeue', () => {
  const queue: WorkQueue = [item('a'), item('b'), item('c')];

  it('removes a known ID', () => {
    const next = dequeue(queue, 'b');
    expect(ids(next)).toEqual(['a', 'c']);
    expect(ids(queue)).toEqual(['a', 'b', 'c']);
  });

  it('returns the queue unchanged for an unknown ID, so a repeat is harmless', () => {
    expect(dequeue(queue, 'zzz')).toBe(queue);
    expect(dequeue(dequeue(queue, 'b'), 'b')).toEqual([item('a'), item('c')]);
  });
});

describe('addStrike', () => {
  it('counts 1, 2 and then removes the item at 3', () => {
    const start: WorkQueue = [item('a'), item('b')];
    const first = addStrike(start, 'b');
    expect(first.strikes).toBe(1);
    expect(first.queue).toEqual([item('a'), item('b', { strikes: 1 })]);
    const second = addStrike(first.queue, 'b');
    expect(second.strikes).toBe(2);
    expect(second.queue).toEqual([item('a'), item('b', { strikes: 2 })]);
    const third = addStrike(second.queue, 'b');
    expect(third.strikes).toBe(3);
    expect(ids(third.queue)).toEqual(['a']);
    expect(start).toEqual([item('a'), item('b')]);
  });

  it('keeps the other fields and their order', () => {
    const start: WorkQueue = [
      item('a', { positionSavedAt: 5, firstClassification: true, applyMoves: true }),
    ];
    const next = addStrike(start, 'a').queue[0];
    expect(Object.keys(next ?? {})).toEqual(Object.keys(start[0] ?? {}));
    expect(next).toMatchObject({ positionSavedAt: 5, firstClassification: true, applyMoves: true });
  });

  it('throws for an unknown ID, naming the thread', () => {
    const error = thrown(() => addStrike([item('a')], 'zzz'));
    expect(error).toBeInstanceOf(JevClassifierError);
    expect(error).toMatchObject({ fields: { threadId: 'zzz' } });
  });
});

describe('setFirstClassification', () => {
  it.each<[string, boolean]>([
    ['true', true],
    ['false', false],
  ])('sets %s when the item has no value', (_name, value) => {
    const start: WorkQueue = [item('a'), item('b')];
    const next = setFirstClassification(start, 'b', value);
    expect(next).toEqual([item('a'), item('b', { firstClassification: value })]);
    expect(start).toEqual([item('a'), item('b')]);
  });

  it.each<[boolean, boolean]>([
    [true, false],
    [false, true],
    [true, true],
  ])('leaves a decided %s alone when asked for %s', (decided, asked) => {
    const start: WorkQueue = [item('a', { firstClassification: decided })];
    expect(setFirstClassification(start, 'a', asked)).toBe(start);
  });

  it('throws for an unknown ID, naming the thread', () => {
    const error = thrown(() => setFirstClassification([item('a')], 'zzz', true));
    expect(error).toBeInstanceOf(JevClassifierError);
    expect(error).toMatchObject({ fields: { threadId: 'zzz' } });
  });
});

describe('bounds on operations', () => {
  it.each<[string, Partial<EnqueueRequest>]>([
    ['an empty threadId', { threadId: '' }],
    ['a 33-character threadId', { threadId: 'a'.repeat(33) }],
    ['a threadId with a space', { threadId: 'abc def' }],
    ['a threadId with a dot', { threadId: 'abc.def' }],
    ['a negative enqueuedAt', { enqueuedAt: -1 }],
    ['a 14-digit enqueuedAt', { enqueuedAt: 10_000_000_000_000 }],
    ['a fractional enqueuedAt', { enqueuedAt: 1.5 }],
    ['a NaN enqueuedAt', { enqueuedAt: Number.NaN }],
    ['a negative positionSavedAt', { positionSavedAt: -1 }],
    ['a 14-digit positionSavedAt', { positionSavedAt: 10_000_000_000_000 }],
  ])('enqueue throws JevClassifierError for %s', (_name, fields) => {
    const error = thrown(() => enqueue([], request('okid', fields)));
    expect(error).toBeInstanceOf(JevClassifierError);
    expect(error).toMatchObject({ fields: { threadId: fields.threadId ?? 'okid' } });
  });

  it.each<[string, Partial<EnqueueRequest>]>([
    ['a 32-character threadId', { threadId: 'a'.repeat(32) }],
    ['letters, digits, underscore and hyphen', { threadId: 'Az09_-' }],
    [
      'the largest timestamps',
      { enqueuedAt: 9_999_999_999_999, positionSavedAt: 9_999_999_999_999 },
    ],
    ['zero timestamps', { enqueuedAt: 0, positionSavedAt: 0 }],
  ])('enqueue accepts %s', (_name, fields) => {
    expect(enqueue([], request('okid', fields)).ok).toBe(true);
  });

  it('checks the bounds on a merge too', () => {
    expect(thrown(() => enqueue([item('a')], request('a', { enqueuedAt: -5 })))).toBeInstanceOf(
      JevClassifierError,
    );
  });
});

describe('the shard codec', () => {
  const key = 'state.queue.0';

  it('round-trips items, with the optional fields and without', () => {
    const items: WorkItem[] = [
      item('a'),
      item('b', {
        source: 'manual',
        strikes: 2,
        positionSavedAt: 77,
        firstClassification: false,
        applyMoves: true,
      }),
    ];
    const encoded = workQueueShardCodec.encode({ items });
    expect(JSON.stringify(encoded)).toBe(JSON.stringify({ v: 1, items }));
    const decoded = workQueueShardCodec.decode(key, JSON.parse(JSON.stringify(encoded)));
    expect(decoded.items).toEqual(items);
  });

  it('round-trips an empty shard', () => {
    const encoded = workQueueShardCodec.encode({ items: [] });
    expect(JSON.stringify(encoded)).toBe('{"v":1,"items":[]}');
    expect(workQueueShardCodec.decode(key, encoded).items).toEqual([]);
  });

  it('writes each decoded item in the fixed field order, whatever order it was stored in', () => {
    const decoded = workQueueShardCodec.decode(key, {
      v: 1,
      items: [
        {
          applyMoves: true,
          firstClassification: true,
          positionSavedAt: 1,
          strikes: 1,
          enqueuedAt: 2,
          source: 'manual',
          threadId: 'abc',
        },
      ],
    });
    expect(Object.keys(decoded.items[0] ?? {})).toEqual([
      'threadId',
      'source',
      'enqueuedAt',
      'strikes',
      'positionSavedAt',
      'firstClassification',
      'applyMoves',
    ]);
  });

  it.each<[string, unknown]>([
    ['an unknown v', { v: 2, items: [] }],
    ['v 0', { v: 0, items: [] }],
  ])('throws StateError version for %s', (_name, raw) => {
    const error = thrown(() => workQueueShardCodec.decode(key, raw));
    expect(error).toBeInstanceOf(StateError);
    expect(error).toMatchObject({ key, reason: 'version' });
  });

  const good = { threadId: 'abc', source: 'scheduled', enqueuedAt: 1, strikes: 0 };
  it.each<[string, unknown]>([
    ['a missing items array', { v: 1 }],
    ['an extra shard field', { v: 1, items: [], extra: 1 }],
    ['an item that is not an object', { v: 1, items: ['abc'] }],
    ['an unknown item field', { v: 1, items: [{ ...good, extra: true }] }],
    ['a missing threadId', { v: 1, items: [{ ...good, threadId: undefined }] }],
    ['a bad threadId', { v: 1, items: [{ ...good, threadId: 'has space' }] }],
    ['a 33-character threadId', { v: 1, items: [{ ...good, threadId: 'a'.repeat(33) }] }],
    ['an unknown source', { v: 1, items: [{ ...good, source: 'other' }] }],
    ['a negative enqueuedAt', { v: 1, items: [{ ...good, enqueuedAt: -1 }] }],
    ['a 14-digit enqueuedAt', { v: 1, items: [{ ...good, enqueuedAt: 10_000_000_000_000 }] }],
    ['a fractional enqueuedAt', { v: 1, items: [{ ...good, enqueuedAt: 1.5 }] }],
    ['3 strikes', { v: 1, items: [{ ...good, strikes: 3 }] }],
    ['negative strikes', { v: 1, items: [{ ...good, strikes: -1 }] }],
    ['a 14-digit positionSavedAt', { v: 1, items: [{ ...good, positionSavedAt: 10 ** 13 }] }],
    ['a string firstClassification', { v: 1, items: [{ ...good, firstClassification: 'yes' }] }],
    ['a string applyMoves', { v: 1, items: [{ ...good, applyMoves: 'yes' }] }],
    ['a good item followed by a bad one', { v: 1, items: [good, { ...good, strikes: 3 }] }],
  ])('throws StateError schema for %s', (_name, raw) => {
    const error = thrown(() => workQueueShardCodec.decode(key, raw));
    expect(error).toBeInstanceOf(StateError);
    expect(error).toMatchObject({ key, reason: 'schema' });
  });

  it('says where the bad item is, and never what it holds', () => {
    const error = thrown(() =>
      workQueueShardCodec.decode(key, {
        v: 1,
        items: [good, { ...good, threadId: 'secret thread' }],
      }),
    );
    expect(error).toBeInstanceOf(StateError);
    expect(error instanceof Error ? error.message : '').toContain('items[1].threadId');
    expect(error instanceof Error ? error.message : '').not.toContain('secret');
  });
});

describe('the shard proof', () => {
  const worst = (i: number): WorkItem => ({
    threadId: String(i).padStart(4, '0').padEnd(32, 'Z'),
    source: 'scheduled',
    enqueuedAt: 9_999_999_999_999,
    strikes: 2,
    positionSavedAt: 9_999_999_999_999,
    firstClassification: false,
    applyMoves: false,
  });

  it('fits 1,000 worst-case items in at most QUEUE_MAX_SHARDS shards of at most STATE_VALUE_MAX_BYTES', () => {
    const items = Array.from({ length: QUEUE_MAX_ITEMS }, (_, i) => worst(i));
    expect(items[0]?.threadId).toHaveLength(32);
    const envelope = utf8ByteLength(JSON.stringify(workQueueShardCodec.encode({ items: [] })));
    const shards = splitIntoShards(items, {
      prefix: 'state.queue.',
      maxShards: QUEUE_MAX_SHARDS,
      envelopeBytes: envelope,
      itemText: (entry) => JSON.stringify(entry),
    });
    expect(shards.length).toBeLessThanOrEqual(QUEUE_MAX_SHARDS);
    expect(shards.flat()).toHaveLength(QUEUE_MAX_ITEMS);
    for (const shard of shards) {
      const text = JSON.stringify(workQueueShardCodec.encode({ items: shard }));
      expect(utf8ByteLength(text)).toBeLessThanOrEqual(STATE_VALUE_MAX_BYTES);
    }
  });
});
