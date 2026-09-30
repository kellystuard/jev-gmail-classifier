import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { rememberJevErrorLabelId } from '../../src/app/jev-error-label-store.ts';
import { createLabelCache } from '../../src/app/label-cache.ts';
import { type ChunkDeps, type ChunkResult, processChunk } from '../../src/app/process-chunk.ts';
import { loadQueue, saveQueue } from '../../src/app/queue-store.ts';
import { loadConfig } from '../../src/config/loader.ts';
import type { Config } from '../../src/config/schema.ts';
import {
  InvalidArgumentError,
  RunAbortError,
  StateError,
  UnexpectedResponseError,
} from '../../src/core/errors.ts';
import { JEV_ERROR_LABEL } from '../../src/core/label-path.ts';
import { SCOPE_FEATURES } from '../../src/core/scope-features.ts';
import { BUDGET_KEY, encodeBudget } from '../../src/core/token-budget.ts';
import { enqueue, type WorkItem, type WorkQueue } from '../../src/core/work-queue.ts';
import type { HttpRequest } from '../../src/ports/http-port.ts';
import { FakeGmail } from '../fakes/fake-gmail.ts';
import { type FakeHttpResponse, jsonPayload } from '../fakes/fake-http.ts';
import { createFakePorts, type FakePorts } from '../fakes/fake-ports.ts';
import { nodeDecodeUtf8 } from '../fakes/node-utf8.ts';
import ok200 from '../fixtures/jev/200-four-rules.json' with { type: 'json' };
import unknownModel400 from '../fixtures/jev/400-unknown-model.json' with { type: 'json' };
import wrongKey401 from '../fixtures/jev/401-wrong-key.json' with { type: 'json' };
import invalid422 from '../fixtures/jev/422-empty-questions.json' with { type: 'json' };

const GMAIL_MODIFY = 'https://www.googleapis.com/auth/gmail.modify';
const EXTERNAL_REQUEST = 'https://www.googleapis.com/auth/script.external_request';
/** `scope_missing`'s `feature` and `disables`, as the scope preflight logs them. */
const GMAIL_FEATURE = SCOPE_FEATURES[GMAIL_MODIFY];
const CLASSIFY_FEATURE = SCOPE_FEATURES[EXTERNAL_REQUEST];
/** `createFakePorts()`'s default clock. */
const NOW = Date.parse('2026-09-26T12:00:00Z');
const HOUR_MS = 3_600_000;
const EXCLUDE_QUERY = 'from:bank@example.com';
const NEWS = 'News';
const BUDGET = 1_000_000;
/** `usage.input_tokens` in the 200 fixture. */
const FIXTURE_TOKENS = 580;

/**
 * The four rules of `200-four-rules.json`: in it only `newsletter` fires
 * (0.93), so the fixture answer adds `News` and moves nothing. `shipping` is
 * the move rule, answered by `answers()`.
 */
function config(extra: { excludeQuery?: string; dailyTokenBudget?: number } = {}): Config {
  return loadConfig({
    defaultThreshold: 0.8,
    triggerIntervalMinutes: 10,
    dailyTokenBudget: extra.dailyTokenBudget ?? BUDGET,
    ...(extra.excludeQuery === undefined ? {} : { excludeQuery: extra.excludeQuery }),
    rules: [
      { id: 'approval', question: 'Does it ask for approval?', label: 'Approval' },
      { id: 'bill', question: 'Is it a bill?', label: 'Finance/Bill' },
      { id: 'newsletter', question: 'Is it a newsletter?', label: NEWS },
      {
        id: 'shipping',
        question: 'Is it a shipping notice?',
        action: 'move',
        destination: 'archive',
      },
    ],
  });
}

/** A 200 answering every rule; `shipping` fires (the thread is archived) when `ship` is set. */
function answers(options: { ship?: boolean; tokens?: number } = {}): FakeHttpResponse {
  const p = (value: number) => ({ type: 'noul', noul: value });
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'jev-1.13.0',
      answers: {
        approval: p(0.01),
        bill: p(0.01),
        newsletter: p(0.1),
        shipping: p(options.ship === true ? 0.99 : 0.01),
      },
      usage: { input_tokens: options.tokens ?? 100 },
    }),
  };
}

