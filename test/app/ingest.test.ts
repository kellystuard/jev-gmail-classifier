import { afterEach, describe, expect, it } from 'vitest';

import { ingest, type IngestOptions } from '../../src/app/ingest.ts';
import { rememberJevErrorLabelId } from '../../src/app/jev-error-label-store.ts';
import { loadQueue } from '../../src/app/queue-store.ts';
import { StateError, UnexpectedResponseError } from '../../src/core/errors.ts';
import type { GmailMessage } from '../../src/core/gmail-types.ts';
import {
  FALLBACK_KEY,
  FALLBACK_MAX_PAGES,
  type FallbackCursor,
  fallbackCursorCodec,
  startFallback,
} from '../../src/core/history-fallback.ts';
import { JEV_ERROR_LABEL_KEY } from '../../src/core/jev-error-label.ts';
import { decodePosition, encodePosition, POSITION_KEY } from '../../src/core/position.ts';
import { fail } from '../../src/core/result.ts';
import {
  dequeue,
  QUEUE_MAX_ITEMS,
  type WorkItem,
  type WorkQueue,
} from '../../src/core/work-queue.ts';
import { FakeGmail } from '../fakes/fake-gmail.ts';
import { createFakePorts, type FakePorts, type FakePortsOptions } from '../fakes/fake-ports.ts';
import type { FakeState } from '../fakes/fake-state.ts';

/** The fake clock's start. */
const NOW = Date.UTC(2026, 8, 26, 12);

/** The seeded position's `savedAt`: an hour before the fake clock's start. */
const SAVED_AT = Date.UTC(2026, 8, 26, 11);

/** The Gmail methods `ingest` itself called in this test (not the test's own setup). */
let ingestGmailMethods: string[] = [];

afterEach(() => {
  // Ingest makes no per-thread reads (epic decision 6): only history, plus
  // the profile and the searches of the expired-history fallback.
  expect(
    ingestGmailMethods.filter(
      (m) => m !== 'listHistory' && m !== 'getProfile' && m !== 'searchThreadIds',
    ),
  ).toEqual([]);
  ingestGmailMethods = [];
});

/** Calls `ingest`, recording the Gmail calls it makes for the `afterEach` check. */
function callIngest(ports: FakePorts, queue: WorkQueue = [], options?: IngestOptions) {
  const from = ports.gmail.calls.length;
  try {
    return ingest(ports, queue, options);
  } finally {
    ingestGmailMethods.push(...ports.gmail.calls.slice(from).map((c) => c.method));
  }
}

/**
 * Fake ports with `state.position` seeded at the mailbox's current `historyId`
 * (or `historyId`), saved at `savedAt`.
 */
function setup(
  options: FakePortsOptions = {},
  seed: { readonly savedAt?: number; readonly historyId?: string } = {},
): FakePorts {
  const ports = createFakePorts(options);
  ports.state.seedRaw(
    POSITION_KEY,
    JSON.stringify(
      encodePosition({
        historyId: seed.historyId ?? ports.gmail.historyId,
        savedAt: seed.savedAt ?? SAVED_AT,
      }),
    ),
  );
  return ports;
}

/**
 * Runs ingest, and checks what every returning call must do: one
 * `ingest.done` matching the result, and the expected alerts (none by default).
 */
