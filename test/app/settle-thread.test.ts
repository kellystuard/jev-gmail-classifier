import { describe, expect, it } from 'vitest';

import type { JevSendEntry, JevSendStop, JevUnretried } from '../../src/app/jev-sender.ts';
import { createLabelCache } from '../../src/app/label-cache.ts';
import {
  type SettleContext,
  type SettleDeps,
  settleThread,
  type ThreadSettlement,
} from '../../src/app/settle-thread.ts';
import type { Config } from '../../src/config/schema.ts';
import {
  InvalidArgumentError,
  RunAbortError,
  StateError,
  UnexpectedResponseError,
} from '../../src/core/errors.ts';
import { JEV_ERROR_LABEL_KEY } from '../../src/core/jev-error-label.ts';
import type { JevHttpResponse } from '../../src/core/jev-status.ts';
import { JEV_ERROR_LABEL } from '../../src/core/label-path.ts';
import { fail } from '../../src/core/result.ts';
import { enqueue, type WorkItem, type WorkQueue } from '../../src/core/work-queue.ts';
import type { GmailPort } from '../../src/ports/gmail-port.ts';
import maxTokens400 from '../fixtures/jev/400-max-tokens-exceeded.json' with { type: 'json' };
import unknownModel400 from '../fixtures/jev/400-unknown-model.json' with { type: 'json' };
import wrongKey401 from '../fixtures/jev/401-wrong-key.json' with { type: 'json' };
import noKey403 from '../fixtures/jev/403-no-key.json' with { type: 'json' };
import invalid422 from '../fixtures/jev/422-empty-questions.json' with { type: 'json' };
import { FakeGmail } from '../fakes/fake-gmail.ts';
import { FakeLog, type LoggedEvent } from '../fakes/fake-log.ts';
import { FakeState } from '../fakes/fake-state.ts';

const BILL = 'Finance/Bill';
const NEWS = 'News';
const SHOPPING = 'Shopping';

/** Two label rules, then two move rules, in config order. */
const RULES: Config['rules'] = [
  { id: 'bill', question: 'Is this a bill?', action: 'label', label: BILL },
  { id: 'news', question: 'Is this a newsletter?', action: 'label', label: NEWS, threshold: 0.5 },
  {
    id: 'promo',
    question: 'Is this a promotion?',
    action: 'move',
    destination: { kind: 'archive' },
  },
  {
    id: 'shop',
    question: 'Is this a shop receipt?',
    action: 'move',
    destination: { kind: 'label', label: SHOPPING },
  },
];
const DEFAULT_THRESHOLD = 0.8;
const MODEL = 'jev-1.13.0';
const REQUEST_ID = 'req_0123456789abcdef';

type Answers = Record<'bill' | 'news' | 'promo' | 'shop', number>;
const NOTHING: Answers = { bill: 0.1, news: 0.1, promo: 0.1, shop: 0.1 };
const BILL_AND_PROMO: Answers = { bill: 0.9, news: 0.2, promo: 0.95, shop: 0.1 };

function ok200(answers: Answers, options: { requestId?: string; tokens?: number } = {}) {
  const body = JSON.stringify({
    model: MODEL,
    answers: Object.fromEntries(
      Object.entries(answers).map(([id, p]) => [id, { type: 'noul', noul: p }]),
    ),
    usage: { input_tokens: options.tokens ?? 580, output_tokens: 68 },
  });
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.requestId !== undefined) {
    headers['x-typesafe-request-id'] = options.requestId;
  }
  return { status: 200, headers, body };
}

const r429: JevHttpResponse = {
  status: 429,
  headers: { 'x-typesafe-request-id': REQUEST_ID },
  body: '',
};
const r402: JevHttpResponse = { status: 402, headers: {}, body: '' };
const r418: JevHttpResponse = { status: 418, headers: {}, body: '' };
const malformed200: JevHttpResponse = { status: 200, headers: {}, body: '{"model":"jev"}' };

function responseEntry(
  threadId: string,
  response: JevHttpResponse,
  unretried?: JevUnretried,
): JevSendEntry {
  return unretried === undefined
    ? { id: threadId, response, attempts: 3 }
    : { id: threadId, response, attempts: 1, unretried };
}

function transportEntry(threadId: string, unretried?: JevUnretried): JevSendEntry {
  return unretried === undefined
    ? { id: threadId, transport: true, attempts: 3 }
    : { id: threadId, transport: true, attempts: 1, unretried };
}

type Setup = {
  readonly gmail: FakeGmail;
  readonly log: FakeLog;
  readonly state: FakeState;
  readonly deps: SettleDeps;
};

