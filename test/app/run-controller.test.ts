import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { type CollectedAlerts, createAlertCollector } from '../../src/app/alerts.ts';
import { countGmailCalls } from '../../src/app/counting-gmail.ts';
import { loadQueue, saveQueue } from '../../src/app/queue-store.ts';
import {
  type RunReport,
  runScheduled,
  type ScheduledDeps,
  type SpareTimeHook,
  type SpareTimeInput,
  type SpareTimeResult,
} from '../../src/app/run-controller.ts';
import { type RunContext, type RunEntryOptions, runEntry } from '../../src/app/run-entry.ts';
import { loadConfig } from '../../src/config/loader.ts';
import type { Config } from '../../src/config/schema.ts';
import { createDeadline } from '../../src/core/deadline.ts';
import { RunAbortError, StateError } from '../../src/core/errors.ts';
import { JEV_ERROR_LABEL } from '../../src/core/label-path.ts';
import { encodePosition, POSITION_KEY } from '../../src/core/position.ts';
import { decodeRunRecord, RUNS_KEY } from '../../src/core/run-record.ts';
import { type RunLimits, runLimits } from '../../src/core/run-limits.ts';
import { SCOPE_FEATURES } from '../../src/core/scope-features.ts';
import { BUDGET_KEY, encodeBudget } from '../../src/core/token-budget.ts';
import {
  enqueue,
  QUEUE_MAX_ITEMS,
  type WorkItemSource,
  type WorkQueue,
} from '../../src/core/work-queue.ts';
import type { HttpRequest } from '../../src/ports/http-port.ts';
import { FakeGmail } from '../fakes/fake-gmail.ts';
import { type FakeHttpResponse, jsonPayload } from '../fakes/fake-http.ts';
import { createFakePorts, type FakePorts, type FakePortsOptions } from '../fakes/fake-ports.ts';
import { nodeDecodeUtf8 } from '../fakes/node-utf8.ts';
import ok200 from '../fixtures/jev/200-four-rules.json' with { type: 'json' };
import unknownModel400 from '../fixtures/jev/400-unknown-model.json' with { type: 'json' };
import wrongKey401 from '../fixtures/jev/401-wrong-key.json' with { type: 'json' };
import invalid422 from '../fixtures/jev/422-empty-questions.json' with { type: 'json' };

const GMAIL_MODIFY = 'https://www.googleapis.com/auth/gmail.modify';
const EXTERNAL_REQUEST = 'https://www.googleapis.com/auth/script.external_request';
/** `createFakePorts()`'s default clock. */
const NOW = Date.parse('2026-09-26T12:00:00Z');
const TODAY = '2026-09-26';
const HOUR_MS = 3_600_000;
const KEY = 'test-key';
const NEWS = 'News';
const BUDGET = 1_000_000;
/** `usage.input_tokens` in the 200 fixture. */
const FIXTURE_TOKENS = 580;
const BODY_TEXT = 'the private body of';

const SCHEDULED: RunEntryOptions = {
  entry: 'onTrigger',
  kind: 'scheduled',
  heartbeat: true,
  tallyGmail: true,
};

/** Scheduled limits at 10 minutes: soft 30 s, chunk 20, 3,000 units (one full chunk per run). */
const SCHEDULED_10 = runLimits('scheduled', 10);
/** Room for several chunks of 20 (the manual row: 4.5 min, 13,500 units). */
const ROOMY = runLimits('manual', 10);

/**
 * The four rules of `200-four-rules.json`: in it only `newsletter` fires, so
 * the fixture answer adds `News` and moves nothing. `shipping` is the move
 * rule (archive).
 */
function config(extra: { dailyTokenBudget?: number } = {}): Config {
  return loadConfig({
    defaultThreshold: 0.8,
    triggerIntervalMinutes: 10,
    dailyTokenBudget: extra.dailyTokenBudget ?? BUDGET,
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

/** A 200 answering every rule; `shipping` fires (archive) when `ship` is set. */
function answers(options: { ship?: boolean } = {}): FakeHttpResponse {
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
      usage: { input_tokens: 100 },
    }),
  };
}

const r503: FakeHttpResponse = { status: 503, headers: {}, body: '' };
/** Retryable, but asks for a wait over 60 s: not retried (`unretried: 'retry_after'`). */
const r429Late: FakeHttpResponse = { status: 429, headers: { 'retry-after': '61' }, body: '' };

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

/** Every world a test built, checked after it for secrets in the log. */
let worlds: FakePorts[] = [];

afterEach(() => {
  for (const ports of worlds) {
    const logged = JSON.stringify(ports.log.events);
    expect(logged).not.toContain(BODY_TEXT);
    expect(logged).not.toContain(KEY);
    expect(ports.log.events.some((e) => 'state' in e.fields)).toBe(false);
  }
  worlds = [];
});

