import { describe, expect, it } from 'vitest';

import { rememberJevErrorLabelId } from '../../src/app/jev-error-label-store.ts';
import { screenChunk, type ScreenCounts } from '../../src/app/screen-chunk.ts';
import { loadConfig } from '../../src/config/loader.ts';
import type { Config } from '../../src/config/schema.ts';
import { StateError } from '../../src/core/errors.ts';
import { buildExclusionQuery } from '../../src/core/exclusion-query.ts';
import type { GmailMessage } from '../../src/core/gmail-types.ts';
import { JEV_ERROR_LABEL_KEY } from '../../src/core/jev-error-label.ts';
import { enqueue, takeChunk, type WorkItem, type WorkQueue } from '../../src/core/work-queue.ts';
import { FakeGmail } from '../fakes/fake-gmail.ts';
import { createFakePorts, type FakePorts, type FakePortsOptions } from '../fakes/fake-ports.ts';

const EXCLUDE_QUERY = 'from:bank@example.com';
const GMAIL_MODIFY = 'https://www.googleapis.com/auth/gmail.modify';
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** `createFakePorts()`'s default clock. */
const NOW = Date.parse('2026-09-26T12:00:00Z');
/** The `savedAt` of the position the items were queued against: an hour ago. */
const SAVED_AT = NOW - HOUR_MS;
const OLD = NOW - 30 * DAY_MS;

function config(excludeQuery: string | null = EXCLUDE_QUERY): Config {
  return loadConfig({
    defaultThreshold: 0.8,
    triggerIntervalMinutes: 10,
    ...(excludeQuery === null ? {} : { excludeQuery }),
    rules: [{ id: 'bill', question: 'Is this email a bill?', label: 'Bill' }],
  });
}

function header(message: GmailMessage, name: string): string | undefined {
  return message.payload?.headers?.find((h) => h.name === name)?.value;
}

/** A search engine that respects the query's inclusive `after:` and `before:` window. */
function windowedMatcher(q: string, message: GmailMessage): boolean {
  const after = /after:(\d+)/.exec(q)?.[1];
  const before = /before:(\d+)/.exec(q)?.[1];
  const seconds = Math.floor(Number(message.internalDate) / 1000);
  if (after !== undefined && seconds < Number(after)) return false;
  if (before !== undefined && seconds > Number(before)) return false;
  return header(message, 'From') === 'bank@example.com';
}

type Delivery = {
  readonly at?: number;
  readonly matches?: boolean;
  readonly threadId?: string;
  readonly labelIds?: readonly string[];
};

function deliver(gmail: FakeGmail, options: Delivery = {}): string {
  return gmail.deliver({
    internalDate: options.at ?? NOW - 10 * 60_000,
    ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
    ...(options.labelIds === undefined ? {} : { labelIds: options.labelIds }),
    headers: [
      { name: 'From', value: options.matches === true ? 'bank@example.com' : 'friend@example.com' },
      { name: 'Subject', value: 'a private subject' },
    ],
  }).threadId;
}

function item(threadId: string, extra: Partial<WorkItem> = {}): WorkItem {
  return {
    threadId,
    source: 'scheduled',
    enqueuedAt: NOW - 5 * 60_000,
    strikes: 0,
    positionSavedAt: SAVED_AT,
    ...extra,
  };
}

/** A queue holding the items (through `enqueue`, so it is in canonical order and has no duplicates). */
function queueOf(items: readonly WorkItem[]): WorkQueue {
  let queue: WorkQueue = [];
  for (const {
    threadId,
    source,
    enqueuedAt,
    positionSavedAt,
    firstClassification,
    applyMoves,
  } of items) {
    const result = enqueue(queue, {
      threadId,
      source,
      enqueuedAt,
      ...(positionSavedAt === undefined ? {} : { positionSavedAt }),
      ...(firstClassification === undefined ? {} : { firstClassification }),
      ...(applyMoves === undefined ? {} : { applyMoves }),
    });
    if (!result.ok) throw new Error('queue full');
    queue = result.queue;
  }
  return queue;
}

function unwrap<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- TypeScript can't narrow a generic union on `ok`; the check above makes this safe
  return result as Extract<T, { ok: true }>;
}

function setup(options: FakePortsOptions = {}) {
  const ports = createFakePorts(options);
  ports.gmail.setSearchMatcher(windowedMatcher);
  return ports;
}

