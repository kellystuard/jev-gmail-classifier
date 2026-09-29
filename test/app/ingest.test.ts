import { afterEach, describe, expect, it } from 'vitest';

import { ingest, type IngestOptions } from '../../src/app/ingest.ts';
import { loadQueue } from '../../src/app/queue-store.ts';
import { StateError } from '../../src/core/errors.ts';
import { decodePosition, encodePosition, POSITION_KEY } from '../../src/core/position.ts';
import {
  dequeue,
  QUEUE_MAX_ITEMS,
  type WorkItem,
  type WorkQueue,
} from '../../src/core/work-queue.ts';
import { FakeGmail } from '../fakes/fake-gmail.ts';
import { createFakePorts, type FakePorts, type FakePortsOptions } from '../fakes/fake-ports.ts';
import type { FakeState } from '../fakes/fake-state.ts';

/** The seeded position's `savedAt`: an hour before the fake clock's start. */
const SAVED_AT = Date.UTC(2026, 8, 26, 11);

let world: FakePorts | undefined;

afterEach(() => {
  // Ingest makes no per-thread reads (epic decision 6).
  expect(world?.gmail.calls.map((c) => c.method).filter((m) => m !== 'listHistory')).toEqual([]);
  world = undefined;
});

/** Fake ports with `state.position` seeded at the mailbox's current `historyId`. */
function setup(options: FakePortsOptions = {}): FakePorts {
  const ports = createFakePorts(options);
  ports.state.seedRaw(
    POSITION_KEY,
    JSON.stringify(encodePosition({ historyId: ports.gmail.historyId, savedAt: SAVED_AT })),
  );
  world = ports;
  return ports;
}

/** Runs ingest, and checks what every returning call must do: one `ingest.done` matching the result, no alerts. */
function run(ports: FakePorts, queue: WorkQueue = [], options?: IngestOptions) {
  const before = ports.log.all('ingest.done').length;
  const out = ingest(ports, queue, options);
  expect(out.result.alerts).toEqual([]);
  const done = ports.log.all('ingest.done');
  expect(done).toHaveLength(before + 1);
  expect(done[done.length - 1]?.fields).toMatchObject({
    ...out.result.counts,
    queueSize: out.queue.length,
  });
  expect(done[done.length - 1]?.fields['stopped']).toBe(out.result.stopped);
  return out;
}

function position(state: FakeState) {
  return decodePosition(state.get(POSITION_KEY));
}

function writes(state: FakeState): string[] {
  return state.calls
    .filter((c) => c.method === 'set' || c.method === 'delete')
    .map((c) => `${c.method} ${String(c.args[0])}`);
}

function ids(queue: WorkQueue): string[] {
  return queue.map((item) => item.threadId);
}

function listHistoryArgs(gmail: FakeGmail): unknown[] {
  return gmail.calls.filter((c) => c.method === 'listHistory').map((c) => c.args[0]);
}

function oldItems(count: number): WorkItem[] {
  return Array.from({ length: count }, (_, i) => ({
    threadId: `old${String(i)}`,
    source: 'scheduled' as const,
    enqueuedAt: 1_000 + i,
    strikes: 0,
  }));
}