function setup(gmailPort?: (fake: FakeGmail) => GmailPort): Setup {
  const gmail = new FakeGmail();
  const log = new FakeLog();
  const state = new FakeState();
  const port = gmailPort?.(gmail) ?? gmail;
  const labels = createLabelCache({ gmail: port, log });
  const deps: SettleDeps = {
    config: { rules: RULES, defaultThreshold: DEFAULT_THRESHOLD },
    gmail: port,
    labels,
    state,
    log,
  };
  return { gmail, log, state, deps };
}

/** Item fields to override; `unsetFirstClassification` leaves `firstClassification` out. */
type ItemOverrides = Partial<WorkItem> & { readonly unsetFirstClassification?: true };

/** A queue with one item per thread, in order; `overrides` apply to every item. */
function queueOf(threadIds: readonly string[], overrides: ItemOverrides = {}): WorkQueue {
  const { unsetFirstClassification, ...fields } = overrides;
  let queue: WorkQueue = [];
  threadIds.forEach((threadId, i) => {
    const added = enqueue(queue, {
      threadId,
      source: 'scheduled',
      enqueuedAt: 1_000 + i,
      positionSavedAt: 500,
      ...(unsetFirstClassification === true ? {} : { firstClassification: true }),
    });
    if (!added.ok) {
      throw new Error('setup: enqueue failed');
    }
    queue = added.queue;
  });
  return queue.map((item) => ({ ...item, ...fields }));
}

function itemOf(queue: WorkQueue, threadId: string): WorkItem {
  const item = queue.find((i) => i.threadId === threadId);
  if (item === undefined) {
    throw new Error(`setup: ${threadId} isn't queued`);
  }
  return item;
}

/** A delivered thread, queued alone (plus `others`), and its context. */
function oneThread(
  s: Setup,
  overrides: ItemOverrides = {},
  extra: Partial<SettleContext> = {},
): { threadId: string; context: SettleContext } {
  const { threadId } = s.gmail.deliver();
  const queue = queueOf([threadId], overrides);
  return { threadId, context: { item: itemOf(queue, threadId), queue, ...extra } };
}

function labelId(gmail: FakeGmail, name: string): string | undefined {
  const listed = gmail.listLabels();
  return listed.ok ? listed.labels.find((l) => l.name === name)?.id : undefined;
}