/** Screens the whole queue as one chunk, and returns the Gmail calls the call made (setup calls excluded). */
function screen(ports: FakePorts, cfg: Config, queue: WorkQueue, size = 100) {
  const callsBefore = ports.gmail.calls.length;
  const result = screenChunk(ports, cfg, queue, takeChunk(queue, size));
  return { result, calls: ports.gmail.calls.slice(callsBefore) };
}

function ids(queue: WorkQueue): string[] {
  return queue.map((i) => i.threadId);
}

describe('screenChunk: the metadata read', () => {
  it('reads every chunk thread once, in metadata form with the Date header, and nothing else', () => {
    const ports = setup();
    const a = deliver(ports.gmail);
    const b = deliver(ports.gmail);
    const queue = queueOf([item(a), item(b)]);
    const { result, calls } = screen(ports, config(), queue);
    unwrap(result);
    expect(calls.filter((c) => c.method === 'getThread').map((c) => c.args)).toEqual([
      [a, { format: 'metadata', metadataHeaders: ['Date'] }],
      [b, { format: 'metadata', metadataHeaders: ['Date'] }],
    ]);
    expect(calls.map((c) => c.method).filter((m) => m !== 'getThread')).toEqual([
      'searchThreadIds',
    ]);
  });

  it('screens only the chunk, not the rest of the queue', () => {
    const ports = setup();
    const a = deliver(ports.gmail);
    const b = deliver(ports.gmail, { matches: true });
    const queue = queueOf([item(a), item(b, { enqueuedAt: NOW })]);
    const { result, calls } = screen(ports, config(), queue, 1);
    const out = unwrap(result);
    expect(calls.filter((c) => c.method === 'getThread')).toHaveLength(1);
    expect(ids(out.queue)).toEqual([a, b]);
    expect(out.kept.map((k) => k.item.threadId)).toEqual([a]);
  });
});

describe('screenChunk: the exclusion check', () => {
  it('excludes a thread where only the oldest message matches', () => {
    const ports = setup();
    const t = deliver(ports.gmail, { at: OLD, matches: true });
    deliver(ports.gmail, { threadId: t, at: NOW - 20 * DAY_MS });
    deliver(ports.gmail, { threadId: t, at: NOW - 60_000 });
    const keep = deliver(ports.gmail);
    const queue = queueOf([item(t), item(keep)]);
    const out = unwrap(screen(ports, config(), queue).result);
    expect(ids(out.queue)).toEqual([keep]);
    expect(out.kept.map((k) => k.item.threadId)).toEqual([keep]);
    expect(ports.log.all('thread.excluded').map((e) => e.fields['threadId'])).toEqual([t]);
  });

  it('excludes a thread whose only match is in Trash', () => {
    const ports = setup();
    const t = deliver(ports.gmail, { labelIds: ['INBOX'] });
    deliver(ports.gmail, {
      threadId: t,
      at: NOW - 2 * DAY_MS,
      matches: true,
      labelIds: ['TRASH'],
    });
    const out = unwrap(screen(ports, config(), queueOf([item(t)])).result);
    expect(out.queue).toEqual([]);
    expect(out.kept).toEqual([]);
    expect(out.counts.excluded).toBe(1);
  });

  it('searches with the query built over the remaining threads only', () => {
    const ports = setup();
    // The skipped thread's old message must not widen the window.
    const skipped = deliver(ports.gmail, { at: OLD, labelIds: ['DRAFT'] });
    const live = deliver(ports.gmail);
    const queue = queueOf([item(skipped), item(live)]);
    const { result } = screen(ports, config(), queue);
    const out = unwrap(result);
    expect(out.kept).toHaveLength(1);
    expect(out.counts.searchCalls).toBe(1);
    expect(ports.gmail.searches).toEqual([
      buildExclusionQuery(
        EXCLUDE_QUERY,
        out.kept.map((k) => k.thread),
        ports.clock.now(),
      ),
    ]);
    const query = ports.gmail.searches[0] ?? '';
    expect(Number(/after:(\d+)/.exec(query)?.[1])).toBeGreaterThan(OLD / 1000 + 20 * 86_400);
  });

  it('makes no search without excludeQuery, and keeps every thread not skipped', () => {
    const ports = setup();
    const a = deliver(ports.gmail, { matches: true });
    const b = deliver(ports.gmail);
    const { result, calls } = screen(ports, config(null), queueOf([item(a), item(b)]));
    const out = unwrap(result);
    expect(calls.map((c) => c.method)).toEqual(['getThread', 'getThread']);
    expect(out.kept.map((k) => k.item.threadId)).toEqual([a, b]);
    expect(out.counts.searchCalls).toBe(0);
    expect(ports.gmail.searches).toEqual([]);
  });

  it('makes no search when every thread is skipped', () => {
    const ports = setup();
    const draft = deliver(ports.gmail, { labelIds: ['DRAFT'] });
    const out = unwrap(screen(ports, config(), queueOf([item(draft), item('gone')])).result);
    expect(ports.gmail.searches).toEqual([]);
    expect(out.queue).toEqual([]);
    expect(out.kept).toEqual([]);
  });

  it('treats a thread whose own search is capped as excluded, and logs it at warn', () => {
    const ports = setup({ gmail: { maxSearchPageSize: 1 } });
    // 25 matching threads outside the chunk fill every page of the chunk's window.
    for (let i = 0; i < 25; i++) deliver(ports.gmail, { at: OLD + DAY_MS, matches: true });
    const o = deliver(ports.gmail, { at: OLD });
    const out = unwrap(screen(ports, config(), queueOf([item(o)])).result);
    expect(out.queue).toEqual([]);
    expect(out.counts).toMatchObject({ excluded: 1, searchCapped: 1, kept: 0 });
    expect(ports.log.events).toEqual([
      {
        level: 'warn',
        event: 'thread.excluded',
        fields: { threadId: o, source: 'scheduled', reason: 'search_capped' },
      },
    ]);
  });
});