describe('ingest: position', () => {
  it('throws StateError missing without a position, and makes no Gmail call', () => {
    const ports = createFakePorts();
    world = ports;
    ports.gmail.deliver();
    let error: unknown;
    try {
      ingest(ports, []);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(StateError);
    expect(error).toMatchObject({ key: 'state.position', reason: 'missing' });
    expect(ports.gmail.calls).toEqual([]);
    expect(writes(ports.state)).toEqual([]);
    expect(ports.log.events).toEqual([]);
  });

  it('throws the codec error for a bad position, and makes no Gmail call', () => {
    const ports = createFakePorts();
    world = ports;
    ports.state.seedRaw(POSITION_KEY, '{"v":9,"historyId":"1","savedAt":0}');
    expect(() => ingest(ports, [])).toThrow(StateError);
    expect(ports.gmail.calls).toEqual([]);
  });

  it('writes nothing when there are no records, keeping the position and its savedAt', () => {
    const ports = setup();
    const start = ports.gmail.historyId;
    ports.clock.advance(60_000);
    const { queue, result } = run(ports);
    expect(queue).toEqual([]);
    expect(result).toEqual({
      alerts: [],
      counts: { pages: 1, records: 0, queued: 0, merged: 0, ignored: 0 },
    });
    expect(writes(ports.state)).toEqual([]);
    expect(position(ports.state)).toEqual({ historyId: start, savedAt: SAVED_AT });
  });
});

describe('ingest: paging and advancing', () => {
  it('pages with maxResults 100, queues every thread, and moves to the last page historyId', () => {
    const ports = setup({ gmail: { maxPageSize: 2 } });
    const start = ports.gmail.historyId;
    const threads = [ports.gmail.deliver(), ports.gmail.deliver(), ports.gmail.deliver()];
    ports.clock.advance(5_000);
    const { queue, result } = run(ports);

    const calls = listHistoryArgs(ports.gmail);
    expect(calls).toHaveLength(3);
    for (const args of calls) {
      expect(args).toMatchObject({
        startHistoryId: start,
        historyTypes: ['messageAdded'],
        maxResults: 100,
      });
    }
    expect(calls[0]).not.toHaveProperty('pageToken');
    expect(calls[1]).toHaveProperty('pageToken');

    expect(ids(queue)).toEqual(threads.map((t) => t.threadId));
    expect(loadQueue(ports.state)).toEqual(queue);
    expect(result).toEqual({
      alerts: [],
      counts: { pages: 3, records: 6, queued: 3, merged: 0, ignored: 0 },
    });
    expect(position(ports.state)).toEqual({
      historyId: ports.gmail.historyId,
      savedAt: ports.clock.now(),
    });
    // The queue is saved before the position.
    expect(writes(ports.state)).toEqual(['set state.queue.0', 'set state.position']);

    expect(ports.log.events).toEqual([
      {
        level: 'info',
        event: 'ingest.done',
        fields: {
          pages: 3,
          records: 6,
          queued: 3,
          merged: 0,
          ignored: 0,
          queueSize: 3,
          startHistoryId: start,
          historyId: ports.gmail.historyId,
        },
      },
    ]);
  });

  it('picks up a change made between pages, and moves to the later, higher historyId', () => {
    const ports = setup({ gmail: { maxPageSize: 2 } });
    const { gmail } = ports;
    const early = [gmail.deliver(), gmail.deliver()];
    const firstPageHistoryId = gmail.historyId;
    let late: { threadId: string } | undefined;
    gmail.onCall = (method) => {
      if (method === 'listHistory' && gmail.calls.length === 1) {
        late = gmail.deliver();
      }
    };
    const { queue } = run(ports);
    expect(late).toBeDefined();
    expect(ids(queue)).toEqual([...early, late].map((t) => t?.threadId));
    expect(Number(position(ports.state).historyId)).toBeGreaterThan(Number(firstPageHistoryId));
    expect(position(ports.state).historyId).toBe(gmail.historyId);
  });

  it('stops at the cap at the last fully handled record, and the next run queues exactly the rest', () => {
    const ports = setup();
    const { gmail, state } = ports;
    const threads = [gmail.deliver(), gmail.deliver(), gmail.deliver(), gmail.deliver()];
    const history = gmail.history;
    const input = oldItems(QUEUE_MAX_ITEMS - 2);

    const first = run(ports, input);
    expect(first.result.stopped).toBe('cap');
    expect(first.result.counts).toMatchObject({ queued: 2, merged: 0 });
    expect(first.queue).toHaveLength(QUEUE_MAX_ITEMS);
    expect(ids(first.queue).slice(-2)).toEqual([threads[0]?.threadId, threads[1]?.threadId]);
    expect(loadQueue(state)).toEqual(first.queue);
    // Records: add 1, bare, add 2, bare, add 3 (full). The last handled is the bare record after add 2.
    expect(position(state).historyId).toBe(history[3]?.id);
    expect(ports.log.find('ingest.done')?.level).toBe('info');

    // Processing finishes two items, making room.
    const drained = dequeue(dequeue(first.queue, 'old0'), 'old1');
    const second = run(ports, drained);
    expect(second.result.stopped).toBeUndefined();
    expect(second.result.counts).toMatchObject({ queued: 2, merged: 0 });
    expect(listHistoryArgs(gmail)[1]).toMatchObject({ startHistoryId: history[3]?.id });
    expect(second.queue).toHaveLength(QUEUE_MAX_ITEMS);
    expect(new Set(ids(second.queue)).size).toBe(QUEUE_MAX_ITEMS);
    for (const thread of threads) {
      expect(ids(second.queue)).toContain(thread.threadId);
    }
    expect(position(state).historyId).toBe(gmail.historyId);
  });

  it("doesn't move when the queue is already full", () => {
    const ports = setup();
    ports.gmail.deliver();
    const start = ports.gmail.historyId;
    const before = position(ports.state);
    const input = oldItems(QUEUE_MAX_ITEMS);
    const { queue, result } = run(ports, input);
    expect(result.stopped).toBe('cap');
    expect(result.counts).toMatchObject({ records: 1, queued: 0, merged: 0 });
    expect(queue).toBe(input);
    expect(writes(ports.state)).toEqual([]);
    expect(position(ports.state)).toEqual(before);
    expect(before.historyId).not.toBe(start);
  });
});

describe('ingest: stopping early', () => {
  it('stops on rate_limited at the second page, keeping the first page', () => {
    const ports = setup({ gmail: { maxPageSize: 2 } });
    const { gmail, state } = ports;
    const a = gmail.deliver();
    gmail.deliver();
    const history = gmail.history;
    gmail.onCall = (method) => {
      if (method === 'listHistory' && gmail.calls.length === 1) {
        gmail.failNext('listHistory', FakeGmail.rateLimited());
      }
    };
    const { queue, result } = run(ports);
    expect(result.stopped).toBe('rate_limited');
    expect(result.counts).toEqual({ pages: 1, records: 2, queued: 1, merged: 0, ignored: 0 });
    expect(ids(queue)).toEqual([a.threadId]);
    expect(loadQueue(state)).toEqual(queue);
    expect(position(state)).toEqual({ historyId: history[1]?.id, savedAt: ports.clock.now() });
    expect(ports.log.find('ingest.done')).toMatchObject({
      level: 'warn',
      fields: { stopped: 'rate_limited' },
    });
  });

  it('stops on scope at the first page, saving nothing', () => {
    const ports = setup();
    ports.gmail.deliver();
    const before = position(ports.state);
    ports.scopes.revoke('https://www.googleapis.com/auth/gmail.modify');
    const { queue, result } = run(ports);
    expect(result).toEqual({
      stopped: 'scope',
      alerts: [],
      counts: { pages: 0, records: 0, queued: 0, merged: 0, ignored: 0 },
    });
    expect(queue).toEqual([]);
    expect(writes(ports.state)).toEqual([]);
    expect(position(ports.state)).toEqual(before);
    expect(ports.log.find('ingest.done')).toMatchObject({
      level: 'warn',
      fields: { stopped: 'scope', startHistoryId: before.historyId, historyId: before.historyId },
    });
  });

  it('stops at the deadline before the second page, keeping the first', () => {
    const ports = setup({ gmail: { maxPageSize: 2 } });
    const { gmail, state } = ports;
    const a = gmail.deliver();
    gmail.deliver();
    const history = gmail.history;
    const { queue, result } = run(ports, [], { shouldContinue: () => gmail.calls.length < 1 });
    expect(result.stopped).toBe('deadline');
    expect(gmail.calls).toHaveLength(1);
    expect(ids(queue)).toEqual([a.threadId]);
    expect(loadQueue(state)).toEqual(queue);
    expect(position(state).historyId).toBe(history[1]?.id);
    expect(ports.log.find('ingest.done')?.level).toBe('info');
  });

  it('stops at the deadline before the first page with no Gmail call and no write', () => {
    const ports = setup();
    ports.gmail.deliver();
    const { queue, result } = run(ports, [], { shouldContinue: () => false });
    expect(result).toEqual({
      stopped: 'deadline',
      alerts: [],
      counts: { pages: 0, records: 0, queued: 0, merged: 0, ignored: 0 },
    });
    expect(queue).toEqual([]);
    expect(ports.gmail.calls).toEqual([]);
    expect(writes(ports.state)).toEqual([]);
  });

  it('returns the input queue on history_expired and writes nothing (until #73)', () => {
    const ports = setup();
    const start = ports.gmail.historyId;
    ports.gmail.deliver();
    ports.gmail.expireHistoryBefore(Number(start) + 1);
    const input = oldItems(1);
    const { queue, result } = run(ports, input);
    expect(queue).toBe(input);
    expect(result).toEqual({
      stopped: 'history_expired',
      alerts: [],
      counts: { pages: 0, records: 0, queued: 0, merged: 0, ignored: 0 },
    });
    expect(writes(ports.state)).toEqual([]);
    expect(ports.log.find('ingest.done')).toMatchObject({
      level: 'warn',
      fields: { stopped: 'history_expired', startHistoryId: start, historyId: start },
    });
  });

  it('lets an unrecognized Gmail error propagate, with nothing saved and no ingest.done', () => {
    const ports = setup();
    ports.gmail.deliver();
    ports.gmail.failNext('listHistory', new Error('Unexpected Gmail error'));
    expect(() => ingest(ports, [])).toThrow('Unexpected Gmail error');
    expect(writes(ports.state)).toEqual([]);
    expect(ports.log.events).toEqual([]);
  });
});

describe('ingest: filtering and queuing', () => {
  it('ignores drafts and mail that arrived in Spam or Trash, and queues sent and filter-archived mail', () => {
    const ports = setup();
    const { gmail } = ports;
    const label = gmail.seedLabel('Newsletters');
    gmail.deliver({ labelIds: ['DRAFT'] });
    gmail.deliver({ labelIds: ['SPAM', 'UNREAD'] });
    gmail.deliver({ labelIds: ['TRASH'] });
    const sent = gmail.deliver({ labelIds: ['SENT'] });
    const archived = gmail.deliver({ labelIds: [label.id, 'UNREAD'] });
    const { queue, result } = run(ports);
    expect(ids(queue)).toEqual([sent.threadId, archived.threadId]);
    expect(result.counts).toEqual({ pages: 1, records: 10, queued: 2, merged: 0, ignored: 3 });
    expect(position(ports.state).historyId).toBe(gmail.historyId);
  });

  it('queues a thread with two new messages once', () => {
    const ports = setup();
    const { threadId } = ports.gmail.deliver();
    ports.gmail.deliver({ threadId });
    const { queue, result } = run(ports);
    expect(ids(queue)).toEqual([threadId]);
    expect(result.counts).toMatchObject({ queued: 1, merged: 1 });
  });

  it('merges into an item already queued, keeping its strikes, enqueuedAt and positionSavedAt', () => {
    const ports = setup();
    const { threadId } = ports.gmail.deliver();
    const existing: WorkItem = {
      threadId,
      source: 'scheduled',
      enqueuedAt: 500,
      strikes: 1,
      positionSavedAt: 400,
    };
    const { queue, result } = run(ports, [existing]);
    expect(queue).toEqual([existing]);
    expect(result.counts).toMatchObject({ queued: 0, merged: 1 });
    expect(loadQueue(ports.state)).toEqual([existing]);
  });

  it('gives new items source scheduled, the position savedAt and no firstClassification', () => {
    const ports = setup();
    const { threadId } = ports.gmail.deliver();
    const { queue } = run(ports);
    expect(queue).toEqual([
      {
        threadId,
        source: 'scheduled',
        enqueuedAt: ports.clock.now(),
        strikes: 0,
        positionSavedAt: SAVED_AT,
      },
    ]);
    expect(queue[0]).not.toHaveProperty('firstClassification');
  });
});

describe('ingest: crash safety', () => {
  it('keeps the saved queue and the old position after a crash between the saves, and the rerun queues nothing twice', () => {
    const ports = setup();
    const { gmail, state } = ports;
    const before = position(state);
    const threads = [gmail.deliver(), gmail.deliver()];
    state.failNext('set', new Error('Crash'), { key: 'state.position' });

    expect(() => ingest(ports, [])).toThrow('Crash');
    expect(ports.log.all('ingest.done')).toEqual([]);
    const saved = loadQueue(state);
    expect(ids(saved)).toEqual(threads.map((t) => t.threadId));
    expect(position(state)).toEqual(before);

    const { queue, result } = run(ports, saved);
    expect(result.counts).toMatchObject({ queued: 0, merged: 2 });
    expect(queue).toEqual(saved);
    expect(position(state).historyId).toBe(gmail.historyId);
  });
});