function threadEvents(log: FakeLog): LoggedEvent[] {
  return log.events.filter((e) => e.event.startsWith('thread.'));
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** Settles `threadId` with the same entry `n` times, threading the queue through. */
function settleTimes(
  s: Setup,
  context: SettleContext,
  entry: JevSendEntry,
  n: number,
): ThreadSettlement[] {
  const out: ThreadSettlement[] = [];
  let queue = context.queue;
  for (let i = 0; i < n; i++) {
    const item = queue.find((it) => it.threadId === context.item.threadId);
    if (item === undefined) {
      throw new Error('test: item left the queue early');
    }
    const settled = settleThread(entry, { ...context, item, queue }, s.deps);
    out.push(settled);
    queue = settled.queue;
  }
  return out;
}

describe('settleThread: an answer (ok)', () => {
  it.each<[string, ItemOverrides, boolean]>([
    ['a first classification', { firstClassification: true }, true],
    [
      'a manual item with applyMoves',
      { firstClassification: false, source: 'manual', applyMoves: true },
      true,
    ],
    ['a later classification', { firstClassification: false }, false],
    ['an unset firstClassification', { unsetFirstClassification: true }, false],
  ])('%s: labels, and the move only when moves are allowed', (_name, overrides, moves) => {
    const s = setup();
    const { threadId, context } = oneThread(s, overrides);

    const settled = settleThread(
      responseEntry(threadId, ok200(BILL_AND_PROMO, { requestId: REQUEST_ID })),
      context,
      s.deps,
    );

    expect(settled).toEqual({
      queue: [],
      outcome: 'classified',
      alerts: [],
      applied: moves ? { labels: [BILL], move: { kind: 'archive' } } : { labels: [BILL] },
    });
    const bill = labelId(s.gmail, BILL);
    const labels = s.gmail.threadLabels(threadId)[0];
    expect(labels).toContain(bill);
    expect(labels?.includes('INBOX')).toBe(!moves);
    const event = s.log.find('thread.classified');
    expect(event?.fields['actions']).toEqual(
      moves ? [`label:${BILL}`, 'move:archive'] : [`label:${BILL}`],
    );
    expect(event?.fields['fired']).toEqual(['bill', 'promo']);
  });

  it('names a label move as move:label:<name> after the labels', () => {
    const s = setup();
    const { threadId, context } = oneThread(s);
    const settled = settleThread(
      responseEntry(threadId, ok200({ bill: 0.9, news: 0.6, promo: 0.1, shop: 0.99 })),
      context,
      s.deps,
    );
    expect(settled.applied).toEqual({
      labels: [BILL, NEWS],
      move: { kind: 'label', label: SHOPPING },
    });
    expect(s.log.find('thread.classified')?.fields['actions']).toEqual([
      `label:${BILL}`,
      `label:${NEWS}`,
      `move:label:${SHOPPING}`,
    ]);
  });

  it('no firing rule: classified, dequeued, and no Gmail write', () => {
    const s = setup();
    const { threadId, context } = oneThread(s);
    const settled = settleThread(responseEntry(threadId, ok200(NOTHING)), context, s.deps);
    expect(settled).toEqual({
      queue: [],
      outcome: 'classified',
      alerts: [],
      applied: { labels: [] },
    });
    expect(s.gmail.calls).toEqual([]);
    expect(s.log.find('thread.classified')?.fields['actions']).toEqual([]);
  });

  it('keeps the rest of the queue', () => {
    const s = setup();
    const a = s.gmail.deliver().threadId;
    const b = s.gmail.deliver().threadId;
    const queue = queueOf([a, b]);
    const settled = settleThread(
      responseEntry(a, ok200(NOTHING)),
      { item: itemOf(queue, a), queue },
      s.deps,
    );
    expect(settled.queue).toEqual([itemOf(queue, b)]);
  });

  it('logs thread.classified with every field, and no body', () => {
    const s = setup();
    const truncated = { messagesDropped: 2, bodiesDropped: 1, charsDropped: 900 };
    const { threadId, context } = oneThread(
      s,
      {},
      {
        subject: 'Your bill',
        from: 'Billing <billing@example.com>',
        truncated,
      },
    );

    settleThread(
      responseEntry(threadId, ok200(BILL_AND_PROMO, { requestId: REQUEST_ID, tokens: 1234 })),
      context,
      s.deps,
    );

    expect(threadEvents(s.log)).toEqual([
      {
        level: 'info',
        event: 'thread.classified',
        fields: {
          threadId,
          source: 'scheduled',
          subject: 'Your bill',
          from: 'Billing <billing@example.com>',
          probabilities: BILL_AND_PROMO,
          fired: ['bill', 'promo'],
          actions: [`label:${BILL}`, 'move:archive'],
          truncated,
          requestId: REQUEST_ID,
          model: MODEL,
          inputTokens: 1234,
        },
      },
    ]);
  });

  it('leaves out subject, from, truncated and requestId when absent', () => {
    const s = setup();
    const { threadId, context } = oneThread(s);
    settleThread(responseEntry(threadId, ok200(NOTHING, { tokens: 7 })), context, s.deps);
    expect(s.log.find('thread.classified')?.fields).toEqual({
      threadId,
      source: 'scheduled',
      probabilities: NOTHING,
      fired: [],
      actions: [],
      model: MODEL,
      inputTokens: 7,
    });
  });

  it('a missing scope in applyDecision: classified, dequeued, moveSkipped, scope_missing', () => {
    const s = setup();
    const { threadId, context } = oneThread(s);
    s.gmail.failNext('modifyThread', fail('scope', { message: 'Insufficient Permission' }));

    const settled = settleThread(responseEntry(threadId, ok200(BILL_AND_PROMO)), context, s.deps);

    expect(settled).toEqual({
      queue: [],
      outcome: 'classified',
      alerts: ['scope_missing'],
      applied: { labels: [BILL] },
      moveSkipped: 'scope',
    });
    const fields = s.log.find('thread.classified')?.fields;
    expect(fields?.['moveSkipped']).toBe('scope');
    expect(fields?.['actions']).toEqual([`label:${BILL}`]);
  });

  it('labels skipped too: labelsSkipped in the settlement and the log', () => {
    const s = setup();
    const { threadId, context } = oneThread(s);
    s.gmail.failNext('modifyThread', fail('scope', { message: 'Insufficient Permission' }), {
      times: 2,
    });
    const settled = settleThread(responseEntry(threadId, ok200(BILL_AND_PROMO)), context, s.deps);
    expect(settled).toMatchObject({
      outcome: 'classified',
      alerts: ['scope_missing'],
      applied: { labels: [] },
      moveSkipped: 'scope',
      labelsSkipped: 'scope',
    });
    expect(s.log.find('thread.classified')?.fields['labelsSkipped']).toBe('scope');
  });
});

describe('settleThread: invalid (422, 400 max_tokens_exceeded)', () => {
  it.each<[string, JevHttpResponse, Record<string, unknown>]>([
    ['422', invalid422, { status: 422 }],
    ['400 max_tokens_exceeded', maxTokens400, { status: 400, errorType: 'max_tokens_exceeded' }],
  ])('%s: errored, Jev/Error added, dequeued', (_name, response, logged) => {
    const s = setup();
    const { threadId, context } = oneThread(s);

    const settled = settleThread(responseEntry(threadId, response), context, s.deps);

    expect(settled).toEqual({ queue: [], outcome: 'errored', alerts: ['errored'] });
    expect(s.gmail.threadLabels(threadId)[0]).toContain(labelId(s.gmail, JEV_ERROR_LABEL));
    const events = threadEvents(s.log);
    expect(events.map((e) => [e.level, e.event])).toEqual([['warn', 'thread.errored']]);
    expect(events[0]?.fields).toEqual({
      ...logged,
      requestId: response.headers['x-typesafe-request-id'],
      threadId,
      source: 'scheduled',
      reason: 'invalid',
    });
  });

  it('a corrupt state.jevErrorLabel: StateError is rethrown', () => {
    const s = setup();
    const { threadId, context } = oneThread(s);
    s.state.seedRaw(JEV_ERROR_LABEL_KEY, '{"v":1,"ids":[42]}');
    expect(
      thrown(() => settleThread(responseEntry(threadId, invalid422), context, s.deps)),
    ).toBeInstanceOf(StateError);
    expect(threadEvents(s.log)).toEqual([]);
  });

  it('Jev/Error rate limited: untouched, input queue, stopGmail, thread.failed', () => {
    const s = setup();
    const { threadId, context } = oneThread(s);
    s.gmail.failNext('listLabels', FakeGmail.rateLimited());
    const settled = settleThread(responseEntry(threadId, invalid422), context, s.deps);
    expect(settled).toEqual({
      queue: context.queue,
      outcome: 'untouched',
      alerts: [],
      stopGmail: 'rate_limited',
    });
    expect(settled.queue).toBe(context.queue);
    expect(threadEvents(s.log).map((e) => e.fields)).toEqual([
      {
        status: 422,
        requestId: invalid422.headers['x-typesafe-request-id'],
        threadId,
        source: 'scheduled',
        reason: 'invalid',
        jevError: 'rate_limited',
      },
    ]);
  });

  it('a deleted thread: gone, dequeued, thread.skipped', () => {
    const s = setup();
    const queue = queueOf(['deleted-thread']);
    const settled = settleThread(
      responseEntry('deleted-thread', invalid422),
      { item: itemOf(queue, 'deleted-thread'), queue },
      s.deps,
    );
    expect(settled).toEqual({ queue: [], outcome: 'gone', alerts: [] });
    expect(threadEvents(s.log)).toEqual([
      {
        level: 'info',
        event: 'thread.skipped',
        fields: { threadId: 'deleted-thread', source: 'scheduled', reason: 'not_found' },
      },
    ]);
  });
});

describe('settleThread: strikes', () => {
  it.each<[string, (id: string) => JevSendEntry, Record<string, unknown>]>([
    [
      'retryable',
      (id) => responseEntry(id, r429),
      { reason: 'retryable', status: 429, requestId: REQUEST_ID },
    ],
    ['transport', (id) => transportEntry(id), { reason: 'transport' }],
  ])('%s with no unretried: strikes 1, 2, then Jev/Error on 3', (_name, entryFor, why) => {
    const s = setup();
    const { threadId, context } = oneThread(s);

    const [one, two, three] = settleTimes(s, context, entryFor(threadId), 3);

    expect(one).toMatchObject({ outcome: 'struck', strikes: 1, alerts: [] });
    expect(one?.queue[0]?.strikes).toBe(1);
    expect(two).toMatchObject({ outcome: 'struck', strikes: 2, alerts: [] });
    expect(two?.queue[0]?.strikes).toBe(2);
    expect(three).toEqual({ queue: [], outcome: 'errored', alerts: ['errored'], strikes: 3 });
    expect(s.gmail.threadLabels(threadId)[0]).toContain(labelId(s.gmail, JEV_ERROR_LABEL));

    const base = { threadId, source: 'scheduled' };
    expect(threadEvents(s.log).map((e) => [e.level, e.event, e.fields])).toEqual([
      ['warn', 'thread.failed', { ...why, ...base, strikes: 1 }],
      ['warn', 'thread.failed', { ...why, ...base, strikes: 2 }],
      ['warn', 'thread.failed', { ...why, ...base, strikes: 3 }],
      [
        'warn',
        'thread.errored',
        {
          ...('status' in why ? { status: 429, requestId: REQUEST_ID } : {}),
          ...base,
          reason: 'strikes',
        },
      ],
    ]);
  });

  it('a strike makes no Gmail call before the third', () => {
    const s = setup();
    const { threadId, context } = oneThread(s);
    settleTimes(s, context, transportEntry(threadId), 2);
    expect(s.gmail.calls).toEqual([]);
  });
});

describe('settleThread: untouched, with no strike and no log', () => {
  const unretried: JevUnretried[] = ['deadline', 'retry_after', 'stopped'];
  const stops: JevSendStop[] = ['budget', 'deadline', 'auth', 'config', 'scope', 'outage'];
  const cases: [string, (id: string) => JevSendEntry, readonly string[]][] = [
    ...unretried.map((u): [string, (id: string) => JevSendEntry, readonly string[]] => [
      `response retryable, unretried ${u}`,
      (id) => responseEntry(id, r429, u),
      [],
    ]),
    ...unretried.map((u): [string, (id: string) => JevSendEntry, readonly string[]] => [
      `transport, unretried ${u}`,
      (id) => transportEntry(id, u),
      [],
    ]),
    ...stops.map((stop): [string, (id: string) => JevSendEntry, readonly string[]] => [
      `notSent ${stop}`,
      (id) => ({ id, notSent: stop }),
      [],
    ]),
    ['scope', (id) => ({ id, scope: true }), ['scope_missing']],
  ];

  it.each(cases)('%s', (_name, entryFor, alerts) => {
    const s = setup();
    const { threadId, context } = oneThread(s);
    const settled = settleThread(entryFor(threadId), context, s.deps);
    expect(settled).toEqual({ queue: context.queue, outcome: 'untouched', alerts });
    expect(settled.queue).toBe(context.queue);
    expect(s.gmail.calls).toEqual([]);
    expect(threadEvents(s.log)).toEqual([]);
  });

  it.each<[string, JevHttpResponse, 'auth' | 'config_invalid']>([
    ['401', wrongKey401, 'auth'],
    ['402', r402, 'auth'],
    ['403', noKey403, 'auth'],
    ['unknown model', unknownModel400, 'config_invalid'],
  ])('%s: untouched with abort, no throw, no Gmail call', (_name, response, abort) => {
    const s = setup();
    const { threadId, context } = oneThread(s);
    const settled = settleThread(responseEntry(threadId, response), context, s.deps);
    expect(settled).toEqual({ queue: context.queue, outcome: 'untouched', alerts: [], abort });
    expect(settled.queue).toBe(context.queue);
    expect(s.gmail.calls).toEqual([]);
    expect(threadEvents(s.log)).toEqual([]);
  });
});

describe('settleThread: Gmail failures while applying', () => {
  it.each<[string, (gmail: FakeGmail) => void]>([
    [
      'modifyThread',
      (gmail) => {
        gmail.failNext('modifyThread', FakeGmail.rateLimited());
      },
    ],
    [
      'createLabel',
      (gmail) => {
        gmail.failNext('createLabel', FakeGmail.rateLimited());
      },
    ],
  ])('rate_limited from %s: untouched, stopGmail, no log', (_name, inject) => {
    const s = setup();
    const { threadId, context } = oneThread(s);
    inject(s.gmail);
    const settled = settleThread(responseEntry(threadId, ok200(BILL_AND_PROMO)), context, s.deps);
    expect(settled).toEqual({
      queue: context.queue,
      outcome: 'untouched',
      alerts: [],
      stopGmail: 'rate_limited',
    });
    expect(settled.queue).toBe(context.queue);
    expect(threadEvents(s.log)).toEqual([]);
  });

  it('not_found: gone, dequeued, thread.skipped', () => {
    const s = setup();
    const queue = queueOf(['deleted-thread']);
    const settled = settleThread(
      responseEntry('deleted-thread', ok200(BILL_AND_PROMO)),
      { item: itemOf(queue, 'deleted-thread'), queue },
      s.deps,
    );
    expect(settled).toEqual({ queue: [], outcome: 'gone', alerts: [] });
    expect(threadEvents(s.log).map((e) => [e.level, e.event, e.fields])).toEqual([
      [
        'info',
        'thread.skipped',
        { threadId: 'deleted-thread', source: 'scheduled', reason: 'not_found' },
      ],
    ]);
  });

  it('failed_precondition: one strike', () => {
    const s = setup();
    const { threadId, context } = oneThread(s);
    s.gmail.failNext('modifyThread', FakeGmail.failedPrecondition());
    const settled = settleThread(responseEntry(threadId, ok200(BILL_AND_PROMO)), context, s.deps);
    expect(settled).toMatchObject({ outcome: 'struck', strikes: 1, alerts: [] });
    expect(threadEvents(s.log).map((e) => e.fields)).toEqual([
      { threadId, source: 'scheduled', reason: 'failed_precondition', strikes: 1 },
    ]);
  });
});

describe('settleThread: exceptions are one strike', () => {
  it.each<[string, (s: Setup, threadId: string) => JevSendEntry, Record<string, unknown>]>([
    [
      'a malformed 200',
      (_s, id) => responseEntry(id, malformed200),
      {
        reason: 'UnexpectedResponseError',
        error: 'UnexpectedResponseError',
        service: 'jev',
        status: 200,
        errorReason: 'malformed_body',
      },
    ],
    [
      'an exceptional status',
      (_s, id) => responseEntry(id, r418),
      {
        reason: 'UnexpectedResponseError',
        error: 'UnexpectedResponseError',
        service: 'jev',
        status: 418,
        errorReason: 'unexpected_status',
      },
    ],
    [
      'an unrecognized Gmail error',
      (s, id) => {
        s.gmail.failNext(
          'modifyThread',
          new UnexpectedResponseError('Gmail said no', {
            service: 'gmail',
            status: 500,
            reason: 'unrecognized',
          }),
        );
        return responseEntry(id, ok200(BILL_AND_PROMO));
      },
      {
        reason: 'UnexpectedResponseError',
        error: 'UnexpectedResponseError',
        errorMessage: 'Gmail said no',
        service: 'gmail',
        status: 500,
        errorReason: 'unrecognized',
      },
    ],
    [
      'a TypeError',
      (s, id) => {
        s.gmail.failNext('modifyThread', new TypeError('x is not a function'));
        return responseEntry(id, ok200(BILL_AND_PROMO));
      },
      { reason: 'TypeError', error: 'TypeError', errorMessage: 'x is not a function' },
    ],
  ])('%s', (_name, arrange, expected) => {
    const s = setup();
    const { threadId, context } = oneThread(s);
    const settled = settleThread(arrange(s, threadId), context, s.deps);
    expect(settled).toMatchObject({ outcome: 'struck', strikes: 1, alerts: [] });
    expect(settled.queue[0]?.strikes).toBe(1);
    const events = threadEvents(s.log);
    expect(events.map((e) => [e.level, e.event])).toEqual([['warn', 'thread.failed']]);
    expect(events[0]?.fields).toMatchObject({
      ...expected,
      threadId,
      source: 'scheduled',
      strikes: 1,
    });
    expect(events[0]?.fields).not.toHaveProperty('stack');
    expect(events[0]?.fields).not.toHaveProperty('cause');
  });

  it('a thrown non-Error from a stub GmailPort: reason unknown', () => {
    const s = setup((fake) => ({
      ...portOf(fake),
      listLabels: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- the case under test
        throw 'boom';
      },
    }));
    const { threadId, context } = oneThread(s);
    const settled = settleThread(responseEntry(threadId, ok200(BILL_AND_PROMO)), context, s.deps);
    expect(settled).toMatchObject({ outcome: 'struck', strikes: 1 });
    expect(threadEvents(s.log).map((e) => e.fields)).toEqual([
      { threadId, source: 'scheduled', reason: 'unknown', strikes: 1 },
    ]);
  });

  it('an exception on the third strike gives Jev/Error', () => {
    const s = setup();
    const { threadId, context } = oneThread(s, { strikes: 2 });
    s.gmail.failNext('modifyThread', new TypeError('bad'));
    const settled = settleThread(responseEntry(threadId, ok200(BILL_AND_PROMO)), context, s.deps);
    expect(settled).toEqual({ queue: [], outcome: 'errored', alerts: ['errored'], strikes: 3 });
    expect(threadEvents(s.log).map((e) => [e.event, e.fields['reason']])).toEqual([
      ['thread.failed', 'TypeError'],
      ['thread.errored', 'strikes'],
    ]);
  });

  it.each<[string, (s: Setup) => void]>([
    [
      'RunAbortError',
      (s) => {
        s.gmail.failNext('modifyThread', new RunAbortError('stop', { reason: 'auth' }));
      },
    ],
    [
      'StateError',
      (s) => {
        s.gmail.failNext(
          'modifyThread',
          new StateError('bad state', { key: 'state.queue.0', reason: 'schema' }),
        );
      },
    ],
  ])('%s from a dependency is rethrown', (name, arrange) => {
    const s = setup();
    const { threadId, context } = oneThread(s);
    arrange(s);
    const error = thrown(() =>
      settleThread(responseEntry(threadId, ok200(BILL_AND_PROMO)), context, s.deps),
    );
    expect(error).toBeInstanceOf(name === 'RunAbortError' ? RunAbortError : StateError);
    expect(threadEvents(s.log)).toEqual([]);
  });
});

