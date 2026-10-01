import { describe, expect, it } from 'vitest';

import {
  EXCLUSION_SEARCH_MAX_PAGES,
  EXCLUSION_SEARCH_PAGE_SIZE,
  searchExcludedThreads,
} from '../../src/app/exclusion-search.ts';
import { buildExclusionQuery } from '../../src/core/exclusion-query.ts';
import { UnexpectedResponseError } from '../../src/core/errors.ts';
import type { GmailMessage, GmailThread } from '../../src/core/gmail-types.ts';
import type { SearchThreadIdsRequest } from '../../src/ports/gmail-port.ts';
import { FakeGmail } from '../fakes/fake-gmail.ts';
import { type FakePortsOptions, createFakePorts } from '../fakes/fake-ports.ts';

const EXCLUDE_QUERY = 'from:bank@example.com';
const GMAIL_MODIFY = 'https://www.googleapis.com/auth/gmail.modify';
const DAY_MS = 86_400_000;
/** The oldest date in the scenarios. */
const D_OLD = Date.parse('2026-03-01T00:00:00Z');
/** `createFakePorts()`'s default clock. */
const NOW = Date.parse('2026-09-26T12:00:00Z');

function header(message: GmailMessage, name: string): string | undefined {
  return message.payload?.headers?.find((h) => h.name === name)?.value;
}

/**
 * A search engine that respects the window: a message matches only when the
 * predicate holds and its `internalDate` (in seconds) is inside the query's
 * `after:` and `before:` bounds, inclusive. The fake never parses queries, so
 * the window lives here.
 */
function windowedMatcher(
  predicate: (message: GmailMessage) => boolean,
): (q: string, message: GmailMessage) => boolean {
  return (q, message) => {
    const after = /after:(\d+)/.exec(q)?.[1];
    const before = /before:(\d+)/.exec(q)?.[1];
    const seconds = Math.floor(Number(message.internalDate) / 1000);
    if (after !== undefined && seconds < Number(after)) {
      return false;
    }
    if (before !== undefined && seconds > Number(before)) {
      return false;
    }
    return predicate(message);
  };
}

const isBank = (message: GmailMessage): boolean => header(message, 'From') === 'bank@example.com';

type Delivery = {
  readonly at: number;
  readonly matches?: boolean;
  readonly threadId?: string;
  readonly labelIds?: readonly string[];
};

function deliver(gmail: FakeGmail, options: Delivery): string {
  return gmail.deliver({
    internalDate: options.at,
    ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
    ...(options.labelIds === undefined ? {} : { labelIds: options.labelIds }),
    headers: [
      { name: 'From', value: options.matches === true ? 'bank@example.com' : 'friend@example.com' },
    ],
  }).threadId;
}

/** The chunk threads as the metadata read returns them. */
function metadataThreads(gmail: FakeGmail, ids: readonly string[]): GmailThread[] {
  return ids.map((id) => {
    const result = gmail.getThread(id, { format: 'metadata', metadataHeaders: ['Date'] });
    if (!result.ok) {
      throw new Error(`metadata read failed: ${result.kind}`);
    }
    return result.thread;
  });
}

function searchRequests(gmail: FakeGmail): SearchThreadIdsRequest[] {
  const requests: SearchThreadIdsRequest[] = [];
  for (const call of gmail.calls) {
    if (call.method === 'searchThreadIds') {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the fake records the request as its only argument
      requests.push(call.args[0] as SearchThreadIdsRequest);
    }
  }
  return requests;
}

function setup(options: FakePortsOptions = {}) {
  const ports = createFakePorts(options);
  ports.gmail.setSearchMatcher(windowedMatcher(isBank));
  const run = (threads: readonly GmailThread[]) =>
    searchExcludedThreads({ gmail: ports.gmail, clock: ports.clock }, EXCLUDE_QUERY, threads);
  return { ...ports, run };
}

function unwrap<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) {
    throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  }
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- TypeScript can't narrow a generic union on `ok`; the check above makes this safe
  return result as Extract<T, { ok: true }>;
}