/**
 * Fake ports with `state.position` seeded at the mailbox's current
 * `historyId` (saved an hour ago), then `threads` new threads with subjects
 * `mail <i>`, which the run's ingest will find.
 */
function world(
  threads: number,
  options: FakePortsOptions & { readonly position?: boolean } = {},
): { ports: FakePorts; ids: string[] } {
  const ports = createFakePorts(options);
  worlds.push(ports);
  if (options.position !== false) {
    ports.state.seedRaw(
      POSITION_KEY,
      JSON.stringify(encodePosition({ historyId: ports.gmail.historyId, savedAt: NOW - HOUR_MS })),
    );
  }
  const ids: string[] = [];
  for (let i = 0; i < threads; i++) {
    ids.push(deliver(ports.gmail, `mail ${String(i)}`));
  }
  return { ports, ids };
}

function deliver(gmail: FakeGmail, subject: string): string {
  return gmail.deliver({
    internalDate: NOW - 10 * 60_000,
    headers: [
      { name: 'From', value: 'friend@example.com' },
      { name: 'Subject', value: subject },
    ],
    bodyText: `${BODY_TEXT} ${subject}`,
  }).threadId;
}

function scheduledDeps(ports: FakePorts, spareTime?: SpareTimeHook): ScheduledDeps {
  return {
    http: ports.http,
    state: ports.state,
    log: ports.log,
    clock: ports.clock,
    random: ports.random,
    secrets: ports.secrets,
    auth: ports.auth,
    decodeUtf8: nodeDecodeUtf8,
    ...(spareTime === undefined ? {} : { spareTime }),
  };
}

/** A `RunContext` built by hand, so a test can choose the limits. */
function context(
  ports: FakePorts,
  options: { readonly limits?: RunLimits; readonly config?: Config } = {},
): RunContext & { collected(): CollectedAlerts } {
  const limits = options.limits ?? SCHEDULED_10;
  const counting = countGmailCalls(ports.gmail);
  const alerts = createAlertCollector();
  return {
    config: options.config ?? config(),
    deadline: createDeadline(() => ports.clock.now(), limits),
    limits,
    gmail: counting.gmail,
    gmailUsage: () => ({
      calls: counting.calls(),
      units: counting.units(),
      callsToday: counting.calls(),
    }),
    alerts,
    collected: () => alerts.collected(),
  };
}

/** Runs `runScheduled` with a hand-built context. */
function run(
  ports: FakePorts,
  options: {
    readonly limits?: RunLimits;
    readonly config?: Config;
    readonly spareTime?: SpareTimeHook;
  } = {},
): { report: RunReport; collected: CollectedAlerts } {
  const ctx = context(ports, options);
  const report = runScheduled(ctx, scheduledDeps(ports, options.spareTime));
  return { report, collected: ctx.collected() };
}

/** Runs `onTrigger`'s pairing, `runEntry` + `runScheduled`, as #121 wires it. */
function runTrigger(
  ports: FakePorts,
  cfg: Config = config(),
): {
  outcome: () => RunReport | { readonly skipped: 'busy' };
  delivered: CollectedAlerts[];
} {
  const delivered: CollectedAlerts[] = [];
  const outcome = () =>
    runEntry(
      SCHEDULED,
      {
        lock: ports.lock,
        clock: ports.clock,
        state: ports.state,
        log: ports.log,
        gmail: ports.gmail,
        alertSink: {
          deliver: (alerts) => {
            delivered.push(alerts);
          },
        },
        loadConfig: () => cfg,
      },
      (ctx) => runScheduled(ctx, scheduledDeps(ports)),
    );
  return { outcome, delivered };
}

const payloadSchema = z.object({ state: z.array(z.object({ subject: z.string() })) });

function subjectOf(request: HttpRequest): string {
  return payloadSchema.parse(jsonPayload(request)).state[0]?.subject ?? '';
}

/** Answers the request for thread `i` (subject `mail <i>`). */
function respondTo(ports: FakePorts, i: number, responses: readonly FakeHttpResponse[]): void {
  ports.http.respond((request) => subjectOf(request) === `mail ${String(i)}`, responses);
}

/** Answers every request not routed otherwise. Add it last. */
function respondRest(ports: FakePorts, responses: readonly FakeHttpResponse[] = [ok200]): void {
  ports.http.respond(() => true, responses);
}

/** How many times thread `i`'s request was sent. */
function sends(ports: FakePorts, i: number): number {
  return ports.http.batches.flat().filter((r) => subjectOf(r) === `mail ${String(i)}`).length;
}

function runEnd(ports: FakePorts): Record<string, unknown> {
  const events = ports.log.all('run.end');
  expect(events).toHaveLength(1);
  const [event] = events;
  if (event === undefined) throw new Error('no run.end');
  expect(event.level).toBe('info');
  return event.fields;
}