describe('settleThread: the third strike when Jev/Error cannot be added', () => {
  it.each<[string, (gmail: FakeGmail) => void, Partial<ThreadSettlement>, string]>([
    [
      'rate_limited',
      (g) => {
        g.failNext('modifyThread', FakeGmail.rateLimited());
      },
      { alerts: [], stopGmail: 'rate_limited' },
      'rate_limited',
    ],
    [
      'scope',
      (g) => {
        g.failNext('modifyThread', fail('scope', { message: 'Insufficient Permission' }));
      },
      { alerts: ['scope_missing'] },
      'scope',
    ],
    [
      'failed_precondition',
      (g) => {
        g.failNext('modifyThread', FakeGmail.failedPrecondition());
      },
      { alerts: [] },
      'failed_precondition',
    ],
  ])('%s: untouched, input queue, one thread.failed', (_name, inject, extra, jevError) => {
    const s = setup();
    const { threadId, context } = oneThread(s, { strikes: 2 });
    inject(s.gmail);
    const settled = settleThread(transportEntry(threadId), context, s.deps);
    expect(settled).toEqual({ queue: context.queue, outcome: 'untouched', ...extra });
    expect(settled.queue).toBe(context.queue);
    expect(threadEvents(s.log).map((e) => [e.event, e.fields])).toEqual([
      ['thread.failed', { threadId, source: 'scheduled', reason: 'transport', jevError }],
    ]);
  });

  it('throws: untouched, input queue, jevError exception, no second strike', () => {
    const s = setup();
    const { threadId, context } = oneThread(s, { strikes: 2 });
    s.gmail.failNext('modifyThread', new TypeError('label boom'));
    const settled = settleThread(responseEntry(threadId, r429), context, s.deps);
    expect(settled).toEqual({ queue: context.queue, outcome: 'untouched', alerts: [] });
    expect(settled.queue).toBe(context.queue);
    expect(s.gmail.calls.filter((c) => c.method === 'modifyThread')).toHaveLength(1);
    expect(threadEvents(s.log).map((e) => [e.event, e.fields])).toEqual([
      [
        'thread.failed',
        {
          status: 429,
          requestId: REQUEST_ID,
          error: 'TypeError',
          errorMessage: 'label boom',
          threadId,
          source: 'scheduled',
          reason: 'retryable',
          jevError: 'exception',
        },
      ],
    ]);
  });

  it('an exception, then marking Jev/Error throws: untouched, one strike attempt only', () => {
    const s = setup();
    const { threadId, context } = oneThread(s, { strikes: 2 });
    // The first modifyThread (applying the answer) and the second (Jev/Error) both throw.
    s.gmail.failNext('modifyThread', new TypeError('first'));
    s.gmail.failNext(
      'modifyThread',
      new UnexpectedResponseError('second', { service: 'gmail', reason: 'unrecognized' }),
    );
    const settled = settleThread(responseEntry(threadId, ok200(BILL_AND_PROMO)), context, s.deps);
    expect(settled).toEqual({ queue: context.queue, outcome: 'untouched', alerts: [] });
    expect(s.gmail.calls.filter((c) => c.method === 'modifyThread')).toHaveLength(2);
    const events = threadEvents(s.log);
    expect(events).toHaveLength(1);
    expect(events[0]?.fields).toMatchObject({
      reason: 'TypeError',
      error: 'UnexpectedResponseError',
      errorMessage: 'second',
      errorReason: 'unrecognized',
      jevError: 'exception',
    });
    expect(events[0]?.fields).not.toHaveProperty('strikes');
  });

  it('marking an invalid thread throws: untouched, jevError exception', () => {
    const s = setup();
    const { threadId, context } = oneThread(s);
    s.gmail.failNext('modifyThread', new TypeError('nope'));
    const settled = settleThread(responseEntry(threadId, maxTokens400), context, s.deps);
    expect(settled).toEqual({ queue: context.queue, outcome: 'untouched', alerts: [] });
    expect(
      threadEvents(s.log).map((e) => [e.event, e.fields['reason'], e.fields['jevError']]),
    ).toEqual([['thread.failed', 'invalid', 'exception']]);
  });

  it('StateError while marking after an exception is rethrown', () => {
    const s = setup();
    const { threadId, context } = oneThread(s, { strikes: 2 });
    s.state.seedRaw(JEV_ERROR_LABEL_KEY, '{"v":1,"ids":[42]}');
    expect(
      thrown(() => settleThread(responseEntry(threadId, malformed200), context, s.deps)),
    ).toBeInstanceOf(StateError);
  });
});

