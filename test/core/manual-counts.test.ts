import { describe, expect, it } from 'vitest';

import type { ChunkResult } from '../../src/app/process-chunk.ts';
import type { MoveDestination } from '../../src/config/schema.ts';
import {
  MANUAL_COUNT_KEYS_MAX_BYTES,
  type ManualChunkInput,
  type ManualExecutionCounts,
  addChunkToExecution,
  addChunkToJob,
  emptyExecutionCounts,
  manualCompletedFields,
  manualProgressFields,
  moveKey,
} from '../../src/core/manual-counts.ts';
import {
  type ManualJob,
  decodeManualJob,
  encodeManualJob,
  manualJobReservedBytes,
  newManualJob,
} from '../../src/core/manual-job.ts';
import { recordStart, recordSuccess, type RunSummary } from '../../src/core/run-record.ts';
import { STATE_VALUE_MAX_BYTES, utf8ByteLength } from '../../src/core/state-limits.ts';
import { FakeLog } from '../fakes/fake-log.ts';

type Settlement = ManualChunkInput['settlements'][number];

const ZERO = { excluded: 0, skipped: 0, sent: 0 };

function chunk(
  settlements: readonly Settlement[],
  counts: Partial<typeof ZERO> = {},
  inputTokens = 0,
): ManualChunkInput {
  return { counts: { ...ZERO, ...counts }, inputTokens, settlements };
}

function job(): ManualJob {
  return newManualJob({ query: 'label:Receipts', applyMoves: true, startedAt: 1000 });
}

function classified(labels: string[], move?: MoveDestination): Settlement {
  return { outcome: 'classified', applied: { labels, ...(move === undefined ? {} : { move }) } };
}

describe('moveKey', () => {
  it.each<[MoveDestination, string]>([
    [{ kind: 'archive' }, 'archive'],
    [{ kind: 'spam' }, 'spam'],
    [{ kind: 'trash' }, 'trash'],
    [{ kind: 'label', label: 'A/B' }, 'label:A/B'],
  ])('%j -> %s', (move, key) => {
    expect(moveKey(move)).toBe(key);
  });
});

describe('addChunkToJob totals', () => {
  it('adds the chunk counts and one chunk, also with no settlements', () => {
    const result = addChunkToJob(job(), chunk([], { excluded: 2, skipped: 3, sent: 4 }, 50));
    expect(result.counts).toMatchObject({
      chunks: 1,
      excluded: 2,
      skipped: 3,
      sent: 4,
      inputTokens: 50,
      classified: 0,
    });
  });

  it.each(['classified', 'struck', 'errored', 'gone'] as const)('%s adds to its total', (kind) => {
    const result = addChunkToJob(job(), chunk([{ outcome: kind }, { outcome: kind }]));
    expect(result.counts[kind]).toBe(2);
  });

  it('adds nothing for untouched', () => {
    const before = job();
    const result = addChunkToJob(before, chunk([{ outcome: 'untouched' }]));
    expect(result.counts).toEqual({ ...before.counts, chunks: 1 });
    expect(result.counts).not.toHaveProperty('untouched');
  });

  it('accumulates across chunks', () => {
    let result = job();
    result = addChunkToJob(result, chunk([{ outcome: 'classified' }], { sent: 1 }, 10));
    result = addChunkToJob(result, chunk([{ outcome: 'classified' }], { sent: 1 }, 10));
    expect(result.counts).toMatchObject({ chunks: 2, classified: 2, sent: 2, inputTokens: 20 });
  });

  it('keeps the other fields and the key order, and changes no input', () => {
    const before = job();
    const input = chunk([classified(['A'], { kind: 'archive' })], { sent: 1 });
    const beforeText = JSON.stringify(before);
    const inputText = JSON.stringify(input);
    const result = addChunkToJob(before, input);
    expect(JSON.stringify(before)).toBe(beforeText);
    expect(JSON.stringify(input)).toBe(inputText);
    expect(Object.keys(result)).toEqual(Object.keys(before));
    expect(Object.keys(result.counts)).toEqual(Object.keys(before.counts));
    expect(result.cursor).toEqual(before.cursor);
    expect(result.searchDone).toBe(before.searchDone);
    expect(result.executions).toBe(before.executions);
    expect(result.query).toBe(before.query);
    expect(result.counts.pages).toBe(before.counts.pages);
    expect(result.counts.queued).toBe(before.counts.queued);
    expect(result.counts.merged).toBe(before.counts.merged);
  });
});

