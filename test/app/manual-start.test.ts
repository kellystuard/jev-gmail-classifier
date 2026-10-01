import { describe, expect, it } from 'vitest';

import { cancelManualJob } from '../../src/app/manual-cancel.ts';
import { loadManualJob, saveManualJob } from '../../src/app/manual-job-store.ts';
import { startManualJob } from '../../src/app/manual-start.ts';
import { loadQueue, saveQueue } from '../../src/app/queue-store.ts';
import { StateError } from '../../src/core/errors.ts';
import { newManualJob } from '../../src/core/manual-job.ts';
import { canonicalOrder, type WorkItem } from '../../src/core/work-queue.ts';
import { createFakePorts, type FakePorts } from '../fakes/fake-ports.ts';

const OLD_QUERY = 'in:inbox older_than:7d';

function item(threadId: string, fields: Partial<WorkItem> = {}): WorkItem {
  return { threadId, source: 'scheduled', enqueuedAt: 1_790_000_000_000, strikes: 0, ...fields };
}

function start(ports: FakePorts) {
  return startManualJob({ state: ports.state, clock: ports.clock, log: ports.log });
}

function setup(inputs: Record<string, string>): FakePorts {
  const ports = createFakePorts();
  for (const [name, value] of Object.entries(inputs)) ports.state.seedInput(name, value);
  return ports;
}

function seedJob(ports: FakePorts): void {
  const job = newManualJob({ query: OLD_QUERY, applyMoves: true, startedAt: 1_700_000_000_000 });
  saveManualJob(ports.state, { ...job, counts: { ...job.counts, classified: 4 } });
}

const INPUT_NAMES = ['MANUAL_QUERY', 'MANUAL_TIMESPAN', 'MANUAL_APPLY_MOVES', 'MANUAL_REPLACE'];

function expectInputsGone(ports: FakePorts): void {
  for (const name of INPUT_NAMES) expect(ports.state.getInput(name)).toBeUndefined();
}

describe('startManualJob: started', () => {
  it('starts with a query only', () => {
    const ports = setup({ MANUAL_QUERY: ' label:Receipts ' });
    const result = start(ports);
    expect(result.started).toBe(true);
    if (!result.started) return;
    expect(loadManualJob(ports.state)).toEqual(result.job);
    expect(result.job.query).toBe('label:Receipts');
    expect(result.job.startedAt).toBe(ports.clock.now());
    expect(result.job.applyMoves).toBe(false);
    expectInputsGone(ports);
    const started = ports.log.all('manual.started');
    expect(started).toHaveLength(1);
    expect(started[0]?.level).toBe('info');
    expect(started[0]?.fields).toEqual({
      query: 'label:Receipts',
      applyMoves: false,
      replaced: false,
    });
    expect(ports.gmail.calls).toEqual([]);
    expect(ports.http.calls).toEqual([]);
  });

  it.each([
    ['a timespan only', { MANUAL_TIMESPAN: '36H' }, (a: number) => `after:${String(a)}`],
    [
      'both',
      { MANUAL_QUERY: 'label:Receipts', MANUAL_TIMESPAN: '36h' },
      (a: number) => `(label:Receipts) after:${String(a)}`,
    ],
  ])('starts with %s', (_name, inputs, expected) => {
    const ports = setup(inputs);
    const after = Math.floor((ports.clock.now() - 36 * 3_600_000) / 1000);
    const result = start(ports);
    expect(result.started && result.job.query).toBe(expected(after));
    expect(loadManualJob(ports.state)?.query).toBe(expected(after));
    expect(ports.log.find('manual.started')?.fields).toEqual({
      query: expected(after),
      applyMoves: false,
      replaced: false,
      timespan: '36h',
      after,
    });
  });

  it('applies moves with MANUAL_APPLY_MOVES=true', () => {
    const ports = setup({ MANUAL_QUERY: 'a', MANUAL_APPLY_MOVES: 'TRUE' });
    const result = start(ports);
    expect(result.started && result.job.applyMoves).toBe(true);
    expect(ports.log.find('manual.started')?.fields['applyMoves']).toBe(true);
  });

  it('deletes all four inputs, set or not', () => {
    const ports = setup({ MANUAL_QUERY: 'a', MANUAL_REPLACE: 'false' });
    start(ports);
    const deleted = ports.state.calls.filter((c) => c.method === 'deleteInput');
    expect(deleted.map((c) => c.args[0])).toEqual(INPUT_NAMES);
  });
});