describe('settleThread: one bad thread does not stop the chunk', () => {
  it('settles three entries in turn where the middle one throws from Gmail', () => {
    const s = setup();
    const ids = [
      s.gmail.deliver().threadId,
      s.gmail.deliver().threadId,
      s.gmail.deliver().threadId,
    ];
    const [a, b, c] = ids;
    if (a === undefined || b === undefined || c === undefined) {
      throw new Error('setup: three threads');
    }
    let queue = queueOf(ids);
    s.gmail.failNext('modifyThread', new TypeError('broken'), { threadId: b });

    const outcomes = ids.map((id) => {
      const settled = settleThread(
        responseEntry(id, ok200(BILL_AND_PROMO)),
        { item: itemOf(queue, id), queue },
        s.deps,
      );
      queue = settled.queue;
      return settled.outcome;
    });

    expect(outcomes).toEqual(['classified', 'struck', 'classified']);
    expect(queue.map((i) => [i.threadId, i.strikes])).toEqual([[b, 1]]);
    const bill = labelId(s.gmail, BILL);
    expect(s.gmail.threadLabels(a)[0]).toContain(bill);
    expect(s.gmail.threadLabels(c)[0]).toContain(bill);
    expect(s.gmail.threadLabels(b)[0]).not.toContain(bill);
  });
});