function labelNames(ports: FakePorts, threadId: string): string[] {
  const listed = ports.gmail.listLabels();
  if (!listed.ok) throw new Error('listLabels failed');
  const names = new Map(listed.labels.map((l) => [l.id, l.name]));
  return (ports.gmail.threadLabels(threadId)[0] ?? []).map((id) => names.get(id) ?? id);
}

function methods(ports: FakePorts): string[] {
  return ports.gmail.calls.map((c) => c.method);
}

function strikesOf(ports: FakePorts): Record<string, number> {
  return Object.fromEntries(loadQueue(ports.state).map((i) => [i.threadId, i.strikes]));
}

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

function at<T>(list: readonly T[], i: number): T {
  const value = list[i];
  if (value === undefined) throw new Error(`no element ${String(i)}`);
  return value;
}

/** `n` queued items for threads that don't exist (screening skips them as not found). */
function ghostQueue(n: number): WorkQueue {
  let queue: WorkQueue = [];
  for (let i = 0; i < n; i++) {
    const added = enqueue(queue, {
      threadId: `ghost${String(i)}`,
      source: 'scheduled',
      enqueuedAt: NOW - HOUR_MS + i,
    });
    if (!added.ok) throw new Error('setup: enqueue failed');
    queue = added.queue;
  }
  return queue;
}

/**
 * A world with `manual` real threads queued as manual items (found before the
 * saved position, so ingest doesn't touch them) and `scheduled` new threads
 * for ingest to find.
 */
function mixedWorld(
  manual: number,
  scheduled: number,
): { ports: FakePorts; manualIds: string[]; scheduledIds: string[] } {
  const { ports } = world(0);
  const manualIds: string[] = [];
  for (let i = 0; i < manual; i++) {
    manualIds.push(deliver(ports.gmail, `manual ${String(i)}`));
  }
  ports.state.seedRaw(
    POSITION_KEY,
    JSON.stringify(encodePosition({ historyId: ports.gmail.historyId, savedAt: NOW - HOUR_MS })),
  );
  let queue: WorkQueue = [];
  for (const [i, threadId] of manualIds.entries()) {
    queue = queueWith(queue, threadId, 'manual', i);
  }
  saveQueue(ports.state, queue);
  const scheduledIds: string[] = [];
  for (let i = 0; i < scheduled; i++) {
    scheduledIds.push(deliver(ports.gmail, `mail ${String(i)}`));
  }
  return { ports, manualIds, scheduledIds };
}

function queueWith(
  queue: WorkQueue,
  threadId: string,
  source: WorkItemSource,
  i: number,
): WorkQueue {
  const added = enqueue(queue, { threadId, source, enqueuedAt: NOW - HOUR_MS + i });
  if (!added.ok) throw new Error('setup: enqueue failed');
  return added.queue;
}

/** A hook result with no manual work. */
const NO_SPARE: SpareTimeResult = { counts: {}, queue: [] };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runScheduled: the happy path', () => {
  it('ingests five threads, classifies them in one chunk and logs run.end with every field', () => {
    const { ports, ids } = world(5);
    respondRest(ports);

    const { report } = run(ports);
    const unitsUsed = ports.gmail.unitsUsed;
    const calls = ports.gmail.calls.length;

    expect(ports.http.batches).toHaveLength(1);
    expect(at(ports.http.batches, 0)).toHaveLength(5);
    expect(loadQueue(ports.state)).toEqual([]);
    const fields = runEnd(ports);
    expect(fields).toEqual({
      ingested: 5,
      merged: 0,
      excluded: 0,
      skipped: 0,
      classified: 5,
      struck: 0,
      errored: 0,
      untouched: 0,
      gone: 0,
      sent: 5,
      chunks: 1,
      inputTokens: 5 * FIXTURE_TOKENS,
      queueSize: 0,
      gmailCalls: calls,
      gmailCallsToday: calls,
      gmailUnits: unitsUsed,
      durationMs: 0,
      stopped: 'drained',
      labels: { [NEWS]: 5 },
      moves: {},
      alerts: [],
    });
    expect(report).toEqual({
      summary: {
        ingested: 5,
        merged: 0,
        excluded: 0,
        skipped: 0,
        classified: 5,
        struck: 0,
        errored: 0,
        untouched: 0,
        gone: 0,
        sent: 5,
        chunks: 1,
        inputTokens: 5 * FIXTURE_TOKENS,
        queueSize: 0,
        gmailCalls: calls,
        gmailCallsToday: calls,
        gmailUnits: unitsUsed,
        durationMs: 0,
      },
      stopped: 'drained',
      labels: { [NEWS]: 5 },
      moves: {},
      alerts: [],
    });
    expect(Object.keys(report.summary).length).toBeLessThanOrEqual(20);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    for (const id of ids) {
      expect(labelNames(ports, id)).toContain(NEWS);
    }
  });

  it('counts moves per destination and labels per name', () => {
    const { ports } = world(3);
    respondTo(ports, 1, [answers({ ship: true })]);
    respondRest(ports);

    const { report } = run(ports);

    expect(report.labels).toEqual({ [NEWS]: 2 });
    expect(report.moves).toEqual({ archive: 1 });
    expect(runEnd(ports)).toMatchObject({ labels: { [NEWS]: 2 }, moves: { archive: 1 } });
  });

  it('logs only run.end and the callees’ events', () => {
    const { ports } = world(2);
    respondRest(ports);
    run(ports);
    const own = ports.log.events.map((e) => e.event);
    expect(own.filter((e) => e.startsWith('run.'))).toEqual(['run.end']);
    expect(own).not.toContain('scope_missing');
  });

  it('with an empty queue and no history: drained, no chunk, no Jev call', () => {
    const { ports } = world(0);
    const { report } = run(ports);
    expect(report.stopped).toBe('drained');
    expect(report.summary).toMatchObject({ chunks: 0, ingested: 0, queueSize: 0 });
    expect(ports.http.calls).toEqual([]);
    expect(methods(ports)).toEqual(['listHistory']);
  });
});