describe('addChunkToJob labels and moves', () => {
  it('counts several labels on one thread and the same label on several threads', () => {
    const result = addChunkToJob(
      job(),
      chunk([classified(['A', 'B']), classified(['A']), classified(['A', 'C'])]),
    );
    expect(result.labels).toEqual({ A: 3, B: 1, C: 1 });
  });

  it.each<[MoveDestination, string]>([
    [{ kind: 'archive' }, 'archive'],
    [{ kind: 'spam' }, 'spam'],
    [{ kind: 'trash' }, 'trash'],
    [{ kind: 'label', label: 'Done' }, 'label:Done'],
  ])('counts the move %j', (move, key) => {
    const result = addChunkToJob(job(), chunk([classified([], move), classified([], move)]));
    expect(result.moves).toEqual({ [key]: 2 });
    expect(result.labels).toEqual({});
  });

  it('keeps a label named archive apart from the move archive', () => {
    const result = addChunkToJob(job(), chunk([classified(['archive'], { kind: 'archive' })]));
    expect(result.labels).toEqual({ archive: 1 });
    expect(result.moves).toEqual({ archive: 1 });
  });

  it('counts unsafe names as own keys', () => {
    const names = ['constructor', 'toString', 'hasOwnProperty', '__proto__'];
    const once = addChunkToJob(job(), chunk([classified(names)]));
    const twice = addChunkToJob(once, chunk([classified(names)]));
    for (const name of names) {
      expect(Object.keys(once.labels).includes(name)).toBe(true);
      expect(Object.getOwnPropertyDescriptor(once.labels, name)?.value).toBe(1);
      expect(Object.getOwnPropertyDescriptor(twice.labels, name)?.value).toBe(2);
    }
    expect(Object.keys(twice.labels)).toEqual(names);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    expect(decodeManualJob(JSON.parse(JSON.stringify(encodeManualJob(twice))))).toEqual(twice);
  });
});

describe('addChunkToJob byte bound', () => {
  /** A name of `n` copies of `unit`. */
  const labelsOf = (unit: string, n: number): Settlement => classified([unit.repeat(n)]);

  function reservedWith(unit: string, n: number): number {
    return manualJobReservedBytes(addChunkToJob(job(), chunk([labelsOf(unit, n)])));
  }

  it('is 8000 for the constant', () => {
    expect(MANUAL_COUNT_KEYS_MAX_BYTES).toBe(8000);
  });

  it('adds a key that reaches exactly 8000, and sends one byte more to otherLabels', () => {
    const n = 8000 - reservedWith('x', 1) + 1;
    const fits = addChunkToJob(job(), chunk([labelsOf('x', n)]));
    expect(manualJobReservedBytes(fits)).toBe(8000);
    expect(fits.labels).toEqual({ ['x'.repeat(n)]: 1 });
    expect(fits.otherLabels).toBe(0);

    const over = addChunkToJob(job(), chunk([labelsOf('x', n + 1)]));
    expect(over.labels).toEqual({});
    expect(over.otherLabels).toBe(1);
  });

  it('does the same for a move key', () => {
    const probe = (n: number): ManualJob =>
      addChunkToJob(job(), chunk([classified([], { kind: 'label', label: 'x'.repeat(n) })]));
    const n = 8000 - manualJobReservedBytes(probe(1)) + 1;
    expect(manualJobReservedBytes(probe(n))).toBe(8000);
    expect(Object.keys(probe(n).moves)).toHaveLength(1);
    expect(probe(n + 1).moves).toEqual({});
    expect(probe(n + 1).otherMoves).toBe(1);
  });

  it('counts an existing key at the bound, and a second overflow in otherLabels', () => {
    const n = 8000 - reservedWith('x', 1) + 1;
    const name = 'x'.repeat(n);
    let result = addChunkToJob(job(), chunk([classified([name])]));
    result = addChunkToJob(result, chunk([classified([name, 'new', 'other'])]));
    expect(result.labels).toEqual({ [name]: 2 });
    expect(result.otherLabels).toBe(2);
  });

  it.each([
    ['é', 2],
    ['\u{1F600}', 4],
  ])('measures %s in UTF-8 bytes, not characters', (unit, bytes) => {
    const n = 1 + Math.floor((8000 - reservedWith(unit, 1)) / bytes);
    const fits = addChunkToJob(job(), chunk([labelsOf(unit, n)]));
    expect(manualJobReservedBytes(fits)).toBeLessThanOrEqual(8000);
    expect(Object.keys(fits.labels)).toHaveLength(1);
    const over = addChunkToJob(job(), chunk([labelsOf(unit, n + 1)]));
    expect(over.otherLabels).toBe(1);
    // By characters the name would still have been small.
    expect(n + 1).toBeLessThan(8000 / bytes + 2);
  });

  it('stays within one state value over 500 chunks of 20 long new keys', () => {
    let current = job();
    for (let c = 0; c < 500; c += 1) {
      const settlements: Settlement[] = [];
      for (let s = 0; s < 20; s += 1) {
        const tag = `${String(c)}-${String(s)}-`;
        settlements.push(
          classified([`${tag}${'l'.repeat(100)}`, `${tag}${'m'.repeat(60)}`], {
            kind: 'label',
            label: `${tag}${'d'.repeat(120)}`,
          }),
        );
      }
      current = addChunkToJob(current, chunk(settlements, { sent: 20 }, 1000));
      const text = JSON.stringify(encodeManualJob(current));
      expect(utf8ByteLength(text)).toBeLessThanOrEqual(STATE_VALUE_MAX_BYTES);
      expect(manualJobReservedBytes(current)).toBeLessThanOrEqual(STATE_VALUE_MAX_BYTES);
      expect(decodeManualJob(JSON.parse(text))).toEqual(current);
    }
    expect(current.counts.classified).toBe(10000);
    expect(current.otherLabels).toBeGreaterThan(0);
    expect(current.otherMoves).toBeGreaterThan(0);
  }, 60_000);
});