function run(
  ports: FakePorts,
  queue: WorkQueue = [],
  options?: IngestOptions,
  alerts: readonly string[] = [],
) {
  const before = ports.log.all('ingest.done').length;
  const out = callIngest(ports, queue, options);
  expect(out.result.alerts).toEqual(alerts);
  const done = ports.log.all('ingest.done');
  expect(done).toHaveLength(before + 1);
  const fields = done[done.length - 1]?.fields;
  expect(fields).toMatchObject({
    ...out.result.counts,
    queueSize: out.queue.length,
  });
  expect(fields?.['stopped']).toBe(out.result.stopped);
  const { fallback } = out.result;
  if (fallback === undefined) {
    expect(fields).not.toHaveProperty('fallback');
  } else {
    expect(fields).toMatchObject({
      fallback: true,
      fallbackStarted: fallback.started,
      fallbackDone: fallback.done,
      fallbackWindows: fallback.windows,
      fallbackMissed: fallback.missed,
      fallbackNextAfter: fallback.nextAfter,
      fallbackUntil: fallback.until,
    });
  }
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
    ports.gmail.deliver();
    let error: unknown;
    try {
      callIngest(ports, []);
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
    ports.state.seedRaw(POSITION_KEY, '{"v":9,"historyId":"1","savedAt":0}');
    expect(() => callIngest(ports, [])).toThrow(StateError);
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
      counts: { pages: 1, records: 0, queued: 0, merged: 0, ignored: 0, jevErrorRetries: 0 },
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
        historyTypes: ['messageAdded', 'labelRemoved'],
        maxResults: 100,
      });
    }
    expect(calls[0]).not.toHaveProperty('pageToken');
    expect(calls[1]).toHaveProperty('pageToken');

    expect(ids(queue)).toEqual(threads.map((t) => t.threadId));
    expect(loadQueue(ports.state)).toEqual(queue);
    expect(result).toEqual({
      alerts: [],
      counts: { pages: 3, records: 6, queued: 3, merged: 0, ignored: 0, jevErrorRetries: 0 },
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
          jevErrorRetries: 0,
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
    expect(result.counts).toEqual({
      pages: 1,
      records: 2,
      queued: 1,
      merged: 0,
      ignored: 0,
      jevErrorRetries: 0,
    });
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
      counts: { pages: 0, records: 0, queued: 0, merged: 0, ignored: 0, jevErrorRetries: 0 },
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
      counts: { pages: 0, records: 0, queued: 0, merged: 0, ignored: 0, jevErrorRetries: 0 },
    });
    expect(queue).toEqual([]);
    expect(ports.gmail.calls).toEqual([]);
    expect(writes(ports.state)).toEqual([]);
  });

  it('lets an unrecognized Gmail error propagate, with nothing saved and no ingest.done', () => {
    const ports = setup();
    ports.gmail.deliver();
    ports.gmail.failNext('listHistory', new Error('Unexpected Gmail error'));
    expect(() => callIngest(ports, [])).toThrow('Unexpected Gmail error');
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
    expect(result.counts).toEqual({
      pages: 1,
      records: 10,
      queued: 2,
      merged: 0,
      ignored: 3,
      jevErrorRetries: 0,
    });
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

    expect(() => callIngest(ports, [])).toThrow('Crash');
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

describe('ingest: Jev/Error removals', () => {
  /** Creates `Jev/Error` and remembers its ID, as E6 does before it labels anything. */
  function createJevError(ports: FakePorts): string {
    const created = ports.gmail.createLabel('Jev/Error');
    if (!created.ok) {
      throw new Error('createLabel failed');
    }
    rememberJevErrorLabelId(ports.state, created.label.id);
    return created.label.id;
  }

  /** A thread of `messages` messages, all labelled `labelId`. */
  function flagThread(ports: FakePorts, labelId: string, messages = 1): string {
    const { threadId } = ports.gmail.deliver();
    for (let i = 1; i < messages; i += 1) {
      ports.gmail.deliver({ threadId });
    }
    ports.gmail.modifyThread(threadId, { addLabelIds: [labelId], removeLabelIds: [] });
    return threadId;
  }

  /** Moves the saved position to now, so ingest reads only what happens next. */
  function startFromHere(ports: FakePorts): void {
    ports.state.seedRaw(
      POSITION_KEY,
      JSON.stringify(encodePosition({ historyId: ports.gmail.historyId, savedAt: SAVED_AT })),
    );
  }

  it('asks for messageAdded and labelRemoved', () => {
    const ports = setup();
    run(ports);
    expect(listHistoryArgs(ports.gmail)[0]).toMatchObject({
      historyTypes: ['messageAdded', 'labelRemoved'],
    });
  });

  it('queues a three-message thread once, as a scheduled labels-only retry', () => {
    const ports = setup({ gmail: { maxPageSize: 2 } });
    const labelId = createJevError(ports);
    const threadId = flagThread(ports, labelId, 3);
    startFromHere(ports);
    ports.gmail.removeLabelAsUser(threadId, labelId);
    ports.clock.advance(5_000);

    const { queue, result } = run(ports);
    expect(ports.gmail.history.find((r) => r.labelsRemoved)?.labelsRemoved).toHaveLength(3);
    expect(queue).toEqual([
      {
        threadId,
        source: 'scheduled',
        enqueuedAt: ports.clock.now(),
        strikes: 0,
        firstClassification: false,
      },
    ]);
    expect(queue[0]).not.toHaveProperty('positionSavedAt');
    expect(queue[0]).not.toHaveProperty('applyMoves');
    // The removal's record and the bare record Gmail writes beside it.
    expect(result.counts).toEqual({
      pages: 1,
      records: 2,
      queued: 1,
      merged: 0,
      ignored: 0,
      jevErrorRetries: 1,
    });
    expect(ports.log.find('ingest.done')?.fields).toMatchObject({ jevErrorRetries: 1 });
    expect(loadQueue(ports.state)).toEqual(queue);
    expect(position(ports.state)).toEqual({
      historyId: ports.gmail.historyId,
      savedAt: ports.clock.now(),
    });
  });

  it('retries every thread when the label is deleted, even after a new Jev/Error exists', () => {
    const ports = setup();
    const oldId = createJevError(ports);
    const a = flagThread(ports, oldId);
    const b = flagThread(ports, oldId);
    startFromHere(ports);
    ports.gmail.deleteLabelAsUser(oldId);
    const newId = createJevError(ports);
    expect(newId).not.toBe(oldId);
    expect(ports.state.get(JEV_ERROR_LABEL_KEY)).toEqual({ v: 1, ids: [oldId, newId] });

    const { queue, result } = run(ports);
    expect(ids(queue)).toEqual([a, b]);
    expect(result.counts).toMatchObject({ queued: 2, jevErrorRetries: 2 });
    for (const item of queue) {
      expect(item).toMatchObject({ source: 'scheduled', strikes: 0, firstClassification: false });
    }
    expect(position(ports.state).historyId).toBe(ports.gmail.historyId);
  });

  it('queues nothing for a removal on a thread in Trash, and moves past it', () => {
    const ports = setup();
    const labelId = createJevError(ports);
    const threadId = flagThread(ports, labelId, 2);
    ports.gmail.modifyThread(threadId, { addLabelIds: ['TRASH'], removeLabelIds: [] });
    startFromHere(ports);
    ports.gmail.removeLabelAsUser(threadId, labelId);

    const { queue, result } = run(ports);
    expect(queue).toEqual([]);
    expect(result.counts).toMatchObject({ queued: 0, merged: 0, jevErrorRetries: 0 });
    expect(writes(ports.state)).not.toContain('set state.queue.0');
    expect(position(ports.state).historyId).toBe(ports.gmail.historyId);
  });

  it('queues nothing when trashing a labelled thread writes its INBOX removal', () => {
    const ports = setup();
    const labelId = createJevError(ports);
    const threadId = flagThread(ports, labelId);
    startFromHere(ports);
    ports.gmail.modifyThread(threadId, { addLabelIds: ['TRASH'], removeLabelIds: [] });

    const { queue, result } = run(ports);
    expect(ports.gmail.history.some((r) => r.labelsRemoved !== undefined)).toBe(true);
    expect(queue).toEqual([]);
    expect(result.counts).toMatchObject({ queued: 0, merged: 0, jevErrorRetries: 0 });
  });

  it('queues nothing for the removal of another user label, or of UNREAD', () => {
    const ports = setup();
    createJevError(ports);
    const other = ports.gmail.seedLabel('Newsletters');
    const { threadId } = ports.gmail.deliver();
    ports.gmail.modifyThread(threadId, { addLabelIds: [other.id], removeLabelIds: [] });
    startFromHere(ports);
    ports.gmail.removeLabelAsUser(threadId, other.id);
    ports.gmail.removeLabelAsUser(threadId, 'UNREAD');

    const { queue, result } = run(ports);
    expect(result.counts).toMatchObject({ queued: 0, merged: 0, jevErrorRetries: 0 });
    expect(queue).toEqual([]);
    expect(position(ports.state).historyId).toBe(ports.gmail.historyId);
  });

  it('queues a thread removed, labelled again and removed again once', () => {
    const ports = setup();
    const labelId = createJevError(ports);
    const threadId = flagThread(ports, labelId);
    startFromHere(ports);
    ports.gmail.removeLabelAsUser(threadId, labelId);
    ports.gmail.modifyThread(threadId, { addLabelIds: [labelId], removeLabelIds: [] });
    ports.gmail.removeLabelAsUser(threadId, labelId);

    const { queue, result } = run(ports);
    expect(ids(queue)).toEqual([threadId]);
    expect(result.counts).toMatchObject({
      queued: 1,
      merged: 1,
      jevErrorRetries: 1,
    });
  });

  it('merges into an item already queued: strikes 0, the earlier enqueuedAt and the queue length kept', () => {
    const ports = setup();
    const labelId = createJevError(ports);
    const threadId = flagThread(ports, labelId);
    startFromHere(ports);
    ports.gmail.removeLabelAsUser(threadId, labelId);
    const existing: WorkItem = {
      threadId,
      source: 'scheduled',
      enqueuedAt: 500,
      strikes: 2,
      positionSavedAt: 400,
    };
    const other = oldItems(1);

    const { queue, result } = run(ports, [...other, existing]);
    expect(queue).toHaveLength(2);
    expect(queue.find((item) => item.threadId === threadId)).toEqual({
      threadId,
      source: 'scheduled',
      enqueuedAt: 500,
      strikes: 0,
      positionSavedAt: 400,
      firstClassification: false,
    });
    expect(result.counts).toMatchObject({ queued: 0, merged: 1, jevErrorRetries: 1 });
    expect(loadQueue(ports.state)).toEqual(queue);
  });

  it('keeps a decided firstClassification when merging a retry', () => {
    const ports = setup();
    const labelId = createJevError(ports);
    const threadId = flagThread(ports, labelId);
    startFromHere(ports);
    ports.gmail.removeLabelAsUser(threadId, labelId);
    const existing: WorkItem = {
      threadId,
      source: 'scheduled',
      enqueuedAt: 500,
      strikes: 1,
      firstClassification: true,
    };
    const { queue } = run(ports, [existing]);
    expect(queue).toEqual([{ ...existing, strikes: 0 }]);
  });

  it.each<[string, boolean]>([
    ['a new message, then the removal', true],
    ['the removal, then a new message', false],
  ])('queues one item for %s', (_name, messageFirst) => {
    const ports = setup();
    const labelId = createJevError(ports);
    const threadId = flagThread(ports, labelId);
    startFromHere(ports);
    if (messageFirst) {
      ports.gmail.deliver({ threadId });
      ports.gmail.removeLabelAsUser(threadId, labelId);
    } else {
      ports.gmail.removeLabelAsUser(threadId, labelId);
      ports.gmail.deliver({ threadId });
    }

    const { queue, result } = run(ports);
    expect(queue).toEqual([
      {
        threadId,
        source: 'scheduled',
        enqueuedAt: ports.clock.now(),
        strikes: 0,
        positionSavedAt: SAVED_AT,
        firstClassification: false,
      },
    ]);
    expect(result.counts).toMatchObject({ queued: 1, merged: 1, jevErrorRetries: 1 });
  });

  it('queues nothing without state.jevErrorLabel, and still moves the position', () => {
    const ports = setup();
    const label = ports.gmail.seedLabel('Jev/Error');
    const { threadId } = ports.gmail.deliver();
    ports.gmail.modifyThread(threadId, { addLabelIds: [label.id], removeLabelIds: [] });
    startFromHere(ports);
    ports.gmail.removeLabelAsUser(threadId, label.id);

    expect(ports.state.get(JEV_ERROR_LABEL_KEY)).toBeUndefined();
    const { queue, result } = run(ports);
    expect(queue).toEqual([]);
    expect(result.counts).toMatchObject({ queued: 0, jevErrorRetries: 0 });
    expect(position(ports.state).historyId).toBe(ports.gmail.historyId);
  });

  it('throws StateError for a bad state.jevErrorLabel, before any Gmail call, and leaves it alone', () => {
    const ports = setup();
    ports.state.seedRaw(JEV_ERROR_LABEL_KEY, '{"v":1,"ids":[1]}');
    expect(() => callIngest(ports, [])).toThrow(StateError);
    expect(ports.gmail.calls).toEqual([]);
    expect(writes(ports.state)).toEqual([]);
    expect(ports.log.events).toEqual([]);
  });

  describe('at the queue cap', () => {
    it('stops at a removal of a thread not queued, with the position at the record before it', () => {
      const ports = setup();
      const labelId = createJevError(ports);
      const threadId = flagThread(ports, labelId);
      startFromHere(ports);
      // A draft is ignored (handled), then the removal (not handled at the cap).
      ports.gmail.deliver({ labelIds: ['DRAFT'] });
      ports.gmail.removeLabelAsUser(threadId, labelId);
      const before = position(ports.state);
      const input = oldItems(QUEUE_MAX_ITEMS);

      const { queue, result } = run(ports, input);
      expect(result.stopped).toBe('cap');
      expect(result.counts).toMatchObject({ queued: 0, jevErrorRetries: 0 });
      expect(queue).toBe(input);
      // The position is the record just before the removal record.
      const history = ports.gmail.history;
      const removalIndex = history.findIndex((r) => r.labelsRemoved !== undefined);
      expect(removalIndex).toBeGreaterThan(0);
      expect(position(ports.state).historyId).toBe(history[removalIndex - 1]?.id);
      expect(position(ports.state).historyId).not.toBe(before.historyId);
    });

    it('merges a removal of a thread already queued, and moves past it', () => {
      const ports = setup();
      const labelId = createJevError(ports);
      const threadId = flagThread(ports, labelId);
      startFromHere(ports);
      ports.gmail.removeLabelAsUser(threadId, labelId);
      const queued: WorkItem = { threadId, source: 'scheduled', enqueuedAt: 10, strikes: 1 };
      const input = [...oldItems(QUEUE_MAX_ITEMS - 1), queued];
      expect(input).toHaveLength(QUEUE_MAX_ITEMS);

      const { queue, result } = run(ports, input);
      expect(result.stopped).toBeUndefined();
      expect(result.counts).toMatchObject({ queued: 0, merged: 1, jevErrorRetries: 1 });
      expect(queue).toHaveLength(QUEUE_MAX_ITEMS);
      expect(queue.find((item) => item.threadId === threadId)).toMatchObject({
        strikes: 0,
        firstClassification: false,
        enqueuedAt: 10,
      });
      expect(position(ports.state).historyId).toBe(ports.gmail.historyId);
    });
  });
});

describe('ingest: expired-history fallback', () => {
  const DAY_S = 86_400;
  const DAY_MS = DAY_S * 1000;

  /**
   * The fake's search engine for the fallback's queries: reads
   * `after:<s> before:<s>` from `q` and compares the message's
   * `internalDate` in epoch seconds, inclusive at both ends (spike 23, C1).
   */
  function windowMatcher(q: string, message: GmailMessage): boolean {
    const match = /after:(\d+) before:(\d+)/.exec(q);
    if (match === null) {
      throw new Error(`windowMatcher: unexpected query "${q}"`);
    }
    const seconds = Math.floor(Number(message.internalDate) / 1000);
    return seconds >= Number(match[1]) && seconds <= Number(match[2]);
  }

  /** Fake ports whose position was saved at `savedAt`, with the window matcher. */
  function expiredSetup(savedAt: number, options: FakePortsOptions = {}): FakePorts {
    const ports = setup(options, { savedAt });
    ports.gmail.setSearchMatcher(windowMatcher);
    return ports;
  }

  /** From now on, the seeded position (and every earlier one) gets the 404. */
  function expire(ports: FakePorts): void {
    ports.gmail.expireHistoryBefore(Number(ports.gmail.historyId) + 1);
  }

  /** The first window's `after:`: an hour before `savedAt`, in epoch seconds. */
  function firstAfter(savedAt: number): number {
    return Math.floor(savedAt / 1000) - 3600;
  }

  /** Delivers a new thread whose one message is dated `seconds` (epoch s). */
  function deliverAt(ports: FakePorts, seconds: number, labelIds?: readonly string[]) {
    return ports.gmail.deliver({
      internalDate: seconds * 1000,
      ...(labelIds === undefined ? {} : { labelIds }),
    });
  }

  function cursorIn(state: FakeState): FallbackCursor | undefined {
    const raw = state.get(FALLBACK_KEY);
    return raw === undefined ? undefined : fallbackCursorCodec.decode(FALLBACK_KEY, raw);
  }

  function q(after: number, before: number): string {
    return `after:${String(after)} before:${String(before)}`;
  }

  function methods(ports: FakePorts, from = 0): string[] {
    return ports.gmail.calls.slice(from).map((c) => c.method);
  }

  function searchArgs(ports: FakePorts): unknown[] {
    return ports.gmail.calls.filter((c) => c.method === 'searchThreadIds').map((c) => c.args[0]);
  }

  it('starts on history_expired: getProfile before any search, the cursor, history.expired and the alert', () => {
    const ports = expiredSetup(SAVED_AT);
    const { gmail, state } = ports;
    const oldHistoryId = gmail.historyId;
    deliverAt(ports, Math.floor(SAVED_AT / 1000) + 60);
    expire(ports);
    const resume = gmail.historyId;

    // Checks: before listHistory, before getProfile, then false before the first window.
    let checks = 0;
    const { queue, result } = run(ports, [], { shouldContinue: () => ++checks <= 2 }, [
      'history_expired',
    ]);
    expect(methods(ports)).toEqual(['listHistory', 'getProfile']);
    expect(queue).toEqual([]);
    expect(result).toEqual({
      stopped: 'deadline',
      alerts: ['history_expired'],
      counts: { pages: 0, records: 0, queued: 0, merged: 0, ignored: 0, jevErrorRetries: 0 },
      fallback: {
        started: true,
        done: false,
        windows: 0,
        queued: 0,
        merged: 0,
        missed: 0,
        nextAfter: firstAfter(SAVED_AT),
        until: NOW / 1000,
      },
    });
    expect(cursorIn(state)).toEqual({
      historyId: resume,
      oldSavedAt: SAVED_AT,
      nextAfter: firstAfter(SAVED_AT),
      until: Math.floor(NOW / 1000),
      windowSeconds: DAY_S,
      startedAt: NOW,
      queued: 0,
      merged: 0,
    });
    // The old position stays until the fallback finishes.
    expect(position(state)).toEqual({ historyId: oldHistoryId, savedAt: SAVED_AT });
    expect(writes(state)).toEqual(['set state.fallback']);
    expect(ports.log.all('history.expired')).toEqual([
      {
        level: 'warn',
        event: 'history.expired',
        fields: {
          historyId: oldHistoryId,
          savedAt: SAVED_AT,
          resumeHistoryId: resume,
          aheadOfMailbox: false,
          until: NOW / 1000,
        },
      },
    ]);
  });

  it('calls getProfile before the first search when it runs on', () => {
    const ports = expiredSetup(SAVED_AT);
    deliverAt(ports, Math.floor(SAVED_AT / 1000) + 60);
    expire(ports);
    run(ports, [], undefined, ['history_expired']);
    expect(methods(ports)).toEqual(['listHistory', 'getProfile', 'searchThreadIds']);
  });

  it('takes the same path for a position ahead of the mailbox, with aheadOfMailbox true', () => {
    const ports = createFakePorts();
    const { gmail, state } = ports;
    gmail.setSearchMatcher(windowMatcher);
    const current = gmail.historyId;
    const ahead = String(Number(current) + 1_000_000);
    state.seedRaw(
      POSITION_KEY,
      JSON.stringify(encodePosition({ historyId: ahead, savedAt: SAVED_AT })),
    );
    const thread = deliverAt(ports, Math.floor(SAVED_AT / 1000) + 60);
    const resume = gmail.historyId;

    const { queue, result } = run(ports, [], undefined, ['history_expired']);
    expect(methods(ports)).toEqual(['listHistory', 'getProfile', 'searchThreadIds']);
    expect(ports.log.find('history.expired')?.fields).toEqual({
      historyId: ahead,
      savedAt: SAVED_AT,
      resumeHistoryId: resume,
      aheadOfMailbox: true,
      until: NOW / 1000,
    });
    expect(ids(queue)).toEqual([thread.threadId]);
    expect(result.fallback).toMatchObject({ started: true, done: true, windows: 1 });
    expect(position(state)).toEqual({ historyId: resume, savedAt: NOW });
    expect(cursorIn(state)).toBeUndefined();
  });

  it('finds mail spread over three days through several windows, then sets the position and deletes the cursor', () => {
    const savedAt = NOW - 3 * DAY_MS;
    const t0 = firstAfter(savedAt);
    const until = NOW / 1000;
    const ports = expiredSetup(savedAt);
    const { gmail, state } = ports;
    const oldHistoryId = gmail.historyId;

    deliverAt(ports, t0 - 1); // before the lookback: not searched
    const inLookback = deliverAt(ports, t0);
    const endOfFirst = deliverAt(ports, t0 + DAY_S - 1);
    const startOfSecond = deliverAt(ports, t0 + DAY_S);
    const third = deliverAt(ports, t0 + 2 * DAY_S + 500);
    deliverAt(ports, t0 + 2 * DAY_S + 600, ['SPAM', 'UNREAD']); // Spam: not searched
    const lastMinute = deliverAt(ports, until - 60);
    const atThe404 = deliverAt(ports, until);
    expire(ports);
    const resume = gmail.historyId;
    const found = [inLookback, endOfFirst, startOfSecond, third, lastMinute, atThe404];

    const { queue, result } = run(ports, [], undefined, ['history_expired']);

    const windows = [
      [t0, t0 + DAY_S - 1],
      [t0 + DAY_S, t0 + 2 * DAY_S - 1],
      [t0 + 2 * DAY_S, t0 + 3 * DAY_S - 1],
      [t0 + 3 * DAY_S, until],
    ] as const;
    expect(searchArgs(ports)).toEqual(
      windows.map(([after, before]) => ({
        q: q(after, before),
        includeSpamTrash: false,
        maxResults: 500,
      })),
    );
    // Each window starts one second past the previous one's end.
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i]?.[0]).toBe((windows[i - 1]?.[1] ?? 0) + 1);
    }

    expect(queue).toEqual(
      found.map((t) => ({
        threadId: t.threadId,
        source: 'scheduled',
        enqueuedAt: NOW,
        strikes: 0,
        positionSavedAt: savedAt,
      })),
    );
    for (const item of queue) {
      expect(item).not.toHaveProperty('firstClassification');
    }
    expect(loadQueue(state)).toEqual(queue);
    expect(result).toEqual({
      alerts: ['history_expired'],
      counts: { pages: 0, records: 0, queued: 6, merged: 0, ignored: 0, jevErrorRetries: 0 },
      fallback: {
        started: true,
        done: true,
        windows: 4,
        queued: 6,
        merged: 0,
        missed: 0,
        nextAfter: until + 1,
        until,
      },
    });
    expect(position(state)).toEqual({ historyId: resume, savedAt: NOW });
    expect(cursorIn(state)).toBeUndefined();
    // The queue before the cursor after every window; the position before the delete.
    expect(writes(state)).toEqual([
      'set state.fallback',
      ...windows.flatMap(() => ['set state.queue.0', 'set state.fallback']),
      'set state.position',
      'delete state.fallback',
    ]);
    expect(ports.log.find('ingest.done')).toMatchObject({
      level: 'info',
      fields: {
        startHistoryId: oldHistoryId,
        historyId: resume,
        fallback: true,
        fallbackStarted: true,
        fallbackDone: true,
        fallbackWindows: 4,
        fallbackMissed: 0,
        fallbackNextAfter: until + 1,
        fallbackUntil: until,
      },
    });
  });

  it('saves the queue from earlier history pages before the cursor when a later page is a 404', () => {
    const ports = expiredSetup(SAVED_AT, { gmail: { maxPageSize: 2 } });
    const { gmail, state } = ports;
    const threads = [
      deliverAt(ports, Math.floor(SAVED_AT / 1000) + 1),
      deliverAt(ports, Math.floor(SAVED_AT / 1000) + 2),
    ];
    gmail.onCall = (method) => {
      if (method === 'listHistory' && gmail.calls.length === 1) {
        expire(ports);
      }
    };
    const { queue, result } = run(ports, [], undefined, ['history_expired']);
    expect(result.counts).toMatchObject({ pages: 1, records: 2, queued: 2, merged: 1 });
    expect(writes(state).slice(0, 2)).toEqual(['set state.queue.0', 'set state.fallback']);
    expect(ids(queue)).toEqual(threads.map((t) => t.threadId));
    expect(result.fallback).toMatchObject({ queued: 1, merged: 1, done: true });
    expect(queue.every((item) => item.positionSavedAt === SAVED_AT)).toBe(true);
  });

  it('reports the alert only from the call that starts the fallback', () => {
    const savedAt = NOW - 2 * DAY_MS;
    const t0 = firstAfter(savedAt);
    const ports = expiredSetup(savedAt);
    const { gmail } = ports;
    const threads = [deliverAt(ports, t0 + 10), deliverAt(ports, t0 + DAY_S + 10)];
    expire(ports);

    const first = run(ports, [], { shouldContinue: () => gmail.searches.length < 1 }, [
      'history_expired',
    ]);
    expect(first.result.stopped).toBe('deadline');
    expect(first.result.fallback).toMatchObject({ started: true, done: false, windows: 1 });

    const from = gmail.calls.length;
    const second = run(ports, first.queue);
    expect(second.result.alerts).toEqual([]);
    expect(second.result.fallback).toMatchObject({ started: false, done: true, windows: 2 });
    expect(ports.log.all('history.expired')).toHaveLength(1);
    expect(methods(ports, from)).toEqual(['searchThreadIds', 'searchThreadIds']);
    expect(ids(second.queue)).toEqual(threads.map((t) => t.threadId));
  });

  it('runs the fallback instead of listHistory while state.fallback exists, without reading the position', () => {
    const ports = createFakePorts();
    const { gmail, state } = ports;
    gmail.setSearchMatcher(windowMatcher);
    const thread = deliverAt(ports, Math.floor(SAVED_AT / 1000));
    const cursor = startFallback({ historyId: gmail.historyId, oldSavedAt: SAVED_AT, now: NOW });
    state.seedRaw(FALLBACK_KEY, JSON.stringify(fallbackCursorCodec.encode(cursor)));

    const { queue, result } = run(ports);
    expect(methods(ports)).toEqual(['searchThreadIds']);
    expect(state.calls.filter((c) => c.method === 'get' && c.args[0] === POSITION_KEY)).toEqual([]);
    expect(ids(queue)).toEqual([thread.threadId]);
    expect(result.fallback).toMatchObject({ started: false, done: true });
    expect(position(state)).toEqual({ historyId: cursor.historyId, savedAt: NOW });
    expect(ports.log.find('ingest.done')?.fields).not.toHaveProperty('startHistoryId');
    expect(ports.log.find('ingest.done')?.fields).toMatchObject({ historyId: cursor.historyId });
  });

  it('halves a window that does not fit until it does, then doubles the next one', () => {
    const savedAt = NOW - 2 * DAY_MS;
    const t0 = firstAfter(savedAt);
    const ports = expiredSetup(savedAt);
    const early = [deliverAt(ports, t0 + 100), deliverAt(ports, t0 + 200)];
    deliverAt(ports, t0 + 30_000);
    deliverAt(ports, t0 + 30_001);
    deliverAt(ports, t0 + 60_000);
    expire(ports);
    const input = oldItems(QUEUE_MAX_ITEMS - 3);

    const { queue } = run(ports, input, undefined, ['history_expired']);
    // 5 new threads (room 3), then 4, then 2: that fits.
    expect(ports.gmail.searches.slice(0, 4)).toEqual([
      q(t0, t0 + DAY_S - 1),
      q(t0, t0 + DAY_S / 2 - 1),
      q(t0, t0 + DAY_S / 4 - 1),
      q(t0 + DAY_S / 4, t0 + DAY_S / 4 + DAY_S / 2 - 1),
    ]);
    for (const thread of early) {
      expect(ids(queue)).toContain(thread.threadId);
    }
  });

  it('waits at the 60 s window when scheduled items leave too little room, then continues from the same window', () => {
    const t0 = firstAfter(SAVED_AT);
    const ports = expiredSetup(SAVED_AT);
    const { gmail, state } = ports;
    const threads = [deliverAt(ports, t0 + 5), deliverAt(ports, t0 + 5)];
    expire(ports);
    const input = oldItems(QUEUE_MAX_ITEMS - 1);

    const first = run(ports, input, undefined, ['history_expired']);
    expect(first.result.stopped).toBe('cap');
    expect(first.result.counts).toMatchObject({ queued: 0, merged: 0 });
    expect(first.queue).toBe(input);
    expect(gmail.searches[gmail.searches.length - 1]).toBe(q(t0, t0 + 59));
    expect(cursorIn(state)).toMatchObject({ nextAfter: t0, windowSeconds: 60 });
    // The start cursor, then the shrunk one: nothing from the window.
    expect(writes(state)).toEqual(['set state.fallback', 'set state.fallback']);

    // Processing finishes two items: room for the window, and one to spare.
    const drained = dequeue(dequeue(first.queue, 'old0'), 'old1');
    const from = gmail.searches.length;
    const second = run(ports, drained);
    expect(gmail.searches[from]).toBe(q(t0, t0 + 59));
    expect(second.result.stopped).toBeUndefined();
    expect(second.result.fallback).toMatchObject({ done: true, queued: 2 });
    for (const thread of threads) {
      expect(ids(second.queue)).toContain(thread.threadId);
    }
  });

  it('stops at cap with no search when the queue is full', () => {
    const ports = expiredSetup(SAVED_AT);
    deliverAt(ports, Math.floor(SAVED_AT / 1000));
    expire(ports);
    const input = oldItems(QUEUE_MAX_ITEMS);
    const { queue, result } = run(ports, input, undefined, ['history_expired']);
    expect(result.stopped).toBe('cap');
    expect(queue).toBe(input);
    expect(methods(ports)).toEqual(['listHistory', 'getProfile']);
    expect(writes(ports.state)).toEqual(['set state.fallback']);
    expect(cursorIn(ports.state)?.nextAfter).toBe(firstAfter(SAVED_AT));
  });

  it('takes what fits from a 60 s window bigger than an empty queue, logs history.fallback_missed, and moves on', () => {
    const t0 = firstAfter(SAVED_AT);
    const ports = expiredSetup(SAVED_AT);
    const { state } = ports;
    for (let i = 0; i < QUEUE_MAX_ITEMS + 5; i++) {
      deliverAt(ports, t0 + 10);
    }
    expire(ports);

    const { queue, result } = run(ports, [], undefined, ['history_expired']);
    expect(queue).toHaveLength(QUEUE_MAX_ITEMS);
    expect(loadQueue(state)).toEqual(queue);
    expect(ports.log.all('history.fallback_missed')).toEqual([
      {
        level: 'warn',
        event: 'history.fallback_missed',
        fields: { after: t0, before: t0 + 59, missed: 5 },
      },
    ]);
    // The queue is full now, so the next window waits.
    expect(result.stopped).toBe('cap');
    expect(result.fallback).toMatchObject({ windows: 1, queued: QUEUE_MAX_ITEMS, missed: 5 });
    expect(cursorIn(state)).toMatchObject({ nextAfter: t0 + 60, windowSeconds: 120 });
    expect(ports.log.find('ingest.done')?.level).toBe('warn');
  });

  it('keeps the completed windows on rate_limited at the second page of a window, and the next call finishes', () => {
    const savedAt = NOW - 2 * DAY_MS;
    const t0 = firstAfter(savedAt);
    const ports = expiredSetup(savedAt, { gmail: { maxSearchPageSize: 1 } });
    const { gmail, state } = ports;
    const a = deliverAt(ports, t0 + 10);
    const b = deliverAt(ports, t0 + DAY_S + 10);
    const c = deliverAt(ports, t0 + DAY_S + 20);
    const d = deliverAt(ports, NOW / 1000 - 10);
    expire(ports);
    const resume = gmail.historyId;
    // Search calls: window 1 (one page), window 2 page 1, window 2 page 2 (fails).
    gmail.failNext('searchThreadIds', FakeGmail.rateLimited(), { after: 2 });

    const first = run(ports, [], undefined, ['history_expired']);
    expect(first.result.stopped).toBe('rate_limited');
    expect(ids(first.queue)).toEqual([a.threadId]);
    expect(loadQueue(state)).toEqual(first.queue);
    expect(cursorIn(state)).toMatchObject({ nextAfter: t0 + DAY_S, queued: 1 });
    expect(ports.log.find('ingest.done')?.level).toBe('warn');

    const second = run(ports, loadQueue(state));
    expect(second.result.stopped).toBeUndefined();
    expect(ids(second.queue)).toEqual([a, b, c, d].map((t) => t.threadId));
    expect(position(state)).toEqual({ historyId: resume, savedAt: NOW });
    expect(cursorIn(state)).toBeUndefined();
  });

  it('throws on a page token rejected at the second page of a window, leaving the completed windows and the next call finishing', () => {
    const savedAt = NOW - 2 * DAY_MS;
    const t0 = firstAfter(savedAt);
    const ports = expiredSetup(savedAt, { gmail: { maxSearchPageSize: 1 } });
    const { gmail, state } = ports;
    const a = deliverAt(ports, t0 + 10);
    const b = deliverAt(ports, t0 + DAY_S + 10);
    const c = deliverAt(ports, t0 + DAY_S + 20);
    expire(ports);
    // Search calls: window 1 (one page), window 2 page 1, window 2 page 2 (rejected).
    gmail.failNext('searchThreadIds', FakeGmail.invalidPageToken(), { after: 2 });

    expect(() => run(ports, [], undefined, ['history_expired'])).toThrow(UnexpectedResponseError);

    // Window 1 is queued and saved; window 2 queued nothing and the cursor stays before it.
    expect(ids(loadQueue(state))).toEqual([a.threadId]);
    expect(cursorIn(state)).toMatchObject({ nextAfter: t0 + DAY_S, queued: 1 });

    const second = run(ports, loadQueue(state));
    expect(second.result.stopped).toBeUndefined();
    expect(ids(second.queue)).toEqual([a, b, c].map((t) => t.threadId));
  });

  it('drops an unfinished window at the deadline between its pages', () => {
    const savedAt = NOW - 2 * DAY_MS;
    const t0 = firstAfter(savedAt);
    const ports = expiredSetup(savedAt, { gmail: { maxSearchPageSize: 1 } });
    const { gmail, state } = ports;
    const a = deliverAt(ports, t0 + 10);
    deliverAt(ports, t0 + DAY_S + 10);
    deliverAt(ports, t0 + DAY_S + 20);
    expire(ports);

    // False only before window 2's second page.
    const { queue, result } = run(
      ports,
      [],
      { shouldContinue: () => gmail.searches.length !== 2 },
      ['history_expired'],
    );
    expect(result.stopped).toBe('deadline');
    expect(gmail.searches).toHaveLength(2);
    expect(ids(queue)).toEqual([a.threadId]);
    expect(loadQueue(state)).toEqual(queue);
    expect(cursorIn(state)).toMatchObject({ nextAfter: t0 + DAY_S, windowSeconds: DAY_S });
  });

  it('stops paging once the new matches exceed the room, and halves the window', () => {
    const savedAt = NOW - 2 * DAY_MS;
    const t0 = firstAfter(savedAt);
    const ports = expiredSetup(savedAt, { gmail: { maxSearchPageSize: 1 } });
    for (let i = 0; i < 3; i++) {
      deliverAt(ports, t0 + 10 + i);
    }
    expire(ports);
    // Room 1: the second page's second new thread is already too many.
    run(ports, oldItems(QUEUE_MAX_ITEMS - 1), undefined, ['history_expired']);
    expect(ports.gmail.searches.slice(0, 3)).toEqual([
      q(t0, t0 + DAY_S - 1),
      q(t0, t0 + DAY_S - 1),
      q(t0, t0 + DAY_S / 2 - 1),
    ]);
    expect(searchArgs(ports)[1]).toHaveProperty('pageToken');
  });

  it('treats a window as not fitting after FALLBACK_MAX_PAGES pages, and halves it', () => {
    const savedAt = NOW - 2 * DAY_MS;
    const t0 = firstAfter(savedAt);
    const ports = expiredSetup(savedAt, { gmail: { maxSearchPageSize: 1 } });
    const threads = Array.from({ length: FALLBACK_MAX_PAGES + 1 }, (_, i) =>
      deliverAt(ports, t0 + i * 100),
    );
    expire(ports);
    const { queue, result } = run(ports, [], undefined, ['history_expired']);
    const searches = ports.gmail.searches;
    expect(searches.slice(0, FALLBACK_MAX_PAGES + 1)).toEqual([
      ...Array.from({ length: FALLBACK_MAX_PAGES }, () => q(t0, t0 + DAY_S - 1)),
      q(t0, t0 + DAY_S / 2 - 1),
    ]);
    expect(result.fallback).toMatchObject({ done: true, missed: 0 });
    expect(new Set(ids(queue))).toEqual(new Set(threads.map((t) => t.threadId)));
  });

  it('writes nothing on scope from getProfile, and the next call starts the fallback', () => {
    const ports = expiredSetup(SAVED_AT);
    const { gmail, state } = ports;
    const before = position(state);
    deliverAt(ports, Math.floor(SAVED_AT / 1000));
    expire(ports);
    gmail.failNext('getProfile', fail('scope', { message: 'Insufficient Permission' }));

    const first = run(ports);
    expect(first.result).toEqual({
      stopped: 'scope',
      alerts: [],
      counts: { pages: 0, records: 0, queued: 0, merged: 0, ignored: 0, jevErrorRetries: 0 },
    });
    expect(methods(ports)).toEqual(['listHistory', 'getProfile']);
    expect(writes(state)).toEqual([]);
    expect(ports.log.all('history.expired')).toEqual([]);
    expect(position(state)).toEqual(before);

    const second = run(ports, [], undefined, ['history_expired']);
    expect(second.result.fallback).toMatchObject({ started: true, done: true });
    expect(second.queue).toHaveLength(1);
  });

  it('starts nothing at the deadline right after the 404, and the next call starts the fallback', () => {
    const ports = expiredSetup(SAVED_AT);
    deliverAt(ports, Math.floor(SAVED_AT / 1000));
    expire(ports);
    let checks = 0;
    const first = run(ports, [], { shouldContinue: () => ++checks <= 1 });
    expect(first.result.stopped).toBe('deadline');
    expect(first.result).not.toHaveProperty('fallback');
    expect(methods(ports)).toEqual(['listHistory']);
    expect(writes(ports.state)).toEqual([]);

    const second = run(ports, [], undefined, ['history_expired']);
    expect(second.result.fallback).toMatchObject({ started: true, done: true });
  });

  it('keeps the completed windows at the deadline between windows', () => {
    const savedAt = NOW - 3 * DAY_MS;
    const t0 = firstAfter(savedAt);
    const ports = expiredSetup(savedAt);
    const { gmail, state } = ports;
    const kept = [deliverAt(ports, t0 + 10), deliverAt(ports, t0 + DAY_S + 10)];
    deliverAt(ports, t0 + 2 * DAY_S + 10);
    expire(ports);

    const { queue, result } = run(ports, [], { shouldContinue: () => gmail.searches.length < 2 }, [
      'history_expired',
    ]);
    expect(result.stopped).toBe('deadline');
    expect(result.fallback).toMatchObject({ windows: 2, done: false });
    expect(ids(queue)).toEqual(kept.map((t) => t.threadId));
    expect(loadQueue(state)).toEqual(queue);
    expect(cursorIn(state)).toMatchObject({ nextAfter: t0 + 2 * DAY_S, queued: 2 });
    expect(ports.log.find('ingest.done')?.level).toBe('info');
  });

  it('searches a window again after a crash between the queue save and the cursor save, with no duplicate', () => {
    const savedAt = NOW - 2 * DAY_MS;
    const t0 = firstAfter(savedAt);
    const ports = expiredSetup(savedAt);
    const { gmail, state } = ports;
    const threads = [deliverAt(ports, t0 + 10), deliverAt(ports, t0 + DAY_S + 10)];
    expire(ports);
    // The first cursor write (the start) succeeds; the one after window 1 crashes.
    state.failNext('set', new Error('Crash'), { key: FALLBACK_KEY, after: 1 });

    expect(() => callIngest(ports, [])).toThrow('Crash');
    expect(ports.log.all('ingest.done')).toEqual([]);
    const saved = loadQueue(state);
    expect(ids(saved)).toEqual([threads[0]?.threadId]);
    expect(cursorIn(state)?.nextAfter).toBe(t0);

    const from = gmail.searches.length;
    const { queue, result } = run(ports, saved);
    expect(gmail.searches[from]).toBe(q(t0, t0 + DAY_S - 1));
    expect(result.counts).toMatchObject({ queued: 1, merged: 1 });
    expect(ids(queue)).toEqual(threads.map((t) => t.threadId));
    expect(result.fallback).toMatchObject({ done: true });
  });

  it('repeats the finish after a crash between the position write and the key delete, with no search', () => {
    const ports = expiredSetup(SAVED_AT);
    const { gmail, state, clock } = ports;
    deliverAt(ports, Math.floor(SAVED_AT / 1000));
    expire(ports);
    const resume = gmail.historyId;
    state.failNext('delete', new Error('Crash'), { key: FALLBACK_KEY });

    expect(() => callIngest(ports, [])).toThrow('Crash');
    expect(position(state)).toEqual({ historyId: resume, savedAt: NOW });
    const left = cursorIn(state);
    expect(left).toBeDefined();

    clock.advance(10 * 60_000);
    const from = gmail.calls.length;
    const { result } = run(ports, loadQueue(state));
    expect(methods(ports, from)).toEqual([]);
    expect(result.fallback).toEqual({
      started: false,
      done: true,
      windows: 0,
      queued: 0,
      merged: 0,
      missed: 0,
      nextAfter: left?.nextAfter,
      until: left?.until,
    });
    expect(position(state)).toEqual({ historyId: resume, savedAt: NOW });
    expect(cursorIn(state)).toBeUndefined();
  });

  it('finds a thread with messages in two windows twice, and merges it into one item', () => {
    const savedAt = NOW - 2 * DAY_MS;
    const t0 = firstAfter(savedAt);
    const ports = expiredSetup(savedAt);
    const { threadId } = deliverAt(ports, t0 + 10);
    ports.gmail.deliver({ threadId, internalDate: (t0 + DAY_S + 10) * 1000 });
    expire(ports);

    const { queue, result } = run(ports, [], undefined, ['history_expired']);
    expect(ids(queue)).toEqual([threadId]);
    expect(result.counts).toMatchObject({ queued: 1, merged: 1 });
    expect(result.fallback).toMatchObject({ queued: 1, merged: 1, windows: 3, done: true });
  });
});