describe('runScheduled: the chunk loop', () => {
  it('several chunks: 45 items → 3 chunks, one sendAll each, one listLabels in the run', () => {
    const { ports } = world(45);
    respondRest(ports);

    const { report } = run(ports, { limits: ROOMY });

    expect(report.stopped).toBe('drained');
    expect(report.summary).toMatchObject({ chunks: 3, classified: 45, sent: 45, queueSize: 0 });
    expect(ports.http.batches.map((b) => b.length)).toEqual([20, 20, 5]);
    expect(methods(ports).filter((m) => m === 'listLabels')).toHaveLength(1);
  });

  it('settles each thread at most once per run', () => {
    const { ports, ids } = world(25);
    respondTo(ports, 0, [r503]);
    respondTo(ports, 1, [r429Late]);
    respondRest(ports);

    const { report } = run(ports, { limits: ROOMY });

    // Chunk 1 is threads 0–19, chunk 2 the other five: 0 and 1 are never taken again.
    expect(report.summary).toMatchObject({
      chunks: 2,
      classified: 23,
      struck: 1,
      untouched: 1,
      queueSize: 2,
    });
    expect(report.stopped).toBe('drained');
    expect(sends(ports, 0)).toBe(3);
    expect(sends(ports, 1)).toBe(1);
    expect(at(ports.http.batches, ports.http.batches.length - 1)).toHaveLength(5);
    expect(strikesOf(ports)).toEqual({ [at(ids, 0)]: 1, [at(ids, 1)]: 0 });
    const threadEvents = (id: string) =>
      ports.log.events.filter((e) => e.event.startsWith('thread.') && e.fields.threadId === id);
    expect(threadEvents(at(ids, 0)).map((e) => e.event)).toEqual(['thread.failed']);
    expect(threadEvents(at(ids, 1))).toEqual([]);
  });

  it('deadline: after the first chunk too little time is left, the rest stays queued', () => {
    const limits: RunLimits = {
      softLimitMs: 30_000,
      reserveMs: 10_000,
      chunkSize: 5,
      maxGmailUnitsPerRun: 100_000,
      minChunkStartMs: 7000,
    };
    const { ports } = world(10, { httpLatencyMs: 25_000 });
    respondRest(ports);

    const { report } = run(ports, { limits });

    expect(report.stopped).toBe('deadline');
    expect(report.summary).toMatchObject({ chunks: 1, classified: 5, queueSize: 5 });
    expect(loadQueue(ports.state)).toHaveLength(5);
    expect(runEnd(ports)).toMatchObject({ stopped: 'deadline', durationMs: 25_000 });
  });

  it('deadline: ingest stops when time is up, and no chunk starts', () => {
    const { ports } = world(3);
    saveQueue(ports.state, ghostQueue(1));
    const ctx = context(ports);
    ports.clock.advance(SCHEDULED_10.softLimitMs);

    const report = runScheduled(ctx, scheduledDeps(ports));

    expect(methods(ports)).toEqual([]);
    expect(ports.log.find('ingest.done')?.fields).toMatchObject({ stopped: 'deadline' });
    expect(report.stopped).toBe('deadline');
    expect(report.summary).toMatchObject({ ingested: 0, chunks: 0, queueSize: 1 });
  });

  it('units: the second chunk would pass the run’s Gmail units', () => {
    const { ports } = world(45, { gmailLatencyMs: 0 });
    respondRest(ports);

    const { report } = run(ports, { limits: SCHEDULED_10 });

    expect(report.stopped).toBe('units');
    expect(report.summary).toMatchObject({ chunks: 1, classified: 20, queueSize: 25 });
    expect(report.summary.gmailUnits).toBe(ports.gmail.unitsUsed);
    expect(runEnd(ports)).toMatchObject({ stopped: 'units', gmailUnits: ports.gmail.unitsUsed });
  });

  it('ingest stops at the units cap too', () => {
    const limits: RunLimits = { ...SCHEDULED_10, maxGmailUnitsPerRun: 2 };
    const { ports } = world(150, { gmail: { pageSize: 100 } });
    const { report } = run(ports, { limits });
    expect(methods(ports)).toEqual(['listHistory']);
    expect(ports.log.find('ingest.done')?.fields).toMatchObject({ stopped: 'deadline' });
    expect(report.stopped).toBe('units');
  });
});