const r429: FakeHttpResponse = { status: 429, headers: {}, body: '' };

type Setup = {
  readonly ports: FakePorts;
  readonly deps: ChunkDeps;
  readonly ids: readonly string[];
  readonly queue: WorkQueue;
};

type SetupOptions = {
  readonly threads?: number;
  readonly config?: Config;
  readonly remainingMs?: number;
  readonly strikes?: number;
  readonly gmail?: (ports: FakePorts) => ChunkDeps['gmail'];
};

/**
 * `threads` delivered threads (default 3), each with subject `mail <i>`, a
 * queue holding them in that order (first classification, so moves apply),
 * and the chunk's deps.
 */
function setup(options: SetupOptions = {}): Setup {
  const ports = createFakePorts();
  const ids: string[] = [];
  for (let i = 0; i < (options.threads ?? 3); i++) {
    ids.push(deliver(ports.gmail, `mail ${String(i)}`));
  }
  const gmail = options.gmail?.(ports) ?? ports.gmail;
  const deps: ChunkDeps = {
    config: options.config ?? config(),
    gmail,
    http: ports.http,
    state: ports.state,
    log: ports.log,
    clock: ports.clock,
    random: ports.random,
    labels: createLabelCache({ gmail, log: ports.log }),
    decodeUtf8: nodeDecodeUtf8,
    apiKey: 'test-key',
    remainingMs: () => options.remainingMs ?? 60_000,
  };
  return { ports, deps, ids, queue: queueOf(ids, options.strikes ?? 0) };
}

function deliver(gmail: FakeGmail, subject: string, from = 'friend@example.com'): string {
  return gmail.deliver({
    internalDate: NOW - 10 * 60_000,
    headers: [
      { name: 'From', value: from },
      { name: 'Subject', value: subject },
    ],
    bodyText: `the private body of ${subject}`,
  }).threadId;
}

function queueOf(ids: readonly string[], strikes: number): WorkQueue {
  let queue: WorkQueue = [];
  ids.forEach((threadId, i) => {
    const added = enqueue(queue, {
      threadId,
      source: 'scheduled',
      enqueuedAt: NOW - HOUR_MS + i,
      positionSavedAt: NOW - HOUR_MS,
      firstClassification: true,
    });
    if (!added.ok) throw new Error('setup: enqueue failed');
    queue = added.queue;
  });
  return queue.map((item) => ({ ...item, strikes }));
}

const payloadSchema = z.object({ state: z.array(z.object({ subject: z.string() })) });

function subjectOf(request: HttpRequest): string {
  return payloadSchema.parse(jsonPayload(request)).state[0]?.subject ?? '';
}

/** Answers the request for thread `i` (subject `mail <i>`). */
function respondTo(s: Setup, i: number, responses: readonly FakeHttpResponse[]): void {
  s.ports.http.respond((request) => subjectOf(request) === `mail ${String(i)}`, responses);
}

/** Answers every request not routed otherwise. Add it last. */
function respondRest(s: Setup, responses: readonly FakeHttpResponse[]): void {
  s.ports.http.respond(() => true, responses);
}

function run(s: Setup, chunk: readonly WorkItem[] = s.queue): ChunkResult {
  return processChunk(chunk, s.queue, s.deps);
}

/** How many times the queue was saved (each save lists the shards once). */
function queueSaves(s: Setup): number {
  return s.ports.state.calls.filter((c) => c.method === 'keys' && c.args[0] === 'state.queue.')
    .length;
}

function queueWrites(s: Setup): number {
  return s.ports.state.calls.filter(
    (c) =>
      (c.method === 'set' || c.method === 'delete') && String(c.args[0]).startsWith('state.queue.'),
  ).length;
}

function labelId(gmail: FakeGmail, name: string): string | undefined {
  const listed = gmail.listLabels();
  return listed.ok ? listed.labels.find((l) => l.name === name)?.id : undefined;
}

function fullReads(s: Setup): number {
  return s.ports.gmail.calls.filter(
    (c) => c.method === 'getThread' && JSON.stringify(c.args[1]) === '{"format":"full"}',
  ).length;
}