describe('settleThread: preconditions', () => {
  it('a mismatched entry.id throws InvalidArgumentError', () => {
    const s = setup();
    const { context } = oneThread(s);
    expect(thrown(() => settleThread(transportEntry('other'), context, s.deps))).toBeInstanceOf(
      InvalidArgumentError,
    );
  });

  it('an item not in the queue throws InvalidArgumentError', () => {
    const s = setup();
    const { threadId, context } = oneThread(s);
    expect(
      thrown(() => settleThread(transportEntry(threadId), { ...context, queue: [] }, s.deps)),
    ).toBeInstanceOf(InvalidArgumentError);
  });
});

describe('settleThread: privacy', () => {
  it('thread.failed and thread.errored never carry subject or from', () => {
    const s = setup();
    const context = oneThread(s, { strikes: 2 }, { subject: 'Secret', from: 'a@example.com' });
    settleThread(transportEntry(context.threadId), context.context, s.deps);
    const other = oneThread(s, {}, { subject: 'Secret', from: 'a@example.com' });
    settleThread(responseEntry(other.threadId, invalid422), other.context, s.deps);
    s.gmail.failNext(
      'modifyThread',
      new UnexpectedResponseError('x', { service: 'gmail', reason: 'y' }),
    );
    const third = oneThread(s, {}, { subject: 'Secret', from: 'a@example.com' });
    settleThread(responseEntry(third.threadId, ok200(BILL_AND_PROMO)), third.context, s.deps);

    const failures = s.log.events.filter(
      (e) => e.event === 'thread.failed' || e.event === 'thread.errored',
    );
    expect(failures.length).toBeGreaterThanOrEqual(4);
    for (const event of failures) {
      expect(event.fields).not.toHaveProperty('subject');
      expect(event.fields).not.toHaveProperty('from');
    }
  });
});

/** Every `GmailPort` method of the fake, bound, for a stub that overrides one. */
function portOf(fake: FakeGmail): GmailPort {
  return {
    getProfile: () => fake.getProfile(),
    listHistory: (request) => fake.listHistory(request),
    searchThreadIds: (request) => fake.searchThreadIds(request),
    getThread: (threadId, format) => fake.getThread(threadId, format),
    listLabels: () => fake.listLabels(),
    createLabel: (name) => fake.createLabel(name),
    modifyThread: (threadId, change) => fake.modifyThread(threadId, change),
  };
}
