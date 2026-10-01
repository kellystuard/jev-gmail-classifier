import { describe, expect, it } from 'vitest';

import { loadManualJob, saveManualJob } from '../../src/app/manual-job-store.ts';
import {
  REFILL_MAX_EMPTY_PAGES,
  type RefillDeps,
  refillManualQueue,
} from '../../src/app/manual-refill.ts';
import { loadQueue } from '../../src/app/queue-store.ts';
import { StateError, UnexpectedResponseError } from '../../src/core/errors.ts';
import {
  type ManualJob,
  MANUAL_KEY,
  advanceCursor,
  decodeManualJob,
  dropPageToken,
  newManualJob,
} from '../../src/core/manual-job.ts';
import { fail, ok } from '../../src/core/result.ts';
import { type WorkQueue, enqueue } from '../../src/core/work-queue.ts';
import type { GmailPort, SearchThreadIdsRequest } from '../../src/ports/gmail-port.ts';
import { FakeGmail } from '../fakes/fake-gmail.ts';
import { type FakePorts, createFakePorts } from '../fakes/fake-ports.ts';

const QUERY = 'label:receipts-secret after:1700000000';
/** `createFakePorts()`'s default clock. */
const NOW = Date.parse('2026-09-26T12:00:00Z');

type World = {
  readonly ports: FakePorts;
  readonly deps: RefillDeps;
  /** The thread IDs in search order. */
  readonly ids: readonly string[];
  /** The threads the job search matches. A test may change it. */
  readonly matching: Set<string>;
};

/** `threads` matching threads, searched `perPage` at a time. */
function world(threads: number, perPage = 3): World {
  const ports = createFakePorts({ gmail: { maxSearchPageSize: perPage } });
  const ids: string[] = [];
  for (let i = 0; i < threads; i++) {
    ids.push(ports.gmail.deliver().threadId);
  }
  const matching = new Set(ids);
  // The matcher doesn't depend on labels, so pages never shift by themselves.
  ports.gmail.setSearchMatcher((q, message) => q === QUERY && matching.has(message.threadId));
  const { gmail, state, clock, log } = ports;
  return { ports, deps: { gmail, state, clock, log }, ids, matching };
}

function newJob(applyMoves = false): ManualJob {
  return newManualJob({ query: QUERY, applyMoves, startedAt: NOW });
}

const always = (): boolean => true;

/** True for the first `n` calls, then false. */
function times(n: number): () => boolean {
  let calls = 0;
  return () => {
    calls += 1;
    return calls <= n;
  };
}

function searchRequests(ports: FakePorts): readonly unknown[] {
  return ports.gmail.calls.filter((c) => c.method === 'searchThreadIds').map((c) => c.args[0]);
}

function keysOf(value: unknown): string[] {
  return typeof value === 'object' && value !== null ? Object.keys(value).sort() : [];
}

/** Every job written to `state.manual`, in order. */
function savedJobs(ports: FakePorts): readonly ManualJob[] {
  return ports.state.calls
    .filter((c) => c.method === 'set' && c.args[0] === MANUAL_KEY)
    .map((c) => decodeManualJob(c.args[1]));
}

function stateWrites(ports: FakePorts): number {
  return ports.state.calls.filter((c) => c.method === 'set' || c.method === 'delete').length;
}

function queueOf(
  threadIds: readonly string[],
  source: 'scheduled' | 'manual',
  from: WorkQueue = [],
): WorkQueue {
  let queue = from;
  for (const threadId of threadIds) {
    const added = enqueue(queue, { threadId, source, enqueuedAt: 1 });
    if (!added.ok) {
      throw new Error('the test queue is full');
    }
    queue = added.queue;
  }
  return queue;
}