describe('screenChunk: manual items', () => {
  it('screens manual items like scheduled ones, with source only in the log', () => {
    const ports = setup();
    const hit = deliver(ports.gmail, { matches: true });
    const clean = deliver(ports.gmail);
    const draft = deliver(ports.gmail, { labelIds: ['DRAFT'] });
    const manual = { source: 'manual', firstClassification: false, applyMoves: true } as const;
    const queue = queueOf([
      item(hit, { ...manual }),
      item(clean, { ...manual }),
      item(draft, { ...manual }),
    ]);
    const { result, calls } = screen(ports, config(), queue);
    const out = unwrap(result);
    expect(calls.filter((c) => c.method === 'getThread')).toHaveLength(3);
    expect(out.kept.map((k) => k.item)).toEqual([expect.objectContaining({ threadId: clean })]);
    expect(out.kept[0]?.item).toMatchObject({ source: 'manual', firstClassification: false });
    expect(out.queue.map((i) => i.threadId)).toEqual([clean]);
    expect(ports.log.all('thread.excluded').map((e) => e.fields)).toEqual([
      { threadId: hit, source: 'manual', reason: 'matched' },
    ]);
    expect(ports.log.all('thread.skipped').map((e) => e.fields)).toEqual([
      { threadId: draft, source: 'manual', reason: 'no_messages' },
    ]);
  });
});

