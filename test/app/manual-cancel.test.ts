import { describe, expect, it } from 'vitest';

import { cancelManualJob } from '../../src/app/manual-cancel.ts';
import { loadManualJob, saveManualJob } from '../../src/app/manual-job-store.ts';
import { loadQueue, saveQueue } from '../../src/app/queue-store.ts';
import { StateError } from '../../src/core/errors.ts';
import { type ManualJob, newManualJob } from '../../src/core/manual-job.ts';
import { canonicalOrder, type WorkItem } from '../../src/core/work-queue.ts';
import { createFakePorts, type FakePorts } from '../fakes/fake-ports.ts';

const T0 = 1_790_000_000_000;

function item(threadId: string, fields: Partial<WorkItem> = {}): WorkItem {
  return { threadId, source: 'scheduled', enqueuedAt: T0, strikes: 0, ...fields };
}

function manual(threadId: string, n: number): WorkItem {
  return item(threadId, { source: 'manual', enqueuedAt: T0 + n, applyMoves: true });
}

function busyJob(): ManualJob {
  const fresh = newManualJob({ query: 'in:inbox older_than:7d', applyMoves: true, startedAt: T0 });
  return {
    ...fresh,
    executions: 4,
    counts: {
      pages: 2,
      queued: 6,
      merged: 1,
      chunks: 3,
      excluded: 1,
      skipped: 2,
      sent: 5,
      classified: 4,
      struck: 1,
      errored: 0,
      gone: 1,
      inputTokens: 1234,
    },
    labels: { Invoices: 2 },
    moves: { archive: 1 },
    otherLabels: 1,
    otherMoves: 0,
  };
}

const MANUAL_IDS = ['mAAA111', 'mBBB222', 'mCCC333'];

function setup(withJob = true) {
  const ports = createFakePorts();
  if (withJob) saveManualJob(ports.state, busyJob());
  saveQueue(
    ports.state,
    canonicalOrder([
      ...MANUAL_IDS.map((id, n) => manual(id, n)),
      item('sAAA111', { enqueuedAt: T0 + 10 }),
      item('sBBB222', { enqueuedAt: T0 + 11 }),
      item('sCCC333', {
        enqueuedAt: T0 + 12,
        applyMoves: true,
        firstClassification: true,
        strikes: 1,
      }),
    ]),
  );
  ports.state.seedInput('MANUAL_QUERY', 'in:inbox');
  ports.state.seedInput('MANUAL_APPLY_MOVES', 'true');
  ports.state.seedRaw('JEV_API_KEY', 'secret-key');
  ports.state.seedRaw('state.position', '{"v":1}');
  ports.state.seedRaw('state.runs', '{"v":1}');
  return ports;
}

function cancel(ports: FakePorts, reason: 'cancelled' | 'replaced' = 'cancelled') {
  return cancelManualJob({ state: ports.state, log: ports.log }, reason);
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

function writes(ports: FakePorts, from = 0) {
  return ports.state.calls.slice(from).filter((c) => c.method === 'set' || c.method === 'delete');
}

describe('cancelManualJob', () => {
  it('drops manual work, clears applyMoves, deletes the job and logs once', () => {
    const ports = setup();
    expect(cancel(ports)).toEqual({ cancelled: true, removed: 3 });
    expect(ports.state.snapshot()['state.manual']).toBeUndefined();
    const queue = loadQueue(ports.state);
    expect(queue.map((i) => i.threadId)).toEqual(['sAAA111', 'sBBB222', 'sCCC333']);
    expect(queue.some((i) => i.applyMoves !== undefined)).toBe(false);
    expect(queue[2]).toMatchObject({ firstClassification: true, strikes: 1 });
    expect(ports.log.events).toHaveLength(1);
    expect(ports.log.events[0]).toEqual({
      level: 'info',
      event: 'manual.cancelled',
      fields: {
        reason: 'cancelled',
        query: 'in:inbox older_than:7d',
        applyMoves: true,
        startedAt: T0,
        executions: 4,
        removed: 3,
        pages: 2,
        queued: 6,
        merged: 1,
        chunks: 3,
        excluded: 1,
        skipped: 2,
        sent: 5,
        classified: 4,
        struck: 1,
        errored: 0,
        gone: 1,
        inputTokens: 1234,
        labels: { Invoices: 2 },
        moves: { archive: 1 },
        otherLabels: 1,
        otherMoves: 0,
      },
    });
  });

  it('logs the reason it is given', () => {
    const ports = setup();
    cancel(ports, 'replaced');
    expect(ports.log.find('manual.cancelled')?.fields['reason']).toBe('replaced');
  });

  it('with no job, still drops stray manual items', () => {
    const ports = setup(false);
    expect(cancel(ports)).toEqual({ cancelled: false, removed: 3 });
    expect(loadQueue(ports.state)).toHaveLength(3);
    expect(ports.log.find('manual.cancelled')?.fields).toEqual({
      reason: 'cancelled',
      job: 'none',
      removed: 3,
    });
  });

  it('with no job and an empty queue, writes nothing', () => {
    const ports = createFakePorts();
    expect(cancel(ports)).toEqual({ cancelled: false, removed: 0 });
    expect(writes(ports)).toEqual([]);
  });

  it('is idempotent', () => {
    const ports = setup();
    cancel(ports);
    const before = ports.state.snapshot();
    const seen = ports.state.calls.length;
    expect(cancel(ports)).toEqual({ cancelled: false, removed: 0 });
    expect(ports.state.snapshot()).toEqual(before);
    expect(writes(ports, seen)).toEqual([]);
  });

  it('saves the queue before it deletes the job', () => {
    const ports = setup();
    ports.state.failNext('delete', new Error('boom'), { key: 'state.manual' });
    expect(() => cancel(ports)).toThrow('boom');
    expect(loadQueue(ports.state).some((i) => i.source === 'manual')).toBe(false);
    expect(loadManualJob(ports.state)).toBeDefined();
    expect(ports.log.events).toEqual([]);
    expect(cancel(ports)).toEqual({ cancelled: true, removed: 0 });
    expect(loadManualJob(ports.state)).toBeUndefined();
  });

  it('a failing queue write throws, keeps the job and logs nothing', () => {
    const ports = setup();
    ports.state.failNext('set', new Error('boom'));
    expect(() => cancel(ports)).toThrow('boom');
    expect(loadManualJob(ports.state)).toBeDefined();
    expect(ports.log.events).toEqual([]);
  });

  it('throws StateError for a corrupt job and changes nothing', () => {
    const ports = setup(false);
    ports.state.seedRaw('state.manual', '{"v":99}');
    const before = ports.state.snapshot();
    expect(thrown(() => cancel(ports))).toBeInstanceOf(StateError);
    expect(ports.state.snapshot()).toEqual(before);
    expect(ports.log.events).toEqual([]);
  });

  it('touches nothing else and calls no other port', () => {
    const ports = setup();
    const before = ports.state.snapshot();
    cancel(ports);
    const after = ports.state.snapshot();
    for (const key of [
      'MANUAL_QUERY',
      'MANUAL_APPLY_MOVES',
      'JEV_API_KEY',
      'state.position',
      'state.runs',
    ]) {
      expect(after[key]).toBe(before[key]);
    }
    expect(ports.gmail.calls).toEqual([]);
    expect(ports.http.calls).toEqual([]);
    const logged = JSON.stringify(ports.log.events);
    for (const id of [...MANUAL_IDS, 'sAAA111', 'sBBB222', 'sCCC333']) {
      expect(logged).not.toContain(id);
    }
  });
});