describe('startManualJob: refusals', () => {
  it.each([
    ['no_input', {}],
    ['query_too_long', { MANUAL_QUERY: 'a'.repeat(1001) }],
    ['invalid_query', { MANUAL_QUERY: 'a\tb' }],
    ['invalid_timespan', { MANUAL_QUERY: 'a', MANUAL_TIMESPAN: '5m' }],
    ['invalid_apply_moves', { MANUAL_QUERY: 'a', MANUAL_APPLY_MOVES: 'yes' }],
    ['invalid_replace', { MANUAL_QUERY: 'a', MANUAL_REPLACE: 'yes' }],
  ])('refuses with %s', (reason, inputs) => {
    for (const withJob of [false, true]) {
      const ports = setup(inputs);
      if (withJob) seedJob(ports);
      const before = ports.state.snapshot();
      const writes = ports.state.calls.length;
      expect(start(ports)).toEqual({ started: false, reason });
      expect(ports.state.snapshot()).toEqual(before);
      expect(
        ports.state.calls
          .slice(writes)
          .filter((c) => ['set', 'delete', 'deleteInput'].includes(c.method)),
      ).toEqual([]);
      const rejected = ports.log.all('manual.rejected');
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.level).toBe('warn');
      expect(rejected[0]?.fields).toEqual({ reason });
      expect(ports.log.find('manual.started')).toBeUndefined();
    }
  });

  it.each([
    ['unset', {}],
    ['blank', { MANUAL_REPLACE: ' ' }],
    ['false', { MANUAL_REPLACE: 'false' }],
  ])('refuses a second job with MANUAL_REPLACE %s', (_name, extra) => {
    const ports = setup({ MANUAL_QUERY: 'new', ...extra });
    seedJob(ports);
    saveQueue(ports.state, [item('mAAA111', { source: 'manual', applyMoves: true })]);
    const before = ports.state.snapshot();
    expect(start(ports)).toEqual({ started: false, reason: 'job_unfinished' });
    expect(ports.state.snapshot()).toEqual(before);
    expect(ports.log.find('manual.rejected')?.level).toBe('warn');
    expect(ports.log.find('manual.rejected')?.fields).toEqual({
      reason: 'job_unfinished',
      query: OLD_QUERY,
      startedAt: 1_700_000_000_000,
      classified: 4,
    });
    expect(ports.log.find('manual.started')).toBeUndefined();
  });
});