function numbered(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}${String(i)}`);
}

type SearchPage = { readonly threadIds: readonly string[]; readonly nextPageToken?: string };

/** A `GmailPort` whose search returns the given pages in order, then repeats the last one. */
function stubGmail(pages: readonly SearchPage[] | ((call: number) => SearchPage)): {
  readonly gmail: GmailPort;
  readonly requests: SearchThreadIdsRequest[];
} {
  const requests: SearchThreadIdsRequest[] = [];
  const unused = (): never => {
    throw new Error('the refill must only search');
  };
  const gmail: GmailPort = {
    getProfile: unused,
    listHistory: unused,
    getThread: unused,
    listLabels: unused,
    createLabel: unused,
    modifyThread: unused,
    searchThreadIds: (request) => {
      requests.push(request);
      const call = requests.length - 1;
      const page =
        typeof pages === 'function' ? pages(call) : pages[Math.min(call, pages.length - 1)];
      if (page === undefined) {
        throw new Error('the stub has no page');
      }
      return ok(page);
    },
  };
  return { gmail, requests };
}

/** A job that read two pages of three in an earlier execution: `seen` 6, with a token. */
function twoPagesIn(w: World): { job: ManualJob; queue: WorkQueue } {
  const first = refillManualQueue(newJob(), [], w.deps, times(2));
  expect(first.job.cursor.seen).toBe(6);
  expect(first.job.cursor.pageToken).toBeDefined();
  return { job: first.job, queue: first.queue };
}

describe('refillManualQueue: paging', () => {
  it('queues every page in order and finishes the search', () => {
    const w = world(7);
    let continues = 0;
    const result = refillManualQueue(newJob(), [], w.deps, () => {
      continues += 1;
      return true;
    });

    expect(result.pages).toBe(3);
    expect(result.queued).toBe(7);
    expect(result.merged).toBe(0);
    expect(result.stopGmail).toBeUndefined();
    expect(result.queue.map((item) => item.threadId)).toEqual(w.ids);
    expect(result.job.searchDone).toBe(true);
    expect(result.job.cursor).toEqual({ seen: 7 });
    expect(result.job.counts.pages).toBe(3);
    expect(result.job.counts.queued).toBe(7);

    expect(w.ports.gmail.searches).toEqual([QUERY, QUERY, QUERY]);
    const requests = searchRequests(w.ports);
    expect(requests[0]).toEqual({ q: QUERY, includeSpamTrash: false, maxResults: 100 });
    for (const request of requests.slice(1)) {
      expect(request).toMatchObject({ q: QUERY, includeSpamTrash: false, maxResults: 100 });
      expect(keysOf(request)).toEqual(['includeSpamTrash', 'maxResults', 'pageToken', 'q']);
    }
    // Once before every search call, and not again once the search is done.
    expect(continues).toBe(3);

    expect(loadQueue(w.ports.state)).toEqual(result.queue);
    expect(loadManualJob(w.ports.state)).toEqual(result.job);
    expect(w.ports.log.events).toEqual([]);
  });

  it('makes no thread read and no change', () => {
    const w = world(4);
    refillManualQueue(newJob(), [], w.deps, always);
    expect(w.ports.gmail.calls.every((c) => c.method === 'searchThreadIds')).toBe(true);
    expect(w.ports.http.calls).toEqual([]);
  });

  it('finishes a search that matches nothing in one call', () => {
    const w = world(0);
    const result = refillManualQueue(newJob(), [], w.deps, always);
    expect(result.pages).toBe(1);
    expect(result.queued).toBe(0);
    expect(result.queue).toEqual([]);
    expect(result.job.searchDone).toBe(true);
    expect(result.job.cursor).toEqual({ seen: 0 });
    expect(w.ports.gmail.searches).toEqual([QUERY]);
    expect(loadManualJob(w.ports.state)).toEqual(result.job);
  });

  it('continues from the saved token in a later call, queuing each thread once', () => {
    const w = world(7);
    const first = refillManualQueue(newJob(), [], w.deps, times(1));
    expect(first.pages).toBe(1);
    expect(first.queued).toBe(3);
    expect(first.job.searchDone).toBe(false);
    expect(first.job.cursor.seen).toBe(3);

    const second = refillManualQueue(first.job, first.queue, w.deps, always);
    expect(second.pages).toBe(2);
    expect(second.queued).toBe(4);
    expect(second.merged).toBe(0);
    expect(second.queue.map((item) => item.threadId)).toEqual(w.ids);
    expect(second.job.searchDone).toBe(true);
    expect(second.job.counts).toMatchObject({ pages: 3, queued: 7, merged: 0 });
    expect(searchRequests(w.ports)[1]).toMatchObject({ pageToken: first.job.cursor.pageToken });
  });
});

describe('refillManualQueue: items', () => {
  it('queues manual items with no flag and no position', () => {
    const w = world(2);
    const result = refillManualQueue(newJob(), [], w.deps, always);
    expect(result.queue).toEqual(
      w.ids.map((threadId) => ({ threadId, source: 'manual', enqueuedAt: NOW, strikes: 0 })),
    );
  });

  it('adds applyMoves only for a job that has it', () => {
    const w = world(2);
    const result = refillManualQueue(newJob(true), [], w.deps, always);
    expect(result.queue).toEqual(
      w.ids.map((threadId) => ({
        threadId,
        source: 'manual',
        enqueuedAt: NOW,
        strikes: 0,
        applyMoves: true,
      })),
    );
  });

  it.each([false, true])(
    'merges into a scheduled item and keeps its fields (applyMoves %s)',
    (applyMoves) => {
      const w = world(3);
      const [, second = ''] = w.ids;
      const scheduled = enqueue([], {
        threadId: second,
        source: 'scheduled',
        enqueuedAt: 5,
        positionSavedAt: 4,
      });
      if (!scheduled.ok) {
        throw new Error('unexpected');
      }
      const result = refillManualQueue(newJob(applyMoves), scheduled.queue, w.deps, always);

      expect(result.queued).toBe(2);
      expect(result.merged).toBe(1);
      expect(result.job.counts).toMatchObject({ queued: 2, merged: 1 });
      const item = result.queue.find((candidate) => candidate.threadId === second);
      expect(item).toEqual({
        threadId: second,
        source: 'scheduled',
        enqueuedAt: 5,
        strikes: 0,
        positionSavedAt: 4,
        ...(applyMoves ? { applyMoves: true } : {}),
      });
      expect(item).not.toHaveProperty('firstClassification');
    },
  );
});

describe('refillManualQueue: when it reads a page', () => {
  it('makes no call when canContinue is false at once', () => {
    const w = world(4);
    const job = newJob();
    const result = refillManualQueue(job, [], w.deps, () => false);
    expect(result).toEqual({ job, queue: [], pages: 0, queued: 0, merged: 0 });
    expect(w.ports.gmail.calls).toEqual([]);
    expect(w.ports.state.calls).toEqual([]);
  });

  it('makes no call when the search is done', () => {
    const w = world(2);
    const done = refillManualQueue(newJob(), [], w.deps, always);
    const calls = w.ports.gmail.calls.length;
    const again = refillManualQueue(done.job, done.queue, w.deps, () => {
      throw new Error('canContinue must not be asked');
    });
    expect(again.pages).toBe(0);
    expect(w.ports.gmail.calls).toHaveLength(calls);
  });

  it('makes no call with 101 manual items queued', () => {
    const w = world(4);
    const queue = queueOf(numbered('m', 101), 'manual');
    const result = refillManualQueue(newJob(), queue, w.deps, always);
    expect(result.pages).toBe(0);
    expect(result.queue).toBe(queue);
    expect(w.ports.gmail.calls).toEqual([]);
    expect(w.ports.state.calls).toEqual([]);
  });

  it('makes no call with 901 items queued', () => {
    const w = world(4);
    const queue = queueOf(numbered('s', 901), 'scheduled');
    const result = refillManualQueue(newJob(), queue, w.deps, always);
    expect(result.pages).toBe(0);
    expect(w.ports.gmail.calls).toEqual([]);
  });

  it('reads one page with 100 manual items queued, and stays within the manual cap', () => {
    const w = world(150, 100);
    const queue = queueOf(numbered('m', 100), 'manual');
    const result = refillManualQueue(newJob(), queue, w.deps, always);
    expect(result.pages).toBe(1);
    expect(result.queued).toBe(100);
    expect(result.queue.filter((item) => item.source === 'manual')).toHaveLength(200);
    expect(result.job.searchDone).toBe(false);
    expect(w.ports.gmail.searches).toHaveLength(1);
  });

  it('reads a page with 900 items queued', () => {
    const w = world(2);
    const queue = queueOf(numbered('s', 900), 'scheduled');
    const result = refillManualQueue(newJob(), queue, w.deps, always);
    expect(result.pages).toBe(1);
    expect(result.queue).toHaveLength(902);
  });

  it('stops without saving when a page does not fit', () => {
    const { ports } = world(0);
    const stub = stubGmail([{ threadIds: numbered('x', 101) }]);
    const queue = queueOf(numbered('m', 100), 'manual');
    const job = newJob();
    const result = refillManualQueue(job, queue, { ...ports, gmail: stub.gmail }, always);
    expect(result).toEqual({ job, queue, pages: 0, queued: 0, merged: 0 });
    expect(ports.state.calls).toEqual([]);
  });
});

describe('refillManualQueue: saving', () => {
  it('saves the queue before the job, and a repeated page merges', () => {
    const w = world(3);
    const job = newJob();
    saveManualJob(w.ports.state, job);
    w.ports.state.failNext(
      'set',
      new StateError('boom', { key: MANUAL_KEY, reason: 'too_large' }),
      {
        key: MANUAL_KEY,
      },
    );

    expect(() => refillManualQueue(job, [], w.deps, always)).toThrow(StateError);
    const queue = loadQueue(w.ports.state);
    expect(queue.map((item) => item.threadId)).toEqual(w.ids);
    expect(loadManualJob(w.ports.state)).toEqual(job);

    const again = refillManualQueue(job, queue, w.deps, always);
    expect(again.pages).toBe(1);
    expect(again.queued).toBe(0);
    expect(again.merged).toBe(3);
    expect(again.queue).toEqual(queue);
    expect(again.job.cursor).toEqual({ seen: 3 });
    expect(again.job.searchDone).toBe(true);
    expect(loadManualJob(w.ports.state)).toEqual(again.job);
  });

  it('writes the queue shard, then state.manual, for each page', () => {
    const w = world(4);
    refillManualQueue(newJob(), [], w.deps, always);
    const sets = w.ports.state.calls.filter((c) => c.method === 'set').map((c) => c.args[0]);
    expect(sets).toEqual(['state.queue.0', MANUAL_KEY, 'state.queue.0', MANUAL_KEY]);
  });
});

describe('refillManualQueue: Gmail failures', () => {
  const failures = [
    ['rate_limited', FakeGmail.rateLimited()],
    ['scope', fail('scope', { message: 'Request had insufficient authentication scopes.' })],
  ] as const;

  it.each(failures)('returns stopGmail %s on the first page and saves nothing', (kind, failure) => {
    const w = world(7);
    w.ports.gmail.failNext('searchThreadIds', failure);
    const job = newJob();
    const result = refillManualQueue(job, [], w.deps, always);
    expect(result).toEqual({ job, queue: [], pages: 0, queued: 0, merged: 0, stopGmail: kind });
    expect(w.ports.state.calls).toEqual([]);
    expect(w.ports.log.events).toEqual([]);
  });

  it.each(failures)(
    'returns stopGmail %s on a later page and keeps the earlier one',
    (kind, failure) => {
      const w = world(7);
      w.ports.gmail.failNext('searchThreadIds', failure, { after: 1 });
      const result = refillManualQueue(newJob(), [], w.deps, always);
      expect(result.stopGmail).toBe(kind);
      expect(result.pages).toBe(1);
      expect(result.queued).toBe(3);
      expect(result.job.cursor.seen).toBe(3);
      expect(result.job.cursor.pageToken).toBeDefined();
      expect(result.job.searchDone).toBe(false);
      expect(loadQueue(w.ports.state)).toEqual(result.queue);
      expect(loadManualJob(w.ports.state)).toEqual(result.job);
      expect(w.ports.log.events).toEqual([]);
    },
  );
});

describe('refillManualQueue: the cursor reset', () => {
  it('drops a rejected token, walks back without queuing, then queues the rest', () => {
    const w = world(8);
    const before = twoPagesIn(w);
    w.ports.gmail.invalidateSearchTokens();
    const searchesBefore = w.ports.gmail.searches.length;
    const savesBefore = savedJobs(w.ports).length;
    let continues = 0;

    const result = refillManualQueue(before.job, before.queue, w.deps, () => {
      continues += 1;
      return true;
    });

    // The rejected call, two walk pages, then the last page.
    expect(w.ports.gmail.searches.slice(searchesBefore)).toEqual([QUERY, QUERY, QUERY, QUERY]);
    expect(continues).toBe(4);
    expect(w.ports.log.events).toEqual([
      { level: 'warn', event: 'manual.cursor_reset', fields: { seen: 6, reason: 'rejected' } },
    ]);

    const saves = savedJobs(w.ports).slice(savesBefore);
    expect(saves).toHaveLength(3);
    // 1: the token dropped. 2: the walk's cursor. 3: the last page.
    expect(saves[0]).toEqual(dropPageToken(before.job));
    expect(saves[1]?.cursor.seen).toBe(6);
    expect(saves[1]?.cursor.pageToken).toBeDefined();
    expect(saves[1]?.cursor.pageToken).not.toBe(before.job.cursor.pageToken);
    expect(saves[1]?.counts).toEqual(before.job.counts);

    expect(result.pages).toBe(1);
    expect(result.queued).toBe(2);
    expect(result.merged).toBe(0);
    expect(result.queue.map((item) => item.threadId)).toEqual(w.ids);
    expect(result.job.searchDone).toBe(true);
    expect(result.job.cursor).toEqual({ seen: 8 });
    expect(result.job.counts).toMatchObject({ pages: 3, queued: 8, merged: 0 });
    expect(loadManualJob(w.ports.state)).toEqual(result.job);
  });

  it('leaves an unfinished walk for a later call, which logs it as pending', () => {
    const w = world(8);
    const before = twoPagesIn(w);
    w.ports.gmail.invalidateSearchTokens();

    // True for the rejected call and the walk's first page, false for its second.
    const stopped = refillManualQueue(before.job, before.queue, w.deps, times(2));
    expect(stopped.pages).toBe(0);
    expect(stopped.queued).toBe(0);
    expect(stopped.stopGmail).toBeUndefined();
    expect(stopped.job).toEqual(dropPageToken(before.job));
    expect(stopped.queue).toEqual(before.queue);
    expect(loadManualJob(w.ports.state)).toEqual(stopped.job);
    expect(w.ports.log.all('manual.cursor_reset').map((e) => e.fields)).toEqual([
      { seen: 6, reason: 'rejected' },
    ]);

    // No time at all: the walk doesn't start, and nothing is logged.
    const idle = refillManualQueue(stopped.job, stopped.queue, w.deps, () => false);
    expect(idle.job).toEqual(stopped.job);
    expect(w.ports.log.all('manual.cursor_reset')).toHaveLength(1);

    const finished = refillManualQueue(stopped.job, stopped.queue, w.deps, always);
    expect(w.ports.log.events.slice(1)).toEqual([
      { level: 'warn', event: 'manual.cursor_reset', fields: { seen: 6, reason: 'pending' } },
    ]);
    expect(finished.pages).toBe(1);
    expect(finished.queued).toBe(2);
    expect(finished.queue.map((item) => item.threadId)).toEqual(w.ids);
    expect(finished.job.searchDone).toBe(true);
    expect(finished.job.cursor).toEqual({ seen: 8 });
  });

  it.each([
    ['rate_limited', FakeGmail.rateLimited()],
    ['scope', fail('scope', { message: 'Request had insufficient authentication scopes.' })],
  ] as const)('returns stopGmail %s from a walk and leaves it unfinished', (kind, failure) => {
    const w = world(8);
    const before = twoPagesIn(w);
    const job = dropPageToken(before.job);
    w.ports.gmail.failNext('searchThreadIds', failure, { after: 1 });
    const writes = stateWrites(w.ports);

    const result = refillManualQueue(job, before.queue, w.deps, always);
    expect(result.stopGmail).toBe(kind);
    expect(result.job).toEqual(job);
    expect(result.pages).toBe(0);
    expect(stateWrites(w.ports)).toBe(writes);
  });

  it('ends the search when the walk meets the end of the results', () => {
    const w = world(8);
    const before = twoPagesIn(w);
    w.ports.gmail.invalidateSearchTokens();
    for (const id of w.ids.slice(4)) {
      w.matching.delete(id);
    }

    const result = refillManualQueue(before.job, before.queue, w.deps, always);
    expect(result.pages).toBe(0);
    expect(result.queued).toBe(0);
    expect(result.merged).toBe(0);
    expect(result.queue).toEqual(before.queue);
    expect(result.job.searchDone).toBe(true);
    expect(result.job.cursor).toEqual({ seen: 4 });
    expect(result.job.counts).toEqual(before.job.counts);
    expect(loadManualJob(w.ports.state)).toEqual(result.job);
  });

  it('ends the search when the results end exactly at the target', () => {
    const w = world(6);
    const job = dropPageToken(
      advanceCursor(newJob(), { idsOnPage: 6, queued: 6, merged: 0, nextPageToken: 'tok' }),
    );
    const result = refillManualQueue(job, [], w.deps, always);
    expect(result.pages).toBe(0);
    expect(result.job.searchDone).toBe(true);
    expect(result.job.cursor).toEqual({ seen: 6 });
  });

  it('restores the cursor at the boundary before a target that is inside a page', () => {
    const w = world(8);
    // `seen` 4 at 3 per page: an earlier execution saw a short page.
    const job = dropPageToken(
      advanceCursor(newJob(), { idsOnPage: 4, queued: 4, merged: 0, nextPageToken: 'tok' }),
    );
    const queue = queueOf(w.ids.slice(0, 4), 'manual');

    const result = refillManualQueue(job, queue, w.deps, always);

    expect(w.ports.log.events).toEqual([
      { level: 'warn', event: 'manual.cursor_reset', fields: { seen: 4, reason: 'pending' } },
    ]);
    const saves = savedJobs(w.ports);
    expect(saves[0]?.cursor.seen).toBe(3);
    expect(saves[0]?.cursor.pageToken).toBeDefined();
    expect(saves[0]?.searchDone).toBe(false);
    // Walk: pages 1 and 2. Queue: page 2 again, then page 3.
    expect(w.ports.gmail.searches).toHaveLength(4);
    expect(searchRequests(w.ports)[2]).toMatchObject({ pageToken: saves[0]?.cursor.pageToken });
    expect(result.pages).toBe(2);
    expect(result.queued).toBe(4);
    expect(result.merged).toBe(1);
    expect(result.queue.map((item) => item.threadId)).toEqual(w.ids);
    expect(result.job.searchDone).toBe(true);
    expect(result.job.cursor).toEqual({ seen: 8 });
  });

  it('goes back to the first page when the first page already passes the target', () => {
    const w = world(5);
    const job = dropPageToken(
      advanceCursor(newJob(), { idsOnPage: 2, queued: 2, merged: 0, nextPageToken: 'tok' }),
    );
    const result = refillManualQueue(job, [], w.deps, always);
    expect(savedJobs(w.ports)[0]?.cursor).toEqual({ seen: 0 });
    expect(result.pages).toBe(2);
    expect(result.queue.map((item) => item.threadId)).toEqual(w.ids);
    expect(result.job.cursor).toEqual({ seen: 5 });
  });

  it('reads the first page again when a rejected token belonged to a job with nothing seen', () => {
    // An empty page that still had a next token (spike 287) left `seen` 0 with a token.
    const job = advanceCursor(newJob(), {
      idsOnPage: 0,
      queued: 0,
      merged: 0,
      nextPageToken: 'old',
    });
    const w = world(2);
    w.ports.gmail.failNext('searchThreadIds', FakeGmail.invalidPageToken());
    const result = refillManualQueue(job, [], w.deps, always);
    expect(w.ports.log.all('manual.cursor_reset').map((e) => e.fields)).toEqual([
      { seen: 0, reason: 'rejected' },
    ]);
    expect(result.queue.map((item) => item.threadId)).toEqual(w.ids);
    expect(result.job.searchDone).toBe(true);
    expect(result.job.cursor).toEqual({ seen: 2 });
    // The rejected call, then the first page with no token.
    expect(searchRequests(w.ports)).toHaveLength(2);
    expect(keysOf(searchRequests(w.ports)[1])).not.toContain('pageToken');
  });
});

describe('refillManualQueue: unexpected responses', () => {
  it('throws for a rejected token that this call got from Gmail', () => {
    const w = world(7);
    w.ports.gmail.failNext('searchThreadIds', FakeGmail.invalidPageToken(), { after: 1 });
    expect(() => refillManualQueue(newJob(), [], w.deps, always)).toThrow(UnexpectedResponseError);
    // The first page stays saved, with its token.
    expect(loadManualJob(w.ports.state)?.cursor.seen).toBe(3);
    expect(loadManualJob(w.ports.state)?.cursor.pageToken).toBeDefined();
    expect(w.ports.log.events).toEqual([]);
  });

  it('throws for a rejection when no token was sent', () => {
    const w = world(7);
    w.ports.gmail.failNext('searchThreadIds', FakeGmail.invalidPageToken());
    expect(() => refillManualQueue(newJob(), [], w.deps, always)).toThrow(UnexpectedResponseError);
    expect(w.ports.state.calls).toEqual([]);
  });

  it('throws for a rejected token inside a walk', () => {
    const w = world(8);
    const before = twoPagesIn(w);
    const job = dropPageToken(before.job);
    w.ports.gmail.failNext('searchThreadIds', FakeGmail.invalidPageToken(), { after: 1 });
    const writes = stateWrites(w.ports);
    expect(() => refillManualQueue(job, before.queue, w.deps, always)).toThrow(
      UnexpectedResponseError,
    );
    expect(stateWrites(w.ports)).toBe(writes);
  });

  it('throws for a token restored by a walk and then rejected', () => {
    const w = world(8);
    const before = twoPagesIn(w);
    w.ports.gmail.invalidateSearchTokens();
    // The stale token, two walk pages, then the page after the walk.
    w.ports.gmail.failNext('searchThreadIds', FakeGmail.invalidPageToken(), { after: 3 });
    expect(() => refillManualQueue(before.job, before.queue, w.deps, always)).toThrow(
      UnexpectedResponseError,
    );
    expect(w.ports.log.all('manual.cursor_reset')).toHaveLength(1);
  });

  it('throws for a next token that cannot be stored, saving nothing', () => {
    const { ports } = world(0);
    const stub = stubGmail([{ threadIds: ['a', 'b'], nextPageToken: 'bad token' }]);
    let thrown: unknown;
    try {
      refillManualQueue(newJob(), [], { ...ports, gmail: stub.gmail }, always);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnexpectedResponseError);
    expect(thrown).toMatchObject({ service: 'gmail' });
    const text =
      thrown instanceof UnexpectedResponseError
        ? JSON.stringify([thrown.message, thrown.toLogFields()])
        : '';
    expect(text).not.toContain('bad token');
    expect(text).not.toContain(QUERY);
    expect(ports.state.calls).toEqual([]);
  });

  it('throws for a next token that cannot be stored inside a walk', () => {
    const { ports } = world(0);
    const stub = stubGmail([{ threadIds: ['a'], nextPageToken: 'bad token' }]);
    const job = dropPageToken(
      advanceCursor(newJob(), { idsOnPage: 3, queued: 3, merged: 0, nextPageToken: 'tok' }),
    );
    expect(() => refillManualQueue(job, [], { ...ports, gmail: stub.gmail }, always)).toThrow(
      UnexpectedResponseError,
    );
    expect(ports.state.calls).toEqual([]);
  });

  it('throws when Gmail returns the token it was sent', () => {
    const { ports } = world(0);
    const stub = stubGmail([{ threadIds: ['a'], nextPageToken: 'tok' }]);
    const job = advanceCursor(newJob(), {
      idsOnPage: 1,
      queued: 1,
      merged: 0,
      nextPageToken: 'tok',
    });
    expect(() => refillManualQueue(job, [], { ...ports, gmail: stub.gmail }, always)).toThrow(
      UnexpectedResponseError,
    );
    expect(stub.requests).toHaveLength(1);
    expect(ports.state.calls).toEqual([]);
  });
});

describe('refillManualQueue: empty pages that still have a next token', () => {
  it('follows one without harming the job', () => {
    const { ports } = world(0);
    const stub = stubGmail([{ threadIds: [], nextPageToken: 't1' }, { threadIds: ['a', 'b'] }]);
    const result = refillManualQueue(newJob(), [], { ...ports, gmail: stub.gmail }, always);
    expect(stub.requests.map((r) => r.pageToken)).toEqual([undefined, 't1']);
    expect(result.pages).toBe(2);
    expect(result.queued).toBe(2);
    expect(result.job.cursor).toEqual({ seen: 2 });
    expect(result.job.searchDone).toBe(true);
    expect(loadManualJob(ports.state)).toEqual(result.job);
  });

  it('throws after too many in a row, keeping the pages before', () => {
    const { ports } = world(0);
    const stub = stubGmail((call) => ({ threadIds: [], nextPageToken: `t${String(call)}` }));
    expect(() => refillManualQueue(newJob(), [], { ...ports, gmail: stub.gmail }, always)).toThrow(
      UnexpectedResponseError,
    );
    expect(stub.requests).toHaveLength(REFILL_MAX_EMPTY_PAGES + 1);
    const saved = loadManualJob(ports.state);
    expect(saved?.counts.pages).toBe(REFILL_MAX_EMPTY_PAGES);
    expect(saved?.cursor).toEqual({ seen: 0, pageToken: `t${String(REFILL_MAX_EMPTY_PAGES - 1)}` });
    expect(saved?.searchDone).toBe(false);
  });

  it('throws after too many in a row inside a walk, saving nothing', () => {
    const { ports } = world(0);
    const stub = stubGmail((call) => ({ threadIds: [], nextPageToken: `t${String(call)}` }));
    const job = dropPageToken(
      advanceCursor(newJob(), { idsOnPage: 3, queued: 3, merged: 0, nextPageToken: 'tok' }),
    );
    expect(() => refillManualQueue(job, [], { ...ports, gmail: stub.gmail }, always)).toThrow(
      UnexpectedResponseError,
    );
    expect(stub.requests).toHaveLength(REFILL_MAX_EMPTY_PAGES + 1);
    expect(ports.state.calls).toEqual([]);
  });

  it('starts the count again after a page with threads', () => {
    const { ports } = world(0);
    const total = 2 * REFILL_MAX_EMPTY_PAGES + 2;
    const stub = stubGmail((call) => {
      if (call === total - 1) {
        return { threadIds: [] };
      }
      return call === REFILL_MAX_EMPTY_PAGES
        ? { threadIds: ['a'], nextPageToken: `t${String(call)}` }
        : { threadIds: [], nextPageToken: `t${String(call)}` };
    });
    const result = refillManualQueue(newJob(), [], { ...ports, gmail: stub.gmail }, always);
    expect(result.pages).toBe(total);
    expect(result.queued).toBe(1);
    expect(result.job.searchDone).toBe(true);
  });
});

describe('refillManualQueue: privacy', () => {
  it('logs no query, token or thread ID', () => {
    const w = world(8);
    const before = twoPagesIn(w);
    w.ports.gmail.invalidateSearchTokens();
    const stopped = refillManualQueue(before.job, before.queue, w.deps, times(2));
    refillManualQueue(stopped.job, stopped.queue, w.deps, always);

    expect(w.ports.log.events.map((e) => e.event)).toEqual([
      'manual.cursor_reset',
      'manual.cursor_reset',
    ]);
    for (const event of w.ports.log.events) {
      expect(Object.keys(event.fields).sort()).toEqual(['reason', 'seen']);
    }
    const text = JSON.stringify(w.ports.log.events);
    expect(text).not.toContain(QUERY);
    expect(text).not.toContain('receipts');
    for (const id of w.ids) {
      expect(text).not.toContain(id);
    }
    const tokens = savedJobs(w.ports).flatMap((job) =>
      job.cursor.pageToken === undefined ? [] : [job.cursor.pageToken],
    );
    expect(tokens.length).toBeGreaterThan(0);
    for (const token of tokens) {
      expect(text).not.toContain(token);
    }
  });
});