describe('addChunkToExecution', () => {
  it('counts every outcome, untouched included, and leaves the refill counts', () => {
    const start: ManualExecutionCounts = {
      ...emptyExecutionCounts(),
      pages: 2,
      queued: 5,
      merged: 1,
    };
    const result = addChunkToExecution(
      start,
      chunk(
        [
          { outcome: 'classified' },
          { outcome: 'struck' },
          { outcome: 'errored' },
          { outcome: 'untouched' },
          { outcome: 'gone' },
        ],
        { excluded: 1, skipped: 2, sent: 3 },
        40,
      ),
    );
    expect(result).toEqual({
      pages: 2,
      queued: 5,
      merged: 1,
      chunks: 1,
      excluded: 1,
      skipped: 2,
      sent: 3,
      classified: 1,
      struck: 1,
      errored: 1,
      untouched: 1,
      gone: 1,
      inputTokens: 40,
    });
    expect(start.chunks).toBe(0);
  });
});

describe('report fields', () => {
  const base = addChunkToJob(
    { ...job(), executions: 2, searchDone: true },
    chunk(
      [classified(['A'], { kind: 'archive' }), { outcome: 'errored' }],
      { excluded: 1, skipped: 2, sent: 2 },
      30,
    ),
  );
  const execution = {
    counts: addChunkToExecution(emptyExecutionCounts(), chunk([{ outcome: 'untouched' }])),
    stopped: 'deadline',
    manualQueued: 7,
  };

  it('manualProgressFields has exactly its fields', () => {
    const fields = manualProgressFields(base, execution);
    expect(Object.keys(fields).sort()).toEqual(
      [
        'pages',
        'queued',
        'merged',
        'chunks',
        'excluded',
        'skipped',
        'sent',
        'classified',
        'struck',
        'errored',
        'untouched',
        'gone',
        'inputTokens',
        'stopped',
        'manualQueued',
        'searchDone',
        'seen',
        'executions',
        'totalClassified',
        'totalErrored',
        'totalExcluded',
        'totalSkipped',
      ].sort(),
    );
    expect(fields).toMatchObject({
      chunks: 1,
      untouched: 1,
      stopped: 'deadline',
      manualQueued: 7,
      searchDone: true,
      seen: 0,
      executions: 2,
      totalClassified: 1,
      totalErrored: 1,
      totalExcluded: 1,
      totalSkipped: 2,
    });
    const log = new FakeLog();
    log.info('manual.progress', fields);
    expect(log.events).toHaveLength(1);
  });

  it('manualCompletedFields has exactly its fields', () => {
    const fields = manualCompletedFields(base, 5000);
    expect(Object.keys(fields).sort()).toEqual(
      [
        'query',
        'applyMoves',
        'startedAt',
        'durationMs',
        'executions',
        'pages',
        'queued',
        'merged',
        'chunks',
        'excluded',
        'skipped',
        'sent',
        'classified',
        'struck',
        'errored',
        'gone',
        'inputTokens',
        'labels',
        'moves',
        'otherLabels',
        'otherMoves',
      ].sort(),
    );
    expect(fields).toMatchObject({
      query: 'label:Receipts',
      applyMoves: true,
      startedAt: 1000,
      durationMs: 4000,
      executions: 2,
      classified: 1,
      errored: 1,
      inputTokens: 30,
      labels: { A: 1 },
      moves: { archive: 1 },
      otherLabels: 0,
      otherMoves: 0,
    });
    const log = new FakeLog();
    log.info('manual.completed', fields);
    expect(log.events).toHaveLength(1);
  });

  it('never gives a negative duration', () => {
    expect(manualCompletedFields(base, 10).durationMs).toBe(0);
  });
});

describe('types', () => {
  it('ChunkResult satisfies ManualChunkInput', () => {
    const accepts = (result: ChunkResult): ManualChunkInput => result;
    expect(typeof accepts).toBe('function');
  });

  it('ManualExecutionCounts is a RunSummary', () => {
    const counts: RunSummary = emptyExecutionCounts();
    const record = recordSuccess(recordStart(undefined, 0), 1, counts);
    expect(record.lastSummary).toEqual(emptyExecutionCounts());
  });
});