describe('searchExcludedThreads: one search for the chunk', () => {
  it('excludes a thread whose only match is its oldest message', () => {
    const { gmail, run } = setup();
    const t = deliver(gmail, { at: D_OLD, matches: true });
    deliver(gmail, { threadId: t, at: D_OLD + 30 * DAY_MS });
    deliver(gmail, { threadId: t, at: D_OLD + 31 * DAY_MS });
    const other = deliver(gmail, { at: D_OLD + 31 * DAY_MS });
    const result = unwrap(run(metadataThreads(gmail, [other, t])));
    expect(result.excluded).toEqual(new Map([[t, 'matched']]));
  });

  it('excludes a thread whose only match is in Trash, and asks for Spam and Trash', () => {
    const { gmail, run } = setup();
    const t = deliver(gmail, { at: D_OLD, labelIds: ['INBOX'] });
    deliver(gmail, { threadId: t, at: D_OLD + DAY_MS, matches: true, labelIds: ['TRASH'] });
    const result = unwrap(run(metadataThreads(gmail, [t])));
    expect(result.excluded).toEqual(new Map([[t, 'matched']]));
    expect(searchRequests(gmail).every((r) => r.includeSpamTrash)).toBe(true);
  });

  it('leaves a thread with no match out of the map', () => {
    const { gmail, run } = setup();
    const clean = deliver(gmail, { at: D_OLD });
    const hit = deliver(gmail, { at: D_OLD + DAY_MS, matches: true });
    const result = unwrap(run(metadataThreads(gmail, [clean, hit])));
    expect(result.excluded).toEqual(new Map([[hit, 'matched']]));
    expect(result.excluded.has(clean)).toBe(false);
  });

  it('sends the exact query from buildExclusionQuery with maxResults 500', () => {
    const { gmail, run } = setup();
    const t = deliver(gmail, { at: D_OLD, matches: true });
    const threads = metadataThreads(gmail, [t]);
    const result = unwrap(run(threads));
    expect(gmail.searches).toEqual([buildExclusionQuery(EXCLUDE_QUERY, threads, NOW)]);
    expect(searchRequests(gmail).map((r) => r.maxResults)).toEqual([500]);
    expect(EXCLUSION_SEARCH_PAGE_SIZE).toBe(500);
    expect(result.searchCalls).toBe(1);
  });

  it('makes no call for no threads', () => {
    const { gmail, run } = setup();
    expect(unwrap(run([]))).toEqual({ ok: true, excluded: new Map(), searchCalls: 0 });
    expect(gmail.calls).toEqual([]);
  });
});

describe('searchExcludedThreads: paging', () => {
  it('finds a thread on page 3 and passes each page token', () => {
    const { gmail, run } = setup({ gmail: { maxSearchPageSize: 1 } });
    deliver(gmail, { at: D_OLD, matches: true });
    deliver(gmail, { at: D_OLD, matches: true });
    const t = deliver(gmail, { at: D_OLD, matches: true });
    const result = unwrap(run(metadataThreads(gmail, [t])));
    expect(result.excluded).toEqual(new Map([[t, 'matched']]));
    expect(result.searchCalls).toBe(3);
    const tokens = searchRequests(gmail).map((r) => r.pageToken);
    expect(tokens[0]).toBeUndefined();
    expect(tokens[1]).toEqual(expect.any(String));
    expect(tokens[2]).toEqual(expect.any(String));
    expect(tokens[2]).not.toBe(tokens[1]);
  });

  it('stops paging once every thread is found, although a nextPageToken remains', () => {
    const { gmail, run } = setup({ gmail: { maxSearchPageSize: 1 } });
    const a = deliver(gmail, { at: D_OLD, matches: true });
    const b = deliver(gmail, { at: D_OLD, matches: true });
    deliver(gmail, { at: D_OLD, matches: true });
    deliver(gmail, { at: D_OLD, matches: true });
    const result = unwrap(run(metadataThreads(gmail, [a, b])));
    expect(result.excluded).toEqual(
      new Map([
        [a, 'matched'],
        [b, 'matched'],
      ]),
    );
    expect(result.searchCalls).toBe(2);
  });

  it('keeps paging past pages of non-chunk threads until nextPageToken is missing', () => {
    const { gmail, run } = setup({ gmail: { maxSearchPageSize: 2 } });
    deliver(gmail, { at: D_OLD, matches: true });
    deliver(gmail, { at: D_OLD, matches: true });
    deliver(gmail, { at: D_OLD, matches: true });
    const clean = deliver(gmail, { at: D_OLD });
    const result = unwrap(run(metadataThreads(gmail, [clean])));
    expect(result.excluded.size).toBe(0);
    expect(result.searchCalls).toBe(2);
  });
});