describe('screenChunk: skips', () => {
  it('skips a thread deleted since it was queued (not_found)', () => {
    const ports = setup();
    const live = deliver(ports.gmail);
    const out = unwrap(screen(ports, config(), queueOf([item('gone'), item(live)])).result);
    expect(ids(out.queue)).toEqual([live]);
    expect(ports.log.all('thread.skipped')).toEqual([
      {
        level: 'info',
        event: 'thread.skipped',
        fields: { threadId: 'gone', source: 'scheduled', reason: 'not_found' },
      },
    ]);
    expect(out.counts.skippedNotFound).toBe(1);
  });

  it('skips a thread where any message carries a remembered Jev/Error ID, including an older one', () => {
    const ports = setup();
    rememberJevErrorLabelId(ports.state, 'Label_1');
    rememberJevErrorLabelId(ports.state, 'Label_2');
    // The label is on the first message only: the newer one didn't inherit it.
    const newest = deliver(ports.gmail, { labelIds: ['Label_1'] });
    deliver(ports.gmail, { threadId: newest });
    const older = deliver(ports.gmail, { labelIds: ['INBOX', 'Label_2'] });
    const clean = deliver(ports.gmail, { labelIds: ['Label_9'] });
    const queue = queueOf([item(newest), item(older), item(clean)]);
    const out = unwrap(screen(ports, config(), queue).result);
    expect(ids(out.queue)).toEqual([clean]);
    expect(ports.log.all('thread.skipped').map((e) => e.fields)).toEqual([
      { threadId: newest, source: 'scheduled', reason: 'jev_error' },
      { threadId: older, source: 'scheduled', reason: 'jev_error' },
    ]);
    expect(out.counts.skippedJevError).toBe(2);
  });

  it('skips nothing as jev_error when state.jevErrorLabel is absent', () => {
    const ports = setup();
    const t = deliver(ports.gmail, { labelIds: ['Label_1'] });
    const out = unwrap(screen(ports, config(), queueOf([item(t)])).result);
    expect(ids(out.queue)).toEqual([t]);
    expect(ports.log.all('thread.skipped')).toEqual([]);
  });

  it('propagates a StateError from an unreadable state.jevErrorLabel, before any Gmail call', () => {
    const ports = setup();
    ports.state.seedRaw(JEV_ERROR_LABEL_KEY, '{"v":1,"ids":"nope"}');
    const t = deliver(ports.gmail);
    const queue = queueOf([item(t)]);
    const callsBefore = ports.gmail.calls.length;
    expect(() => screenChunk(ports, config(), queue, takeChunk(queue, 1))).toThrow(StateError);
    expect(ports.gmail.calls).toHaveLength(callsBefore);
  });

  it.each(['DRAFT', 'SPAM', 'TRASH'])(
    'skips a thread whose only message is labelled %s (no_messages)',
    (label) => {
      const ports = setup();
      const t = deliver(ports.gmail, { labelIds: [label] });
      const out = unwrap(screen(ports, config(), queueOf([item(t)])).result);
      expect(out.queue).toEqual([]);
      expect(ports.log.all('thread.skipped').map((e) => e.fields['reason'])).toEqual([
        'no_messages',
      ]);
    },
  );

  it('skips a thread whose messages are all DRAFT, SPAM or TRASH', () => {
    const ports = setup();
    const t = deliver(ports.gmail, { labelIds: ['DRAFT'] });
    deliver(ports.gmail, { threadId: t, labelIds: ['TRASH'] });
    deliver(ports.gmail, { threadId: t, labelIds: ['SPAM'] });
    const out = unwrap(screen(ports, config(), queueOf([item(t)])).result);
    expect(out.queue).toEqual([]);
    expect(out.counts.skippedNoMessages).toBe(1);
  });

  it('skips a thread with no message at all, and never sends it to the search', () => {
    const ports = setup();
    ports.gmail.addThread({ id: 'empty', messages: [] });
    const live = deliver(ports.gmail);
    const { result, calls } = screen(ports, config(), queueOf([item('empty'), item(live)]));
    const out = unwrap(result);
    expect(ids(out.queue)).toEqual([live]);
    expect(out.counts.skippedNoMessages).toBe(1);
    expect(calls.map((c) => c.method)).toContain('searchThreadIds');
  });

  it('keeps a thread with one INBOX message among trashed ones', () => {
    const ports = setup();
    const t = deliver(ports.gmail, { labelIds: ['TRASH'] });
    deliver(ports.gmail, { threadId: t, labelIds: ['INBOX'] });
    deliver(ports.gmail, { threadId: t, labelIds: ['DRAFT'] });
    const out = unwrap(screen(ports, config(), queueOf([item(t)])).result);
    expect(ids(out.queue)).toEqual([t]);
    expect(out.kept).toHaveLength(1);
  });

  it('checks the skips in order: not_found, then jev_error, then no_messages', () => {
    const ports = setup();
    rememberJevErrorLabelId(ports.state, 'Label_1');
    const both = deliver(ports.gmail, { labelIds: ['DRAFT', 'Label_1'] });
    unwrap(screen(ports, config(), queueOf([item(both)])).result);
    expect(ports.log.all('thread.skipped').map((e) => e.fields['reason'])).toEqual(['jev_error']);
  });
});