describe('startManualJob: replace and stray work', () => {
  it('cancels the old job first and starts the new one', () => {
    const ports = setup({ MANUAL_QUERY: 'new', MANUAL_REPLACE: 'true' });
    seedJob(ports);
    saveQueue(
      ports.state,
      canonicalOrder([
        item('mAAA111', { source: 'manual', applyMoves: true }),
        item('sAAA111', { enqueuedAt: 1_790_000_000_005 }),
      ]),
    );
    const result = start(ports);
    expect(result.started && result.job.query).toBe('new');
    expect(loadQueue(ports.state).map((i) => i.threadId)).toEqual(['sAAA111']);
    const events = ports.log.events.map((e) => e.event);
    expect(events.indexOf('manual.cancelled')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('manual.cancelled')).toBeLessThan(events.indexOf('manual.started'));
    expect(ports.log.find('manual.cancelled')?.fields['reason']).toBe('replaced');
    expect(ports.log.find('manual.started')?.fields['replaced']).toBe(true);
    expect(loadManualJob(ports.state)).toMatchObject({
      query: 'new',
      counts: { classified: 0 },
      executions: 0,
    });
    expectInputsGone(ports);
  });

  it('starts with MANUAL_REPLACE=true and no job, without cancelling', () => {
    const ports = setup({ MANUAL_QUERY: 'new', MANUAL_REPLACE: 'true' });
    const result = start(ports);
    expect(result.started).toBe(true);
    expect(ports.log.find('manual.started')?.fields['replaced']).toBe(false);
    expect(ports.log.find('manual.cancelled')).toBeUndefined();
    expect(
      ports.state.calls.some(
        (c) => c.method === 'set' && String(c.args[0]).startsWith('state.queue.'),
      ),
    ).toBe(false);
  });

  it('drops stray manual items when there is no job', () => {
    const ports = setup({ MANUAL_QUERY: 'new' });
    saveQueue(
      ports.state,
      canonicalOrder([
        item('mAAA111', { source: 'manual', applyMoves: true }),
        item('sAAA111', { enqueuedAt: 1_790_000_000_005, applyMoves: true }),
      ]),
    );
    expect(start(ports).started).toBe(true);
    const queue = loadQueue(ports.state);
    expect(queue.map((i) => i.threadId)).toEqual(['sAAA111']);
    expect(queue[0]?.applyMoves).toBeUndefined();
    expect(ports.log.find('manual.cancelled')).toBeUndefined();
  });

  it('writes no queue key when there is nothing stray', () => {
    const ports = setup({ MANUAL_QUERY: 'new' });
    start(ports);
    const writes = ports.state.calls.filter((c) => c.method === 'set' || c.method === 'delete');
    expect(writes.map((c) => c.args[0])).toEqual(['state.manual']);
  });
});

describe('startManualJob: write order and failures', () => {
  it('sets state.manual before the first deleteInput', () => {
    const ports = setup({ MANUAL_QUERY: 'a' });
    start(ports);
    const methods = ports.state.calls.map((c) => `${c.method}:${String(c.args[0])}`);
    expect(methods.indexOf('set:state.manual')).toBeLessThan(
      methods.findIndex((m) => m.startsWith('deleteInput:')),
    );
  });

  it('deletes the old job before it sets the new one on a replace', () => {
    const ports = setup({ MANUAL_QUERY: 'a', MANUAL_REPLACE: 'true' });
    seedJob(ports);
    const seeded = ports.state.calls.length;
    start(ports);
    const methods = ports.state.calls.slice(seeded).map((c) => `${c.method}:${String(c.args[0])}`);
    expect(methods.indexOf('delete:state.manual')).toBeLessThan(
      methods.indexOf('set:state.manual'),
    );
  });

  it('propagates a failed save and keeps the inputs', () => {
    const ports = setup({ MANUAL_QUERY: 'a' });
    ports.state.failNext(
      'set',
      new StateError('full', { key: 'state.manual', reason: 'store_full' }),
      { key: 'state.manual' },
    );
    expect(() => start(ports)).toThrow(StateError);
    expect(ports.state.getInput('MANUAL_QUERY')).toBe('a');
    expect(ports.log.find('manual.started')).toBeUndefined();
  });

  it('propagates a corrupt state.manual and writes nothing', () => {
    const ports = setup({ MANUAL_QUERY: 'a', MANUAL_REPLACE: 'true' });
    ports.state.seedRaw('state.manual', '{not json');
    const before = ports.state.snapshot();
    expect(() => start(ports)).toThrow(StateError);
    expect(ports.state.snapshot()).toEqual(before);
  });

  it('is undone by a cancel that the user can run again', () => {
    const ports = setup({ MANUAL_QUERY: 'a' });
    start(ports);
    expect(cancelManualJob({ state: ports.state, log: ports.log }, 'cancelled').cancelled).toBe(
      true,
    );
  });
});