describe('searchExcludedThreads: the 20-page bound and the per-thread fallback', () => {
  /**
   * 25 matching threads that aren't in the chunk, so a chunk search of one ID
   * a page can't finish in 20 pages, and these chunk threads:
   *
   * - `x` matches and is among the first 20 results (found by the chunk search);
   * - `r` matches and is dated 60 days later (found by its own, narrower window);
   * - `o` doesn't match and is the oldest, so its own window still holds every
   *   noise thread (its own search reaches 20 pages);
   * - `n` doesn't match and is dated 70 days later (its own window is empty).
   */
  function scenario(options: FakePortsOptions = {}) {
    const world = setup({ ...options, gmail: { maxSearchPageSize: 1 } });
    const { gmail } = world;
    const noiseAt = D_OLD + 10 * DAY_MS;
    for (let i = 0; i < 5; i++) {
      deliver(gmail, { at: noiseAt, matches: true });
    }
    const x = deliver(gmail, { at: noiseAt, matches: true });
    for (let i = 0; i < 20; i++) {
      deliver(gmail, { at: noiseAt, matches: true });
    }
    const r = deliver(gmail, { at: D_OLD + 60 * DAY_MS, matches: true });
    const o = deliver(gmail, { at: D_OLD });
    const n = deliver(gmail, { at: D_OLD + 70 * DAY_MS });
    return { ...world, x, r, o, n };
  }

  it('stops the chunk search at exactly 20 calls, then searches each thread not yet found, in order', () => {
    const { gmail, run, x, r, o, n } = scenario();
    const threads = metadataThreads(gmail, [x, r, o, n]);
    const result = unwrap(run(threads));
    const own = (index: number) => {
      const thread = threads[index];
      if (thread === undefined) {
        throw new Error('no such thread');
      }
      return buildExclusionQuery(EXCLUDE_QUERY, [thread], NOW);
    };
    expect(EXCLUSION_SEARCH_MAX_PAGES).toBe(20);
    expect(gmail.searches).toEqual([
      ...Array.from({ length: 20 }, () => buildExclusionQuery(EXCLUDE_QUERY, threads, NOW)),
      own(1),
      ...Array.from({ length: 20 }, () => own(2)),
      own(3),
    ]);
    expect(result.searchCalls).toBe(42);
    expect(result.excluded).toEqual(
      new Map([
        [x, 'matched'],
        [r, 'matched'],
        [o, 'search_capped'],
      ]),
    );
    expect(result.excluded.has(n)).toBe(false);
  });

  it('marks a thread found by its own search as matched, with no search for a thread already found', () => {
    const { gmail, run, x, r } = scenario();
    const result = unwrap(run(metadataThreads(gmail, [x, r])));
    expect(result.excluded).toEqual(
      new Map([
        [x, 'matched'],
        [r, 'matched'],
      ]),
    );
    expect(result.searchCalls).toBe(21);
    expect(searchRequests(gmail)).toHaveLength(21);
  });

  it('does not exclude a thread whose own search ends with no match', () => {
    const { gmail, run, x, n } = scenario();
    const result = unwrap(run(metadataThreads(gmail, [x, n])));
    expect(result.excluded).toEqual(new Map([[x, 'matched']]));
    expect(result.searchCalls).toBe(21);
  });

  it('treats a thread whose own search also reaches 20 pages as excluded (search_capped)', () => {
    const { gmail, run, x, o } = scenario();
    const result = unwrap(run(metadataThreads(gmail, [x, o])));
    expect(result.excluded).toEqual(
      new Map([
        [x, 'matched'],
        [o, 'search_capped'],
      ]),
    );
    expect(result.searchCalls).toBe(40);
  });

  it('uses the time read at the start for every query, however long the search takes', () => {
    // Each Gmail call moves the clock 10 days on: a clock read per query would change `before:`.
    const { gmail, run, x, r, o, n } = scenario({ gmailLatencyMs: 10 * DAY_MS });
    const threads = metadataThreads(gmail, [x, r, o, n]);
    const start = gmail.searches.length;
    unwrap(run(threads));
    const bounds = new Set(gmail.searches.slice(start).map((q) => /before:(\d+)/.exec(q)?.[1]));
    expect(bounds.size).toBe(1);
  });

  it('returns rate_limited during the fallback, with no partial map and no further call', () => {
    const { gmail, run, x, r, n } = scenario();
    const threads = metadataThreads(gmail, [x, r, n]);
    let searches = 0;
    gmail.onCall = (method) => {
      searches += method === 'searchThreadIds' ? 1 : 0;
      if (method === 'searchThreadIds' && searches === 21) {
        gmail.failNext('searchThreadIds', FakeGmail.rateLimited());
      }
    };
    const result = run(threads);
    expect(result).toMatchObject({ ok: false, kind: 'rate_limited' });
    expect(result).not.toHaveProperty('excluded');
    expect(searchRequests(gmail)).toHaveLength(21);
  });
});