describe('screenChunk: what is logged and returned', () => {
  it('logs exactly threadId, source and reason, and never a subject or sender', () => {
    const ports = setup();
    const hit = deliver(ports.gmail, { matches: true });
    const draft = deliver(ports.gmail, { labelIds: ['DRAFT'] });
    unwrap(screen(ports, config(), queueOf([item(hit), item(draft), item('gone')])).result);
    for (const event of ports.log.events) {
      expect(Object.keys(event.fields).sort()).toEqual(['reason', 'source', 'threadId']);
    }
    expect(ports.log.events.map((e) => [e.event, e.level, e.fields['reason']])).toEqual([
      ['thread.skipped', 'info', 'no_messages'],
      ['thread.skipped', 'info', 'not_found'],
      ['thread.excluded', 'info', 'matched'],
    ]);
    expect(JSON.stringify(ports.log.events)).not.toMatch(/subject|friend@|bank@/);
  });

  it('marks nothing and writes no state', () => {
    const ports = setup();
    rememberJevErrorLabelId(ports.state, 'Label_1');
    const hit = deliver(ports.gmail, { matches: true });
    const draft = deliver(ports.gmail, { labelIds: ['DRAFT'] });
    const ok1 = deliver(ports.gmail);
    const before = ports.state.snapshot();
    const { calls } = screen(ports, config(), queueOf([item(hit), item(draft), item(ok1)]));
    expect(calls.map((c) => c.method)).not.toContain('modifyThread');
    expect(calls.map((c) => c.method)).not.toContain('createLabel');
    expect(ports.state.snapshot()).toEqual(before);
  });

  it('counts a mixed chunk', () => {
    const ports = setup();
    rememberJevErrorLabelId(ports.state, 'Label_1');
    const jevError = deliver(ports.gmail, { labelIds: ['Label_1'] });
    const draft = deliver(ports.gmail, { labelIds: ['DRAFT'] });
    const hit1 = deliver(ports.gmail, { matches: true });
    const hit2 = deliver(ports.gmail, { matches: true });
    const clean1 = deliver(ports.gmail);
    const clean2 = deliver(ports.gmail);
    const queue = queueOf([
      item('gone'),
      item(jevError),
      item(draft),
      item(hit1),
      item(hit2),
      item(clean1),
      item(clean2),
    ]);
    const out = unwrap(screen(ports, config(), queue).result);
    const expected: ScreenCounts = {
      read: 7,
      skippedNotFound: 1,
      skippedJevError: 1,
      skippedNoMessages: 1,
      excluded: 2,
      searchCapped: 0,
      kept: 2,
      searchCalls: 1,
    };
    expect(out.counts).toEqual(expected);
    expect(ids(out.queue)).toEqual([clean1, clean2]);
    expect(out.kept.map((k) => k.item.threadId)).toEqual([clean1, clean2]);
    expect(out.kept.map((k) => k.thread.id)).toEqual([clean1, clean2]);
  });

  it('leaves the input queue untouched', () => {
    const ports = setup();
    const t = deliver(ports.gmail, { matches: true });
    const queue = queueOf([item(t)]);
    const copy = structuredClone(queue);
    unwrap(screen(ports, config(), queue).result);
    expect(queue).toEqual(copy);
  });
});

describe('screenChunk: first classification', () => {
  it('sets true for a new thread and false for a replied-to one, in the queue and in kept', () => {
    const ports = setup();
    const fresh = deliver(ports.gmail, { at: SAVED_AT + 60_000 });
    const replied = deliver(ports.gmail, { at: OLD });
    deliver(ports.gmail, { threadId: replied, at: SAVED_AT + 60_000 });
    const queue = queueOf([item(fresh), item(replied)]);
    const out = unwrap(screen(ports, config(), queue).result);
    const flag = (id: string, list: readonly WorkItem[]) =>
      list.find((i) => i.threadId === id)?.firstClassification;
    expect(flag(fresh, out.queue)).toBe(true);
    expect(flag(replied, out.queue)).toBe(false);
    expect(
      flag(
        fresh,
        out.kept.map((k) => k.item),
      ),
    ).toBe(true);
    expect(
      flag(
        replied,
        out.kept.map((k) => k.item),
      ),
    ).toBe(false);
  });

  it('leaves a flag that is already set alone, even when the thread now says otherwise', () => {
    const ports = setup();
    const fresh = deliver(ports.gmail, { at: SAVED_AT + 60_000 });
    const old = deliver(ports.gmail, { at: OLD });
    const queue = queueOf([
      item(fresh, { firstClassification: false }),
      item(old, { firstClassification: true }),
    ]);
    const out = unwrap(screen(ports, config(), queue).result);
    expect(out.queue).toEqual(queue);
    expect(out.kept.map((k) => [k.item.threadId, k.item.firstClassification])).toEqual([
      [fresh, false],
      [old, true],
    ]);
  });

  it('keeps the flag when the returned queue is screened again (a retry)', () => {
    const ports = setup();
    const t = deliver(ports.gmail, { at: SAVED_AT + 60_000 });
    const first = unwrap(screen(ports, config(), queueOf([item(t)])).result);
    expect(first.queue[0]?.firstClassification).toBe(true);
    // The thread now has an older look: a message from before the position appears.
    deliver(ports.gmail, { threadId: t, at: OLD });
    const again = unwrap(screen(ports, config(), first.queue).result);
    expect(again.queue).toEqual(first.queue);
    expect(again.kept[0]?.item.firstClassification).toBe(true);
  });

  it('does not decide a flag for a skipped or excluded thread', () => {
    const ports = setup();
    const hit = deliver(ports.gmail, { matches: true });
    const out = unwrap(screen(ports, config(), queueOf([item(hit), item('gone')])).result);
    expect(out.queue).toEqual([]);
  });
});