function modifiedThreads(s: Setup): unknown[] {
  return s.ports.gmail.calls.filter((c) => c.method === 'modifyThread').map((c) => c.args[0]);
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

function at<T>(list: readonly T[], i: number): T {
  const value = list[i];
  if (value === undefined) throw new Error(`no element ${String(i)}`);
  return value;
}

describe('processChunk: the happy path', () => {
  it('screens, reads, sends once, settles each thread and saves the queue once', () => {
    const s = setup();
    saveQueue(s.ports.state, s.queue);
    const before = s.ports.state.calls.length;
    respondTo(s, 1, [answers({ ship: true, tokens: 200 })]);
    respondRest(s, [ok200]);

    const result = run(s);

    expect(s.ports.http.batches).toHaveLength(1);
    expect(at(s.ports.http.batches, 0)).toHaveLength(3);
    expect(result.counts).toEqual({ screened: 3, skipped: 0, excluded: 0, sent: 3 });
    expect(result.settlements).toEqual([
      {
        threadId: s.ids[0],
        source: 'scheduled',
        outcome: 'classified',
        applied: { labels: [NEWS] },
      },
      {
        threadId: s.ids[1],
        source: 'scheduled',
        outcome: 'classified',
        applied: { labels: [], move: { kind: 'archive' } },
      },
      {
        threadId: s.ids[2],
        source: 'scheduled',
        outcome: 'classified',
        applied: { labels: [NEWS] },
      },
    ]);
    expect(result.queue).toEqual([]);
    expect(result.inputTokens).toBe(2 * FIXTURE_TOKENS + 200);
    expect(result.alerts).toEqual([]);
    expect(result.erroredThreadIds).toEqual([]);
    expect(result.missingScopes).toEqual([]);
    expect(result).not.toHaveProperty('abort');
    expect(result).not.toHaveProperty('stopGmail');
    expect(result).not.toHaveProperty('stopSending');

    const news = labelId(s.ports.gmail, NEWS);
    expect(s.ports.gmail.threadLabels(at(s.ids, 0))[0]).toContain(news);
    expect(s.ports.gmail.threadLabels(at(s.ids, 2))[0]).toContain(news);
    expect(s.ports.gmail.threadLabels(at(s.ids, 1))[0]).not.toContain('INBOX');

    const saves = s.ports.state.calls
      .slice(before)
      .filter((c) => c.method === 'keys' && c.args[0] === 'state.queue.');
    expect(saves).toHaveLength(1);
    expect(loadQueue(s.ports.state)).toEqual([]);
    expect(s.ports.log.all('thread.classified')).toHaveLength(3);
    expect(s.ports.log.find('thread.classified')?.fields).toMatchObject({
      subject: 'mail 0',
      from: 'friend@example.com',
    });
  });

  it('logs nothing of its own on the happy path', () => {
    const s = setup();
    respondRest(s, [ok200]);
    run(s);
    const own = s.ports.log.events.filter(
      (e) => e.event === 'scope_missing' || e.event === 'thread.skipped',
    );
    expect(own).toEqual([]);
  });
});

describe('processChunk: screening fails', () => {
  it.each<[string, (s: Setup) => void, Partial<ChunkResult>]>([
    [
      'rate_limited',
      (s) => {
        s.ports.gmail.failNext('getThread', FakeGmail.rateLimited());
      },
      { alerts: [], missingScopes: [], stopGmail: 'rate_limited' },
    ],
    [
      'scope',
      (s) => {
        s.ports.scopes.revoke(GMAIL_MODIFY);
      },
      { alerts: ['scope_missing'], missingScopes: [GMAIL_MODIFY], stopGmail: 'scope' },
    ],
  ])('%s: the input queue, nothing saved, nothing sent', (name, arrange, expected) => {
    const s = setup();
    arrange(s);
    const result = run(s);
    expect(result).toEqual({
      queue: s.queue,
      counts: { screened: 0, skipped: 0, excluded: 0, sent: 0 },
      erroredThreadIds: [],
      settlements: [],
      inputTokens: 0,
      ...expected,
    });
    expect(result.queue).toBe(s.queue);
    expect(queueSaves(s)).toBe(0);
    expect(s.ports.http.calls).toEqual([]);
    const logged = s.ports.log.all('scope_missing');
    if (name === 'scope') {
      expect(logged.map((e) => [e.level, e.fields])).toEqual([
        ['warn', { scope: GMAIL_MODIFY, step: 'screen', ...GMAIL_FEATURE }],
      ]);
    } else {
      expect(logged).toEqual([]);
    }
  });
});

describe('processChunk: screening skips and excludes', () => {
  it('counts a Jev/Error thread as skipped and an excluded one as excluded, and sends neither', () => {
    const s = setup({ threads: 1, config: config({ excludeQuery: EXCLUDE_QUERY }) });
    const errored = s.ports.gmail.deliver({ labelIds: ['INBOX', 'Label_9'] }).threadId;
    const excluded = deliver(s.ports.gmail, 'from the bank', 'bank@example.com');
    rememberJevErrorLabelId(s.ports.state, 'Label_9');
    s.ports.gmail.setSearchMatcher(
      (_q, message) =>
        message.payload?.headers?.some(
          (h) => h.name === 'From' && h.value === 'bank@example.com',
        ) === true,
    );
    respondRest(s, [ok200]);
    const queue = [...s.queue, ...queueOf([errored, excluded], 0)];

    const result = processChunk(queue, queue, s.deps);

    expect(result.counts).toEqual({ screened: 3, skipped: 1, excluded: 1, sent: 1 });
    expect(at(s.ports.http.batches, 0)).toHaveLength(1);
    expect(result.settlements.map((x) => [x.threadId, x.outcome])).toEqual([
      [s.ids[0], 'classified'],
    ]);
    expect(result.queue).toEqual([]);
    expect(queueSaves(s)).toBe(1);
  });
});

describe('processChunk: the full read', () => {
  it('not_found for one of three: two sent, one thread.skipped', () => {
    const s = setup();
    s.ports.gmail.failNext(
      'getThread',
      { ok: false, kind: 'not_found' },
      {
        threadId: at(s.ids, 1),
        after: 1,
      },
    );
    respondRest(s, [ok200]);

    const result = run(s);

    expect(at(s.ports.http.batches, 0)).toHaveLength(2);
    expect(result.counts).toEqual({ screened: 3, skipped: 1, excluded: 0, sent: 2 });
    expect(result.settlements.map((x) => x.threadId)).toEqual([s.ids[0], s.ids[2]]);
    expect(result.queue).toEqual([]);
    expect(s.ports.log.all('thread.skipped').map((e) => [e.level, e.fields])).toEqual([
      ['info', { threadId: s.ids[1], source: 'scheduled', reason: 'not_found' }],
    ]);
  });

  it.each<['rate_limited' | 'scope', (s: Setup) => void]>([
    [
      'rate_limited',
      (s) => {
        s.ports.gmail.failNext('getThread', FakeGmail.rateLimited(), {
          threadId: at(s.ids, 1),
          after: 1,
        });
      },
    ],
    [
      'scope',
      (s) => {
        s.ports.gmail.failNext(
          'getThread',
          { ok: false, kind: 'scope', message: 'Insufficient Permission' },
          { threadId: at(s.ids, 1), after: 1 },
        );
      },
    ],
  ])('%s on the second full read: nothing sent, the screened queue saved', (kind, arrange) => {
    const s = setup();
    arrange(s);
    respondRest(s, [ok200]);

    const result = run(s);

    expect(s.ports.http.calls).toEqual([]);
    expect(fullReads(s)).toBe(2);
    expect(result.stopGmail).toBe(kind);
    expect(result.counts.sent).toBe(0);
    expect(result.settlements).toEqual([]);
    expect(result.queue).toEqual(s.queue);
    expect(result.queue.map((i) => i.strikes)).toEqual([0, 0, 0]);
    expect(queueSaves(s)).toBe(1);
    expect(loadQueue(s.ports.state)).toEqual(s.queue);
    if (kind === 'scope') {
      expect(result.alerts).toEqual(['scope_missing']);
      expect(result.missingScopes).toEqual([GMAIL_MODIFY]);
      expect(s.ports.log.all('scope_missing').map((e) => e.fields)).toEqual([
        { scope: GMAIL_MODIFY, step: 'read', ...GMAIL_FEATURE },
      ]);
    } else {
      expect(result.alerts).toEqual([]);
      expect(s.ports.log.all('scope_missing')).toEqual([]);
    }
  });

  it('an empty state (every message moved to Trash since screening): skipped, dequeued, not sent', () => {
    const s = setup();
    const target = at(s.ids, 0);
    s.ports.gmail.onCall = (method, args) => {
      if (
        method === 'getThread' &&
        args[0] === target &&
        JSON.stringify(args[1]) === '{"format":"full"}'
      ) {
        s.ports.gmail.onCall = undefined;
        s.ports.gmail.modifyThread(target, { addLabelIds: ['TRASH'], removeLabelIds: ['INBOX'] });
      }
    };
    respondRest(s, [ok200]);

    const result = run(s);

    expect(at(s.ports.http.batches, 0)).toHaveLength(2);
    expect(result.counts).toMatchObject({ skipped: 1, sent: 2 });
    expect(result.settlements.map((x) => x.threadId)).toEqual([s.ids[1], s.ids[2]]);
    expect(result.queue).toEqual([]);
    expect(s.ports.log.all('thread.skipped').map((e) => e.fields)).toEqual([
      { threadId: target, source: 'scheduled', reason: 'no_messages' },
    ]);
  });
});

describe('processChunk: an exception while reading or building', () => {
  it('is one strike for that thread; the others are sent and classified', () => {
    const s = setup();
    s.ports.gmail.failNext('getThread', new TypeError('x is not a function'), {
      threadId: at(s.ids, 0),
      after: 1,
    });
    s.ports.gmail.failNext(
      'getThread',
      new UnexpectedResponseError('Gmail said no', { service: 'gmail', reason: 'unrecognized' }),
      { threadId: at(s.ids, 2), after: 1 },
    );
    respondRest(s, [ok200]);

    const result = run(s);

    expect(at(s.ports.http.batches, 0)).toHaveLength(1);
    expect(result.counts.sent).toBe(1);
    expect(result.settlements).toEqual([
      { threadId: s.ids[0], source: 'scheduled', outcome: 'struck', strikes: 1 },
      { threadId: s.ids[2], source: 'scheduled', outcome: 'struck', strikes: 1 },
      {
        threadId: s.ids[1],
        source: 'scheduled',
        outcome: 'classified',
        applied: { labels: [NEWS] },
      },
    ]);
    expect(result.queue.map((i) => [i.threadId, i.strikes])).toEqual([
      [s.ids[0], 1],
      [s.ids[2], 1],
    ]);
    expect(loadQueue(s.ports.state)).toEqual(result.queue);
    const failed = s.ports.log.all('thread.failed');
    expect(failed.map((e) => [e.fields['threadId'], e.fields['reason']])).toEqual([
      [s.ids[0], 'TypeError'],
      [s.ids[2], 'UnexpectedResponseError'],
    ]);
    for (const event of failed) {
      expect(event.fields).not.toHaveProperty('subject');
      expect(event.fields).not.toHaveProperty('from');
    }
  });

  it('the third strike gives errored and Jev/Error', () => {
    const s = setup({ threads: 1, strikes: 2 });
    s.ports.gmail.failNext('getThread', new TypeError('bad'), { after: 1 });

    const result = run(s);

    expect(s.ports.http.calls).toEqual([]);
    expect(result.settlements).toEqual([
      { threadId: s.ids[0], source: 'scheduled', outcome: 'errored', strikes: 3 },
    ]);
    expect(result.erroredThreadIds).toEqual([s.ids[0]]);
    expect(result.alerts).toEqual(['errored']);
    expect(result.queue).toEqual([]);
    expect(s.ports.gmail.threadLabels(at(s.ids, 0))[0]).toContain(
      labelId(s.ports.gmail, JEV_ERROR_LABEL),
    );
  });

  it('a build exception from a stub GmailPort is one strike', () => {
    const s = setup({
      threads: 2,
      gmail: (ports) => ({
        getProfile: () => ports.gmail.getProfile(),
        listHistory: (request) => ports.gmail.listHistory(request),
        searchThreadIds: (request) => ports.gmail.searchThreadIds(request),
        getThread: (threadId, format) => {
          if (format.format === 'full' && threadId === 'thread-1') {
            throw new RangeError('stub');
          }
          return ports.gmail.getThread(threadId, format);
        },
        listLabels: () => ports.gmail.listLabels(),
        createLabel: (name) => ports.gmail.createLabel(name),
        modifyThread: (threadId, change) => ports.gmail.modifyThread(threadId, change),
      }),
    });
    respondRest(s, [ok200]);
    const result = run(s);
    expect(result.settlements.map((x) => [x.threadId, x.outcome])).toEqual([
      ['thread-1', 'struck'],
      ['thread-2', 'classified'],
    ]);
  });

  it.each<[string, Error]>([
    ['RunAbortError', new RunAbortError('stop', { reason: 'auth' })],
    ['StateError', new StateError('bad', { key: 'state.queue.0', reason: 'schema' })],
  ])('%s propagates', (_name, error) => {
    const s = setup();
    s.ports.gmail.failNext('getThread', error, { threadId: at(s.ids, 1), after: 1 });
    expect(thrown(() => run(s))).toBe(error);
    expect(s.ports.http.calls).toEqual([]);
  });
});

describe('processChunk: the sender stops', () => {
  it('budget: nothing answered, all untouched, budget_reached', () => {
    const s = setup();
    s.ports.state.set(BUDGET_KEY, encodeBudget({ day: '2026-09-26', inputTokens: BUDGET }));
    respondRest(s, [ok200]);

    const result = run(s);

    expect(s.ports.http.batches).toEqual([]);
    expect(result.stopSending).toBe('budget');
    expect(result.alerts).toEqual(['budget_reached']);
    expect(result.settlements.map((x) => x.outcome)).toEqual([
      'untouched',
      'untouched',
      'untouched',
    ]);
    expect(result.queue).toEqual(s.queue);
    expect(queueSaves(s)).toBe(1);
  });

  it('scope: stopSending scope, scope_missing, script.external_request, logged at send', () => {
    const s = setup();
    s.ports.scopes.revoke(EXTERNAL_REQUEST);

    const result = run(s);

    expect(result.stopSending).toBe('scope');
    expect(result.alerts).toEqual(['scope_missing']);
    expect(result.missingScopes).toEqual([EXTERNAL_REQUEST]);
    expect(result.settlements.map((x) => x.outcome)).toEqual([
      'untouched',
      'untouched',
      'untouched',
    ]);
    expect(s.ports.log.all('scope_missing').map((e) => [e.level, e.fields])).toEqual([
      ['warn', { scope: EXTERNAL_REQUEST, step: 'send', ...CLASSIFY_FEATURE }],
    ]);
    expect(result.queue).toEqual(s.queue);
    expect(queueSaves(s)).toBe(1);
  });

  it('deadline: stopSending deadline, items untouched, queue saved', () => {
    const s = setup({ remainingMs: 0 });
    respondRest(s, [ok200]);

    const result = run(s);

    expect(result.stopSending).toBe('deadline');
    expect(s.ports.http.batches).toEqual([]);
    expect(result.settlements.map((x) => x.outcome)).toEqual([
      'untouched',
      'untouched',
      'untouched',
    ]);
    expect(result.queue).toEqual(s.queue);
    expect(queueSaves(s)).toBe(1);
  });
});

describe('processChunk: abort', () => {
  it.each<[string, FakeHttpResponse, 'auth' | 'config_invalid']>([
    ['a 401', wrongKey401, 'auth'],
    ['the unknown model', unknownModel400, 'config_invalid'],
  ])('%s for one of three: the others settled, abort returned, no throw', (_n, response, abort) => {
    const s = setup();
    respondTo(s, 1, [response]);
    respondRest(s, [ok200]);

    const result = run(s);

    expect(result.abort).toBe(abort);
    expect(result.settlements.map((x) => x.outcome)).toEqual([
      'classified',
      'untouched',
      'classified',
    ]);
    expect(result.queue.map((i) => i.threadId)).toEqual([s.ids[1]]);
    expect(queueSaves(s)).toBe(1);
    expect(loadQueue(s.ports.state)).toEqual(result.queue);
  });
});

describe('processChunk: stopGmail while settling', () => {
  it('rate_limited on the first modifyThread: the later entries are not settled', () => {
    const s = setup();
    s.ports.gmail.failNext('modifyThread', FakeGmail.rateLimited());
    respondRest(s, [ok200]);

    const result = run(s);

    expect(result.stopGmail).toBe('rate_limited');
    expect(result.settlements).toEqual([
      { threadId: s.ids[0], source: 'scheduled', outcome: 'untouched' },
    ]);
    expect(modifiedThreads(s)).toEqual([s.ids[0]]);
    expect(result.queue).toEqual(s.queue);
    expect(queueSaves(s)).toBe(1);
  });

  it('a skipped move (gmail.modify missing while applying) adds gmail.modify, with no extra log', () => {
    const s = setup({ threads: 1 });
    s.ports.gmail.failNext('modifyThread', {
      ok: false,
      kind: 'scope',
      message: 'Insufficient Permission',
    });
    respondRest(s, [answers({ ship: true })]);

    const result = run(s);

    expect(result.alerts).toEqual(['scope_missing']);
    expect(result.missingScopes).toEqual([GMAIL_MODIFY]);
    expect(s.ports.log.all('scope_missing')).toEqual([]);
  });
});

describe('processChunk: invalid (422)', () => {
  it('errored for two threads: both IDs, one errored alert', () => {
    const s = setup();
    respondTo(s, 1, [ok200]);
    respondRest(s, [invalid422]);

    const result = run(s);

    expect(result.settlements.map((x) => x.outcome)).toEqual(['errored', 'classified', 'errored']);
    expect(result.erroredThreadIds).toEqual([s.ids[0], s.ids[2]]);
    expect(result.alerts).toEqual(['errored']);
    expect(result.queue).toEqual([]);
  });

  it('a retryable failure after every attempt is a strike, kept in the queue', () => {
    const s = setup({ threads: 1 });
    respondRest(s, [r429]);
    const result = run(s);
    expect(result.settlements).toEqual([
      { threadId: s.ids[0], source: 'scheduled', outcome: 'struck', strikes: 1 },
    ]);
    expect(loadQueue(s.ports.state).map((i) => i.strikes)).toEqual([1]);
  });
});

describe('processChunk: saving', () => {
  it('a StateError from the queue save propagates', () => {
    const s = setup();
    s.ports.gmail.failNext('getThread', FakeGmail.rateLimited(), {
      threadId: at(s.ids, 0),
      after: 1,
    });
    const error = new StateError('quota', { key: 'state.queue.0', reason: 'too_large' });
    s.ports.state.failNext('set', error, { key: 'state.queue.0' });
    expect(thrown(() => run(s))).toBe(error);
  });

  it('writes the queue once when something changed', () => {
    const s = setup();
    respondTo(s, 0, [r429]);
    respondRest(s, [ok200]);
    run(s);
    expect(queueWrites(s)).toBe(1);
  });
});

describe('processChunk: preconditions', () => {
  it.each<[string, (s: Setup) => [readonly WorkItem[], WorkQueue]]>([
    ['an empty chunk', (s) => [[], s.queue]],
    ['an item not in the queue', (s) => [s.queue, s.queue.slice(1)]],
    ['a repeated item', (s) => [[at(s.queue, 0), at(s.queue, 0)], s.queue]],
    [
      '21 items',
      () => {
        const ids = Array.from({ length: 21 }, (_, i) => `t${String(i)}`);
        const queue = queueOf(ids, 0);
        return [queue, queue];
      },
    ],
  ])('%s throws InvalidArgumentError before any call', (_name, make) => {
    const s = setup();
    const [chunk, queue] = make(s);
    expect(thrown(() => processChunk(chunk, queue, s.deps))).toBeInstanceOf(InvalidArgumentError);
    expect(s.ports.gmail.calls).toEqual([]);
  });
});

describe('processChunk: privacy', () => {
  it('no event carries a body or state (FakeLog rejects them), and bodies are never logged', () => {
    const s = setup();
    respondTo(s, 0, [invalid422]);
    respondRest(s, [ok200]);
    run(s);
    expect(JSON.stringify(s.ports.log.events)).not.toContain('private body');
  });
});