describe('runScheduled: the preflight', () => {
  it('missing key, end to end: RunAbortError, run.failed, the auth alert, nothing touched', () => {
    const { ports } = world(3, { jevApiKey: undefined });
    saveQueue(ports.state, ghostQueue(2));
    const before = ports.state.snapshot();
    const { outcome, delivered } = runTrigger(ports);

    const error = caught(outcome);

    expect(error).toBeInstanceOf(RunAbortError);
    expect(error).toMatchObject({ reason: 'missing_key' });
    expect(ports.gmail.calls).toEqual([]);
    expect(ports.http.calls).toEqual([]);
    expect(ports.log.all('run.end')).toEqual([]);
    expect(ports.log.find('run.failed')?.fields).toMatchObject({ reason: 'missing_key' });
    expect(delivered.map((d) => d.conditions)).toEqual([['auth']]);
    const after = ports.state.snapshot();
    const kept = (snapshot: Record<string, string>) =>
      Object.fromEntries(
        Object.entries(snapshot).filter(
          ([key]) => key === POSITION_KEY || key.startsWith('state.queue.'),
        ),
      );
    expect(kept(after)).toEqual(kept(before));
  });

  it('missing gmail.modify: no Gmail call at all, run.end, scope_missing', () => {
    const { ports } = world(3);
    ports.scopes.revoke(GMAIL_MODIFY);

    const { report, collected } = run(ports);

    expect(ports.gmail.calls).toEqual([]);
    expect(ports.http.calls).toEqual([]);
    expect(report.stopped).toBe('gmail_scope_missing');
    expect(runEnd(ports)).toMatchObject({
      stopped: 'gmail_scope_missing',
      alerts: ['scope_missing'],
      gmailCalls: 0,
    });
    expect(collected.missingScopes).toEqual([GMAIL_MODIFY]);
  });

  it('missing script.external_request: ingest runs, no chunk', () => {
    const { ports } = world(3);
    ports.scopes.revoke(EXTERNAL_REQUEST);

    const { report, collected } = run(ports);

    expect(report.stopped).toBe('classify_scope_missing');
    expect(report.summary).toMatchObject({ ingested: 3, chunks: 0, queueSize: 3 });
    expect(methods(ports)).toEqual(['listHistory']);
    expect(ports.http.calls).toEqual([]);
    expect(collected.missingScopes).toEqual([EXTERNAL_REQUEST]);
    expect(report.alerts).toEqual(['scope_missing']);
  });

  it('budget reached: ingest runs, no chunk, budget_reached', () => {
    const { ports } = world(3);
    ports.state.set(BUDGET_KEY, encodeBudget({ day: TODAY, inputTokens: BUDGET }));

    const { report } = run(ports);

    expect(report.stopped).toBe('budget');
    expect(report.summary).toMatchObject({ ingested: 3, chunks: 0, queueSize: 3 });
    expect(methods(ports)).toEqual(['listHistory']);
    expect(ports.http.calls).toEqual([]);
    expect(report.alerts).toEqual(['budget_reached']);
    expect(ports.log.all('budget.reached')).toHaveLength(1);
  });
});