describe('screenChunk: failing closed', () => {
  function chunkOfFour(ports: FakePorts) {
    const a = deliver(ports.gmail, { matches: true });
    const b = deliver(ports.gmail);
    const c = deliver(ports.gmail);
    const d = deliver(ports.gmail, { labelIds: ['DRAFT'] });
    return { ids: [a, b, c, d], queue: queueOf([item(a), item(b), item(c), item(d)]) };
  }

  it('returns rate_limited from a metadata read at once: no later call, no log, no queue', () => {
    const ports = setup();
    const { ids: threadIds, queue } = chunkOfFour(ports);
    ports.gmail.failNext('getThread', FakeGmail.rateLimited(), { threadId: threadIds[1] ?? '' });
    const copy = structuredClone(queue);
    const { result, calls } = screen(ports, config(), queue);
    expect(result).toMatchObject({ ok: false, kind: 'rate_limited' });
    expect(result).not.toHaveProperty('queue');
    expect(calls.map((c) => [c.method, c.args[0]])).toEqual([
      ['getThread', threadIds[0]],
      ['getThread', threadIds[1]],
    ]);
    expect(ports.log.events).toEqual([]);
    expect(queue).toEqual(copy);
  });

  it('returns rate_limited from the search: nothing logged, input queue unchanged', () => {
    const ports = setup();
    const { queue } = chunkOfFour(ports);
    ports.gmail.failNext('searchThreadIds', FakeGmail.rateLimited());
    const copy = structuredClone(queue);
    const { result, calls } = screen(ports, config(), queue);
    expect(result).toMatchObject({ ok: false, kind: 'rate_limited' });
    expect(result).not.toHaveProperty('queue');
    expect(calls.filter((c) => c.method === 'searchThreadIds')).toHaveLength(1);
    expect(ports.log.events).toEqual([]);
    expect(queue).toEqual(copy);
  });

  it('also fails the check closed on a later search page failing', () => {
    const ports = setup({ gmail: { maxSearchPageSize: 1 } });
    for (let i = 0; i < 3; i++) deliver(ports.gmail, { matches: true });
    const t = deliver(ports.gmail);
    ports.gmail.failNext('searchThreadIds', FakeGmail.rateLimited(), { after: 1 });
    const { result, calls } = screen(ports, config(), queueOf([item(t)]));
    expect(result).toMatchObject({ ok: false, kind: 'rate_limited' });
    expect(calls.filter((c) => c.method === 'searchThreadIds')).toHaveLength(2);
    expect(ports.log.events).toEqual([]);
  });

  it('returns scope when gmail.modify is revoked', () => {
    const ports = setup();
    const { queue } = chunkOfFour(ports);
    ports.scopes.revoke(GMAIL_MODIFY);
    const { result, calls } = screen(ports, config(), queue);
    expect(result).toMatchObject({ ok: false, kind: 'scope' });
    expect(calls.map((c) => c.method)).toEqual(['getThread']);
    expect(ports.log.events).toEqual([]);
  });

  it('propagates an unrecognized Gmail error', () => {
    const ports = setup();
    const { ids: threadIds, queue } = chunkOfFour(ports);
    ports.gmail.failNext('getThread', new Error('boom'), { threadId: threadIds[0] ?? '' });
    expect(() => screenChunk(ports, config(), queue, takeChunk(queue, 4))).toThrow('boom');
    expect(ports.log.events).toEqual([]);
  });

  it('screens the whole chunk again cleanly after a failed call', () => {
    const ports = setup();
    const { ids: threadIds, queue } = chunkOfFour(ports);
    ports.gmail.failNext('searchThreadIds', FakeGmail.rateLimited());
    expect(screen(ports, config(), queue).result.ok).toBe(false);
    expect(ports.log.events).toEqual([]);
    const out = unwrap(screen(ports, config(), queue).result);
    expect(out.kept.map((k) => k.item.threadId)).toEqual([threadIds[1], threadIds[2]]);
    expect(ids(out.queue)).toEqual([threadIds[1], threadIds[2]]);
  });
});