describe('searchExcludedThreads: failures', () => {
  it('returns rate_limited on the first page and makes no further call', () => {
    const { gmail, run } = setup({ gmail: { maxSearchPageSize: 1 } });
    const t = deliver(gmail, { at: D_OLD, matches: true });
    gmail.failNext('searchThreadIds', FakeGmail.rateLimited());
    const result = run(metadataThreads(gmail, [t]));
    expect(result).toMatchObject({ ok: false, kind: 'rate_limited' });
    expect(searchRequests(gmail)).toHaveLength(1);
  });

  it('returns rate_limited on a later page, with no partial map and no further call', () => {
    const { gmail, run } = setup({ gmail: { maxSearchPageSize: 1 } });
    const found = deliver(gmail, { at: D_OLD, matches: true });
    deliver(gmail, { at: D_OLD, matches: true });
    const late = deliver(gmail, { at: D_OLD, matches: true });
    const threads = metadataThreads(gmail, [found, late]);
    let searches = 0;
    gmail.onCall = (method) => {
      searches += method === 'searchThreadIds' ? 1 : 0;
      if (method === 'searchThreadIds' && searches === 2) {
        gmail.failNext('searchThreadIds', FakeGmail.rateLimited());
      }
    };
    const result = run(threads);
    expect(result).toMatchObject({ ok: false, kind: 'rate_limited' });
    expect(result).not.toHaveProperty('excluded');
    expect(searchRequests(gmail)).toHaveLength(2);
  });

  it('returns scope while gmail.modify is revoked', () => {
    const { gmail, scopes, run } = setup();
    const t = deliver(gmail, { at: D_OLD, matches: true });
    const threads = metadataThreads(gmail, [t]);
    scopes.revoke(GMAIL_MODIFY);
    expect(run(threads)).toMatchObject({ ok: false, kind: 'scope' });
    expect(searchRequests(gmail)).toHaveLength(1);
  });

  it('throws UnexpectedResponseError for a page token rejected on the second page, without the query', () => {
    const { gmail, run } = setup({ gmail: { maxSearchPageSize: 1 } });
    deliver(gmail, { at: D_OLD, matches: true });
    deliver(gmail, { at: D_OLD, matches: true });
    const late = deliver(gmail, { at: D_OLD, matches: true });
    const threads = metadataThreads(gmail, [late]);
    let searches = 0;
    gmail.onCall = (method) => {
      searches += method === 'searchThreadIds' ? 1 : 0;
      if (method === 'searchThreadIds' && searches === 2) {
        gmail.invalidateSearchTokens();
      }
    };
    let thrown: unknown;
    try {
      run(threads);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnexpectedResponseError);
    expect(thrown).toMatchObject({ service: 'gmail' });
    const text = JSON.stringify(
      thrown instanceof UnexpectedResponseError
        ? { message: thrown.message, fields: thrown.toLogFields() }
        : {},
    );
    expect(text).not.toContain('bank@example.com');
    expect(text).not.toContain('from:');
    expect(searchRequests(gmail)).toHaveLength(2);
  });

  it('lets an unrecognized Gmail error propagate', () => {
    const { gmail, run } = setup();
    const t = deliver(gmail, { at: D_OLD, matches: true });
    const threads = metadataThreads(gmail, [t]);
    gmail.failNext('searchThreadIds', new Error('Unexpected Gmail error'));
    expect(() => run(threads)).toThrow('Unexpected Gmail error');
  });
});