describe('runScheduled: ingest stops', () => {
  it('rate_limited: no chunk', () => {
    const { ports } = world(3);
    ports.gmail.failNext('listHistory', FakeGmail.rateLimited());

    const { report } = run(ports);

    expect(report.stopped).toBe('ingest_rate_limited');
    expect(methods(ports)).toEqual(['listHistory']);
    expect(ports.http.calls).toEqual([]);
    expect(report.alerts).toEqual([]);
  });

  it('scope: scope_missing logged with step ingest, and alerted', () => {
    const { ports } = world(3);
    ports.gmail.failNext('listHistory', {
      ok: false,
      kind: 'scope',
      message: 'Insufficient Permission',
    });

    const { report, collected } = run(ports);

    expect(report.stopped).toBe('ingest_scope');
    expect(ports.http.calls).toEqual([]);
    expect(ports.log.all('scope_missing').map((e) => [e.level, e.fields])).toEqual([
      ['warn', { scope: GMAIL_MODIFY, step: 'ingest', ...SCOPE_FEATURES[GMAIL_MODIFY] }],
    ]);
    expect(collected.conditions).toEqual(['scope_missing']);
    expect(collected.missingScopes).toEqual([GMAIL_MODIFY]);
  });

  it('cap: the queue is full, and chunks still run', () => {
    const { ports } = world(1);
    saveQueue(ports.state, ghostQueue(QUEUE_MAX_ITEMS));

    const { report } = run(ports);

    expect(ports.log.find('ingest.done')?.fields).toMatchObject({ stopped: 'cap' });
    // The ghost items are skipped as not found at screening, making room.
    const chunks = report.summary.chunks ?? 0;
    expect(chunks).toBeGreaterThanOrEqual(1);
    expect(report.summary.skipped).toBe(chunks * SCHEDULED_10.chunkSize);
  });

  it('expired history: history_expired is collected', () => {
    const { ports } = world(0);
    ports.gmail.expireHistoryBefore(Number(ports.gmail.historyId) + 1);
    ports.gmail.setSearchMatcher(() => false);

    const { report, collected } = run(ports);

    expect(collected.conditions).toContain('history_expired');
    expect(report.alerts).toContain('history_expired');
    expect(runEnd(ports).alerts).toContain('history_expired');
  });

  it('a missing position throws StateError missing; through runEntry, run.failed and rethrown', () => {
    const { ports } = world(1, { position: false });
    const { outcome, delivered } = runTrigger(ports);

    const error = caught(outcome);

    expect(error).toBeInstanceOf(StateError);
    expect(error).toMatchObject({ reason: 'missing' });
    expect(ports.log.all('run.end')).toEqual([]);
    expect(ports.log.all('run.failed')).toHaveLength(1);
    expect(delivered).toHaveLength(1);
  });
});

describe('runScheduled: a chunk stops the run', () => {
  it.each<[string, FakeHttpResponse, 'auth' | 'config_invalid']>([
    ['401', wrongKey401, 'auth'],
    ['unknown model', unknownModel400, 'config_invalid'],
  ])(
    '%s mid-run, end to end: the rest applied, the thread unmarked, run.end, then RunAbortError',
    (_name, response, reason) => {
      const { ports, ids } = world(3);
      respondTo(ports, 1, [response]);
      respondRest(ports);
      const { outcome, delivered } = runTrigger(ports);

      const error = caught(outcome);

      expect(error).toBeInstanceOf(RunAbortError);
      expect(error).toMatchObject({ reason: reason });
      expect(labelNames(ports, at(ids, 0))).toContain(NEWS);
      expect(labelNames(ports, at(ids, 2))).toContain(NEWS);
      expect(labelNames(ports, at(ids, 1))).not.toContain(NEWS);
      expect(labelNames(ports, at(ids, 1))).not.toContain(JEV_ERROR_LABEL);
      expect(loadQueue(ports.state).map((i) => [i.threadId, i.strikes])).toEqual([[at(ids, 1), 0]]);
      const order = ports.log.events.map((e) => e.event).filter((e) => e.startsWith('run.'));
      expect(order).toEqual(['run.start', 'run.end', 'run.failed']);
      expect(runEnd(ports)).toMatchObject({ stopped: 'abort', classified: 2, untouched: 1 });
      const runs = decodeRunRecord(ports.state.get(RUNS_KEY));
      expect(runs.consecutiveFailures).toBe(1);
      expect(runs.lastOutcome).toBe('failed');
      expect(delivered.map((d) => d.conditions)).toEqual([[reason]]);
    },
  );

  it('a Gmail rate limit mid-chunk: rate_limited, no further chunk', () => {
    const { ports } = world(25);
    respondRest(ports);
    ports.gmail.failNext('modifyThread', FakeGmail.rateLimited(), { after: 1 });

    const { report } = run(ports, { limits: ROOMY });

    expect(report.stopped).toBe('rate_limited');
    expect(report.summary).toMatchObject({ chunks: 1, classified: 1, untouched: 1 });
    expect(ports.http.batches).toHaveLength(1);
    expect(report.summary.queueSize).toBe(24);
  });

  it('a sender outage: outage, nothing struck, no further chunk', () => {
    const { ports } = world(25);
    respondRest(ports, [r503]);

    const { report } = run(ports, { limits: ROOMY });

    expect(report.stopped).toBe('outage');
    expect(report.summary).toMatchObject({ chunks: 1, struck: 0, classified: 0, queueSize: 25 });
    expect(Object.values(strikesOf(ports))).toEqual(Array.from({ length: 25 }, () => 0));
  });

  it.each<[string, (ports: FakePorts) => RunLimits, RunReport['stopped'], readonly string[]]>([
    [
      'screening meets a missing scope',
      (ports) => {
        ports.gmail.failNext('getThread', {
          ok: false,
          kind: 'scope',
          message: 'Insufficient Permission',
        });
        return ROOMY;
      },
      'scope',
      [GMAIL_MODIFY],
    ],
    [
      'the sender meets a missing scope',
      (ports) => {
        ports.http.failNext('sendAll', { ok: false, kind: 'scope', message: 'no permission' });
        return ROOMY;
      },
      'send_scope',
      [EXTERNAL_REQUEST],
    ],
    [
      'the batch doesn’t fit in the time left',
      () => ({ ...ROOMY, softLimitMs: 4000, minChunkStartMs: 1000 }),
      'send_deadline',
      [],
    ],
    [
      'the sender reaches the budget',
      (ports) => {
        ports.state.set(BUDGET_KEY, encodeBudget({ day: TODAY, inputTokens: BUDGET - 1 }));
        return ROOMY;
      },
      'budget',
      [],
    ],
  ])('%s: the run stops after the chunk', (name, arrange, stopped, scopes) => {
    const { ports } = world(25);
    respondRest(ports);
    const limits = arrange(ports);

    const { report, collected } = run(ports, { limits });

    expect(report.stopped).toBe(stopped);
    // The budget is checked before each batch: the first chunk's batch still goes out.
    expect(report.summary.chunks).toBe(name === 'the sender reaches the budget' ? 2 : 1);
    expect(runEnd(ports).stopped).toBe(stopped);
    expect(collected.missingScopes).toEqual(scopes);
  });

  it('errored: a 422 adds Jev/Error and the errored alert with the thread ID', () => {
    const { ports, ids } = world(3);
    respondTo(ports, 2, [invalid422]);
    respondRest(ports);

    const { report, collected } = run(ports);

    expect(report.summary).toMatchObject({ classified: 2, errored: 1, queueSize: 0 });
    expect(collected.conditions).toEqual(['errored']);
    expect(collected.erroredThreadIds).toEqual([at(ids, 2)]);
    expect(labelNames(ports, at(ids, 2))).toContain(JEV_ERROR_LABEL);
    expect(runEnd(ports)).toMatchObject({ alerts: ['errored'], errored: 1 });
  });
});

describe('runScheduled: the spare-time hook', () => {
  it('is called once when drained with time left, and its counts go under spare', () => {
    const { ports, ids } = world(25);
    respondTo(ports, 0, [r503]);
    respondRest(ports);
    const calls: SpareTimeInput[] = [];
    const spareTime = vi.fn((input: SpareTimeInput) => {
      calls.push(input);
      return { counts: { manualClassified: 2, manualChunks: 1 }, queue: input.queue };
    });

    const { report } = run(ports, { limits: ROOMY, spareTime });

    expect(spareTime).toHaveBeenCalledTimes(1);
    const input = at(calls, 0);
    expect(input.apiKey).toBe(KEY);
    expect(input.queue).toEqual(loadQueue(ports.state));
    expect(input.queue.map((i) => i.threadId)).toEqual([at(ids, 0)]);
    expect([...input.settledThreadIds].sort()).toEqual([...ids].sort());
    expect(typeof input.labels.idFor).toBe('function');
    expect(input.ctx.limits).toBe(ROOMY);
    expect(report.stopped).toBe('drained');
    expect(runEnd(ports).spare).toEqual({ manualClassified: 2, manualChunks: 1 });
    expect(report.summary).not.toHaveProperty('manualClassified');
  });

  it('shares the run’s label cache with the hook (no second listLabels)', () => {
    const { ports } = world(2);
    respondRest(ports);
    const spareTime: SpareTimeHook = ({ labels, queue }) => {
      labels.idFor(NEWS);
      return { counts: {}, queue };
    };
    run(ports, { spareTime });
    expect(methods(ports).filter((m) => m === 'listLabels')).toHaveLength(1);
  });

  it.each<[string, (ports: FakePorts) => void]>([
    [
      'budget',
      (ports) => {
        ports.state.set(BUDGET_KEY, encodeBudget({ day: TODAY, inputTokens: BUDGET }));
      },
    ],
    [
      'rate_limited',
      (ports) => {
        ports.gmail.failNext('modifyThread', FakeGmail.rateLimited());
      },
    ],
  ])('is not called after a stop (%s)', (_name, arrange) => {
    const { ports } = world(2);
    respondRest(ports);
    arrange(ports);
    const spareTime = vi.fn(() => NO_SPARE);
    const { report } = run(ports, { spareTime });
    expect(report.stopped).not.toBe('drained');
    expect(spareTime).not.toHaveBeenCalled();
    expect(runEnd(ports)).not.toHaveProperty('spare');
  });

  it('is not called when drained with no time left', () => {
    const { ports } = world(0);
    const ctx = context(ports);
    ports.clock.advance(SCHEDULED_10.softLimitMs);
    const spareTime = vi.fn(() => NO_SPARE);
    const report = runScheduled(ctx, scheduledDeps(ports, spareTime));
    expect(report.stopped).toBe('drained');
    expect(spareTime).not.toHaveBeenCalled();
  });

  it('takes its queue as the run’s final one, and logs no spare for empty counts', () => {
    const { ports } = world(2);
    respondRest(ports);
    const kept = ghostQueue(3);
    const spareTime: SpareTimeHook = () => ({ counts: {}, queue: kept });

    const { report } = run(ports, { spareTime });

    expect(report.stopped).toBe('drained');
    expect(report.summary.queueSize).toBe(3);
    expect(runEnd(ports)).toMatchObject({ queueSize: 3, stopped: 'drained' });
    expect(runEnd(ports)).not.toHaveProperty('spare');
  });

  it.each<['auth' | 'config_invalid']>([['auth'], ['config_invalid']])(
    'an abort (%s) from the hook gives run.end with stopped abort, then RunAbortError',
    (reason) => {
      const { ports } = world(1);
      respondRest(ports);
      const spareTime: SpareTimeHook = ({ queue }) => ({
        counts: { manualChunks: 1 },
        queue,
        abort: reason,
      });

      const error = thrownBy(() => run(ports, { spareTime }));

      expect(error).toBeInstanceOf(RunAbortError);
      expect(error).toMatchObject({ reason });
      expect(runEnd(ports)).toMatchObject({
        stopped: 'abort',
        classified: 1,
        spare: { manualChunks: 1 },
      });
    },
  );

  it('puts an alert the hook adds in run.end’s alerts', () => {
    const { ports } = world(1);
    respondRest(ports);
    const spareTime: SpareTimeHook = ({ ctx, queue }) => {
      ctx.alerts.add('scope_missing', { scopes: [GMAIL_MODIFY] });
      return { counts: {}, queue };
    };

    const { report, collected } = run(ports, { spareTime });

    expect(collected.conditions).toEqual(['scope_missing']);
    expect(report.alerts).toEqual(['scope_missing']);
    expect(runEnd(ports).alerts).toEqual(['scope_missing']);
  });

  it('lets an exception in the hook propagate, without run.end', () => {
    const { ports, ids } = world(1);
    respondRest(ports);
    const spareTime: SpareTimeHook = () => {
      throw new StateError('boom', { key: 'state.queue', reason: 'parse' });
    };

    expect(thrownBy(() => run(ports, { spareTime }))).toBeInstanceOf(StateError);
    expect(ports.log.all('run.end')).toHaveLength(0);
    expect(labelNames(ports, at(ids, 0))).toContain(NEWS);
  });
});

describe('runScheduled: manual items are left alone', () => {
  it('sends only the scheduled threads and leaves the manual items queued untouched', () => {
    const { ports, manualIds, scheduledIds } = mixedWorld(2, 2);
    respondRest(ports);
    const manualBefore = JSON.stringify(loadQueue(ports.state));

    const { report } = run(ports);

    const sent = ports.http.batches.flat().map(subjectOf).sort();
    expect(sent).toEqual(['mail 0', 'mail 1']);
    expect(report.stopped).toBe('drained');
    expect(report.summary).toMatchObject({ classified: 2, queueSize: 2 });
    const after = loadQueue(ports.state);
    expect(after.map((i) => i.threadId)).toEqual(manualIds);
    expect(JSON.stringify(after)).toBe(manualBefore);
    for (const id of scheduledIds) {
      expect(labelNames(ports, id)).toContain(NEWS);
    }
    for (const id of manualIds) {
      expect(labelNames(ports, id)).not.toContain(NEWS);
    }
  });

  it('sends nothing with only manual items, and still calls the hook', () => {
    const { ports } = mixedWorld(2, 0);
    respondRest(ports);
    const before = JSON.stringify(loadQueue(ports.state));
    const spareTime = vi.fn((input: SpareTimeInput) => ({ counts: {}, queue: input.queue }));

    const { report } = run(ports, { spareTime });

    expect(ports.http.batches).toHaveLength(0);
    expect(report.stopped).toBe('drained');
    expect(report.summary).toMatchObject({ classified: 0, chunks: 0, queueSize: 2 });
    expect(spareTime).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(loadQueue(ports.state))).toBe(before);
  });
});
