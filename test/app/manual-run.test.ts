import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { type CollectedAlerts, createAlertCollector } from '../../src/app/alerts.ts';
import { countGmailCalls } from '../../src/app/counting-gmail.ts';
import { rememberJevErrorLabelId } from '../../src/app/jev-error-label-store.ts';
import { createLabelCache } from '../../src/app/label-cache.ts';
import { loadManualJob, saveManualJob } from '../../src/app/manual-job-store.ts';
import {
  continueManualJob,
  createManualSpareTime,
  type ManualDeps,
  type ManualRunReport,
  runManualJob,
} from '../../src/app/manual-run.ts';
import { loadQueue, saveQueue } from '../../src/app/queue-store.ts';
import { type RunReport, runScheduled, type SpareTimeHook } from '../../src/app/run-controller.ts';
import { type RunContext, runEntry } from '../../src/app/run-entry.ts';
import { loadConfig } from '../../src/config/loader.ts';
import type { Config } from '../../src/config/schema.ts';
import { createDeadline } from '../../src/core/deadline.ts';
import { RunAbortError } from '../../src/core/errors.ts';
import { JEV_ERROR_LABEL } from '../../src/core/label-path.ts';
import { MANUAL_KEY, newManualJob } from '../../src/core/manual-job.ts';
import { encodePosition, POSITION_KEY } from '../../src/core/position.ts';
import {
  decodeRunRecord,
  recordStart,
  recordSuccess,
  RUNS_KEY,
  type RunSummary,
} from '../../src/core/run-record.ts';
import { type RunLimits, runLimits } from '../../src/core/run-limits.ts';
import { SCOPE_FEATURES } from '../../src/core/scope-features.ts';
import { BUDGET_KEY, encodeBudget } from '../../src/core/token-budget.ts';
import { enqueue, type WorkItemSource, type WorkQueue } from '../../src/core/work-queue.ts';
import type { GmailMessage } from '../../src/core/gmail-types.ts';
import type { HttpRequest } from '../../src/ports/http-port.ts';
import { FakeGmail } from '../fakes/fake-gmail.ts';
import { type FakeHttpResponse, jsonPayload } from '../fakes/fake-http.ts';
import { createFakePorts, type FakePorts, type FakePortsOptions } from '../fakes/fake-ports.ts';
import { nodeDecodeUtf8 } from '../fakes/node-utf8.ts';
import ok200 from '../fixtures/jev/200-four-rules.json' with { type: 'json' };
import wrongKey401 from '../fixtures/jev/401-wrong-key.json' with { type: 'json' };

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
/** The job's query: it matches the threads whose subject starts with `old `. */
const JOB_QUERY = 'subject:old-mail';
const EXCLUDE_QUERY = 'from:bank@example.com';
const BANK = 'bank@example.com';

/** Scheduled limits at 10 minutes: soft 30 s, chunk 20, 3,000 units (one full chunk per run). */
const SCHEDULED_10 = runLimits('scheduled', 10);
/** The manual row: 4.5 min, chunk 20, 13,500 units. */
const MANUAL = runLimits('manual', 10);

const ZERO_COUNTS = {
  pages: 0,
  queued: 0,
  merged: 0,
  chunks: 0,
  excluded: 0,
  skipped: 0,
  sent: 0,
  classified: 0,
  struck: 0,
  errored: 0,
  untouched: 0,
  gone: 0,
  inputTokens: 0,
};

/**
 * The four rules of `200-four-rules.json`: in it only `newsletter` fires, so
 * the fixture answer adds `News` and moves nothing. `shipping` is the move
 * rule (archive).
 */
function config(extra: { dailyTokenBudget?: number; excludeQuery?: string } = {}): Config {
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

/** A 200 in which `newsletter` (label `News`) and `shipping` (archive) both fire. */
const newsAndShip: FakeHttpResponse = {
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model: 'jev-1.13.0',
    answers: {
      approval: { type: 'noul', noul: 0.01 },
      bill: { type: 'noul', noul: 0.01 },
      newsletter: { type: 'noul', noul: 0.99 },
      shipping: { type: 'noul', noul: 0.99 },
    },
    usage: { input_tokens: 100 },
  }),
};

/**
 * Retryable, with a short wait: retried to the last attempt, then one strike.
 * (A 503 alone in a batch would be an outage, which strikes nothing.)
 */
const r429: FakeHttpResponse = { status: 429, headers: { 'retry-after': '1' }, body: '' };

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
    // Only `manual.completed` carries the job's query.
    const withoutCompleted = ports.log.events.filter((e) => e.event !== 'manual.completed');
    expect(JSON.stringify(withoutCompleted)).not.toContain(JOB_QUERY);
  }
  worlds = [];
});

function header(message: GmailMessage, name: string): string {
  return message.payload?.headers?.find((h) => h.name === name)?.value ?? '';
}

/** One matcher for both searches: the job's and the chunk's exclusion search. */
function matcher(q: string, message: GmailMessage): boolean {
  if (q === JOB_QUERY) {
    return header(message, 'Subject').startsWith('old ');
  }
  if (q.startsWith(`(${EXCLUDE_QUERY}) `)) {
    return header(message, 'From') === BANK;
  }
  throw new Error('an unexpected search query');
}

function deliver(
  gmail: FakeGmail,
  subject: string,
  options: { readonly from?: string; readonly labelIds?: readonly string[] } = {},
): string {
  return gmail.deliver({
    internalDate: NOW - 10 * 60_000,
    headers: [
      { name: 'From', value: options.from ?? 'friend@example.com' },
      { name: 'Subject', value: subject },
    ],
    bodyText: `${BODY_TEXT} ${subject}`,
    ...(options.labelIds === undefined ? {} : { labelIds: options.labelIds }),
  }).threadId;
}

type SetupOptions = FakePortsOptions & {
  /** Save a job for `JOB_QUERY`. Default true. */
  readonly job?: boolean;
  readonly applyMoves?: boolean;
};

/**
 * Fake ports with `old` threads (subjects `old <i>`) delivered before the
 * saved position, so only the job search finds them, then `fresh` threads
 * (`mail <i>`) for a scheduled run's ingest, and a saved job.
 */
function setup(
  old: number,
  fresh = 0,
  options: SetupOptions = {},
): { ports: FakePorts; oldIds: string[]; freshIds: string[] } {
  const ports = createFakePorts(options);
  worlds.push(ports);
  ports.gmail.setSearchMatcher(matcher);
  const oldIds: string[] = [];
  for (let i = 0; i < old; i++) {
    oldIds.push(deliver(ports.gmail, `old ${String(i)}`));
  }
  ports.state.seedRaw(
    POSITION_KEY,
    JSON.stringify(encodePosition({ historyId: ports.gmail.historyId, savedAt: NOW - HOUR_MS })),
  );
  const freshIds: string[] = [];
  for (let i = 0; i < fresh; i++) {
    freshIds.push(deliver(ports.gmail, `mail ${String(i)}`));
  }
  if (options.job !== false) {
    saveJob(ports, options.applyMoves ?? false);
  }
  return { ports, oldIds, freshIds };
}

function saveJob(ports: FakePorts, applyMoves = false): void {
  saveManualJob(
    ports.state,
    newManualJob({ query: JOB_QUERY, applyMoves, startedAt: NOW - HOUR_MS }),
  );
}

function manualDeps(ports: FakePorts): ManualDeps {
  return {
    http: ports.http,
    state: ports.state,
    log: ports.log,
    clock: ports.clock,
    random: ports.random,
    decodeUtf8: nodeDecodeUtf8,
  };
}

function editorDeps(ports: FakePorts): Parameters<typeof continueManualJob>[1] {
  return { ...manualDeps(ports), secrets: ports.secrets, auth: ports.auth };
}

type RunOptions = { readonly limits?: RunLimits; readonly config?: Config };

/** A `RunContext` built by hand, so a test can choose the limits. */
function context(
  ports: FakePorts,
  limits: RunLimits,
  cfg: Config = config(),
): RunContext & { collected(): CollectedAlerts } {
  const counting = countGmailCalls(ports.gmail);
  const alerts = createAlertCollector();
  return {
    config: cfg,
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

/** One editor run: `continueManualJob` with the manual limits unless told otherwise. */
function editorRun(
  ports: FakePorts,
  options: RunOptions = {},
): { summary: RunSummary; report: ManualRunReport; collected: CollectedAlerts } {
  const ctx = context(ports, options.limits ?? MANUAL, options.config);
  const result = continueManualJob(ctx, editorDeps(ports));
  return { ...result, collected: ctx.collected() };
}

/** One scheduled run with the real spare-time hook. */
function scheduledRun(
  ports: FakePorts,
  options: RunOptions & { readonly spareTime?: SpareTimeHook } = {},
): { report: RunReport; collected: CollectedAlerts } {
  const ctx = context(ports, options.limits ?? SCHEDULED_10, options.config);
  const report = runScheduled(ctx, {
    ...editorDeps(ports),
    spareTime: options.spareTime ?? createManualSpareTime(manualDeps(ports)),
  });
  return { report, collected: ctx.collected() };
}

const payloadSchema = z.object({ state: z.array(z.object({ subject: z.string() })) });

function subjectOf(request: HttpRequest): string {
  return payloadSchema.parse(jsonPayload(request)).state[0]?.subject ?? '';
}

/** Answers the request for the thread with this subject. */
function respondTo(
  ports: FakePorts,
  subject: string,
  responses: readonly FakeHttpResponse[],
): void {
  ports.http.respond((request) => subjectOf(request) === subject, responses);
}

/** Answers every request not routed otherwise. Add it last. */
function respondRest(ports: FakePorts, responses: readonly FakeHttpResponse[] = [ok200]): void {
  ports.http.respond(() => true, responses);
}

/** The subject of every request sent, in order. */
function sentSubjects(ports: FakePorts): string[] {
  return ports.http.batches.flat().map(subjectOf);
}

function fieldsOf(ports: FakePorts, event: string): Record<string, unknown>[] {
  return ports.log.all(event).map((e) => {
    expect(e.level).toBe('info');
    return e.fields;
  });
}

function only<T>(list: readonly T[]): T {
  expect(list).toHaveLength(1);
  return at(list, 0);
}

function at<T>(list: readonly T[], i: number): T {
  const value = list[i];
  if (value === undefined) throw new Error(`no element ${String(i)}`);
  return value;
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

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

function job(ports: FakePorts): NonNullable<ReturnType<typeof loadManualJob>> {
  const loaded = loadManualJob(ports.state);
  if (loaded === undefined) throw new Error('no job');
  return loaded;
}

function queued(
  queue: WorkQueue,
  threadId: string,
  source: WorkItemSource,
  i: number,
  extra: { readonly firstClassification?: boolean } = {},
): WorkQueue {
  const added = enqueue(queue, { threadId, source, enqueuedAt: NOW - HOUR_MS + i, ...extra });
  if (!added.ok) throw new Error('setup: enqueue failed');
  return added.queue;
}

/** `n` queued scheduled items for threads that don't exist. */
function ghostQueue(n: number): WorkQueue {
  let queue: WorkQueue = [];
  for (let i = 0; i < n; i++) {
    queue = queued(queue, `ghost${String(i)}`, 'scheduled', i);
  }
  return queue;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('manual work in a scheduled run’s spare time', () => {
  it('sends every scheduled thread before any manual one, and never mixes a batch', () => {
    const { ports } = setup(30, 5);
    respondRest(ports);

    const { report } = scheduledRun(ports, { limits: MANUAL });

    const batches = ports.http.batches.map((batch) => batch.map(subjectOf));
    expect(at(batches, 0).sort()).toEqual(['mail 0', 'mail 1', 'mail 2', 'mail 3', 'mail 4']);
    for (const batch of batches) {
      const kinds = new Set(batch.map((subject) => subject.split(' ')[0]));
      expect(kinds.size).toBe(1);
    }
    const sent = sentSubjects(ports);
    const lastScheduled = sent.map((subject) => subject.startsWith('mail ')).lastIndexOf(true);
    const firstManual = sent.findIndex((subject) => subject.startsWith('old '));
    expect(lastScheduled).toBe(4);
    expect(firstManual).toBe(5);
    expect(sent).toHaveLength(35);

    // The run's own counts stay scheduled-only; the job's are under `spare`.
    expect(report.stopped).toBe('drained');
    expect(report.summary).toMatchObject({ classified: 5, chunks: 1, queueSize: 0 });
    expect(only(fieldsOf(ports, 'run.end')).spare).toEqual({
      ...ZERO_COUNTS,
      pages: 1,
      queued: 30,
      chunks: 2,
      sent: 30,
      classified: 30,
      inputTokens: 30 * FIXTURE_TOKENS,
    });
    expect(ports.state.get(MANUAL_KEY)).toBeUndefined();
  });

  it('a scheduled backlog starves nothing: the hook isn’t called, no manual thread is sent, no job search is made', () => {
    const { ports } = setup(3, 45);
    respondRest(ports);
    const before = ports.state.get(MANUAL_KEY);
    const spareTime = vi.fn(createManualSpareTime(manualDeps(ports)));

    const { report } = scheduledRun(ports, { spareTime });

    expect(['deadline', 'units']).toContain(report.stopped);
    expect(spareTime).not.toHaveBeenCalled();
    expect(sentSubjects(ports).filter((subject) => subject.startsWith('old '))).toEqual([]);
    expect(ports.gmail.searches).toEqual([]);
    expect(ports.state.get(MANUAL_KEY)).toEqual(before);
    expect(ports.log.all('manual.progress')).toEqual([]);
    expect(only(fieldsOf(ports, 'run.end'))).not.toHaveProperty('spare');
  });

  it('is small: with the scheduled limits one run does one manual chunk of 20 and the job stays active', () => {
    const { ports } = setup(45);
    respondRest(ports);

    const { report } = scheduledRun(ports);

    expect(ports.http.batches.map((batch) => batch.length)).toEqual([20]);
    expect(report.stopped).toBe('drained');
    expect(report.summary).toMatchObject({ classified: 0, chunks: 0, queueSize: 25 });
    expect(only(fieldsOf(ports, 'run.end')).spare).toMatchObject({
      pages: 1,
      queued: 45,
      chunks: 1,
      classified: 20,
    });
    expect(only(fieldsOf(ports, 'manual.progress'))).toMatchObject({
      stopped: 'units',
      manualQueued: 25,
      searchDone: true,
      seen: 45,
      executions: 1,
      totalClassified: 20,
    });
    expect(job(ports)).toMatchObject({ executions: 1, searchDone: true });
    expect(job(ports).counts).toMatchObject({ classified: 20, chunks: 1 });
    expect(loadQueue(ports.state).every((item) => item.source === 'manual')).toBe(true);
  });

  it('with no job: nothing is logged or written, and run.end has no spare', () => {
    const { ports } = setup(3, 2, { job: false });
    saveQueue(ports.state, queued([], 'stray1', 'manual', 0));
    respondRest(ports);

    const { report } = scheduledRun(ports);

    expect(report.summary).toMatchObject({ classified: 2, queueSize: 1 });
    expect(only(fieldsOf(ports, 'run.end'))).not.toHaveProperty('spare');
    expect(ports.log.events.filter((e) => e.event.startsWith('manual.'))).toEqual([]);
    expect(ports.gmail.searches).toEqual([]);
    expect(ports.state.get(MANUAL_KEY)).toBeUndefined();
    // A stray manual item with no job stays queued.
    expect(loadQueue(ports.state).map((item) => item.threadId)).toEqual(['stray1']);
  });
});

describe('a whole job in editor runs', () => {
  it('queues the pages, processes three chunks and completes: progress, completed, the job deleted', () => {
    const { ports, oldIds } = setup(45, 0, { gmail: { maxSearchPageSize: 20 } });
    respondRest(ports);

    const { summary, report } = editorRun(ports);

    expect(ports.http.batches.map((batch) => batch.length)).toEqual([20, 20, 5]);
    expect(report).toEqual({ job: 'completed', stopped: 'completed', alerts: [] });
    const counts = {
      ...ZERO_COUNTS,
      pages: 3,
      queued: 45,
      chunks: 3,
      sent: 45,
      classified: 45,
      inputTokens: 45 * FIXTURE_TOKENS,
    };
    const numbers = {
      ...counts,
      queueSize: 0,
      gmailCalls: ports.gmail.calls.length,
      gmailCallsToday: ports.gmail.calls.length,
      gmailUnits: ports.gmail.unitsUsed,
      durationMs: 0,
    };
    expect(summary).toEqual(numbers);
    expect(only(fieldsOf(ports, 'run.end'))).toEqual({
      ...numbers,
      stopped: 'completed',
      job: 'completed',
      alerts: [],
    });

    const manualEvents = ports.log.events
      .map((e) => e.event)
      .filter((event) => event.startsWith('manual.') || event === 'run.end');
    expect(manualEvents).toEqual(['manual.progress', 'manual.completed', 'run.end']);
    expect(only(fieldsOf(ports, 'manual.progress'))).toEqual({
      ...counts,
      stopped: 'completed',
      manualQueued: 0,
      searchDone: true,
      seen: 45,
      executions: 1,
      totalClassified: 45,
      totalErrored: 0,
      totalExcluded: 0,
      totalSkipped: 0,
    });
    const completed = only(fieldsOf(ports, 'manual.completed'));
    expect(completed).not.toHaveProperty('untouched');
    expect({ ...completed, untouched: 0 }).toEqual({
      ...counts,
      query: JOB_QUERY,
      applyMoves: false,
      startedAt: NOW - HOUR_MS,
      durationMs: HOUR_MS,
      executions: 1,
      labels: { [NEWS]: 45 },
      moves: {},
      otherLabels: 0,
      otherMoves: 0,
    });

    expect(ports.state.get(MANUAL_KEY)).toBeUndefined();
    expect(loadQueue(ports.state)).toEqual([]);
    expect(ports.gmail.searches).toEqual([JOB_QUERY, JOB_QUERY, JOB_QUERY]);
    expect(methods(ports).filter((m) => m === 'listLabels')).toHaveLength(1);
    for (const id of oldIds) {
      expect(labelNames(ports, id)).toContain(NEWS);
    }
  });

  it('a job that matches nothing completes in its first execution with zero counts', () => {
    const { ports } = setup(0);

    const { report } = editorRun(ports);

    expect(report).toEqual({ job: 'completed', stopped: 'completed', alerts: [] });
    expect(only(fieldsOf(ports, 'manual.progress'))).toMatchObject({
      ...ZERO_COUNTS,
      pages: 1,
      stopped: 'completed',
      executions: 1,
    });
    expect(only(fieldsOf(ports, 'manual.completed'))).toMatchObject({
      queued: 0,
      classified: 0,
      chunks: 0,
      executions: 1,
      labels: {},
      moves: {},
    });
    expect(ports.state.get(MANUAL_KEY)).toBeUndefined();
    expect(methods(ports)).toEqual(['searchThreadIds']);
    expect(ports.http.calls).toEqual([]);
  });

  it('counts one more execution and logs one manual.progress per execution with a job', () => {
    const { ports } = setup(65);
    respondRest(ports);

    for (const [executions, classified] of [
      [1, 20],
      [2, 40],
    ] as const) {
      const { report } = editorRun(ports, { limits: SCHEDULED_10 });
      expect(report).toMatchObject({ job: 'active', stopped: 'units' });
      expect(job(ports).executions).toBe(executions);
      expect(fieldsOf(ports, 'manual.progress')).toHaveLength(executions);
      expect(at(fieldsOf(ports, 'manual.progress'), executions - 1)).toMatchObject({
        executions,
        classified: 20,
        totalClassified: classified,
      });
    }
    const { report } = editorRun(ports, { limits: SCHEDULED_10 });

    expect(report.job).toBe('completed');
    expect(fieldsOf(ports, 'manual.progress')).toHaveLength(3);
    expect(only(fieldsOf(ports, 'manual.completed'))).toMatchObject({
      executions: 3,
      classified: 65,
      chunks: 4,
      pages: 1,
    });
    // Only the first execution searched: the search was done after one page.
    expect(ports.gmail.searches).toEqual([JOB_QUERY]);
  });
});

describe('what screening and the decision do for manual items', () => {
  it('never sends a thread with Jev/Error: skipped, dequeued, counted for the job', () => {
    const { ports } = setup(1);
    const errored = deliver(ports.gmail, 'old errored', { labelIds: ['INBOX', 'Label_9'] });
    rememberJevErrorLabelId(ports.state, 'Label_9');
    respondRest(ports);

    const { report } = editorRun(ports);

    expect(sentSubjects(ports)).toEqual(['old 0']);
    expect(ports.log.all('thread.skipped').map((e) => e.fields)).toEqual([
      { threadId: errored, source: 'manual', reason: 'jev_error' },
    ]);
    expect(report.job).toBe('completed');
    expect(only(fieldsOf(ports, 'manual.completed'))).toMatchObject({
      queued: 2,
      skipped: 1,
      sent: 1,
      classified: 1,
    });
    expect(loadQueue(ports.state)).toEqual([]);
    expect(labelNames(ports, errored)).not.toContain(NEWS);
  });

  it('never sends a thread with an excluded message, and the job search never holds excludeQuery', () => {
    const { ports } = setup(2);
    const excluded = deliver(ports.gmail, 'old from the bank', { from: BANK });
    respondRest(ports);

    const { report } = editorRun(ports, { config: config({ excludeQuery: EXCLUDE_QUERY }) });

    expect(sentSubjects(ports).sort()).toEqual(['old 0', 'old 1']);
    expect(ports.log.all('thread.excluded').map((e) => e.fields)).toEqual([
      { threadId: excluded, source: 'manual', reason: 'matched' },
    ]);
    expect(report.job).toBe('completed');
    expect(only(fieldsOf(ports, 'manual.completed'))).toMatchObject({
      queued: 3,
      excluded: 1,
      sent: 2,
      classified: 2,
    });
    expect(labelNames(ports, excluded)).not.toContain(NEWS);

    // The job search is the job's query exactly; the exclusion is screening's own search.
    const exclusionSearches = ports.gmail.searches.filter((q) => q.includes(EXCLUDE_QUERY));
    const jobSearches = ports.gmail.searches.filter((q) => !q.includes(EXCLUDE_QUERY));
    expect(exclusionSearches).toHaveLength(1);
    expect(at(exclusionSearches, 0).startsWith(`(${EXCLUDE_QUERY}) `)).toBe(true);
    expect(jobSearches).toEqual([JOB_QUERY]);
    const manualEvents = ports.log.events.filter((e) => e.event.startsWith('manual.'));
    expect(manualEvents.length).toBeGreaterThan(0);
    expect(JSON.stringify(manualEvents)).not.toContain(EXCLUDE_QUERY);
  });

  it.each<[boolean]>([[false], [true]])(
    'applies a firing move only with applyMoves (applyMoves: %s)',
    (applyMoves) => {
      const { ports, oldIds } = setup(2, 0, { applyMoves });
      respondTo(ports, 'old 0', [newsAndShip]);
      respondTo(ports, 'old 1', [r429]);

      const { report } = editorRun(ports);

      const labels = labelNames(ports, at(oldIds, 0));
      expect(labels).toContain(NEWS);
      expect(labels.includes('INBOX')).toBe(!applyMoves);
      expect(job(ports).labels).toEqual({ [NEWS]: 1 });
      expect(job(ports).moves).toEqual(applyMoves ? { archive: 1 } : {});
      // The struck item is still queued: screening fixed its flag to false.
      expect(report).toMatchObject({ job: 'active', stopped: 'waiting' });
      const item = only(loadQueue(ports.state));
      expect(item).toMatchObject({
        threadId: at(oldIds, 1),
        source: 'manual',
        strikes: 1,
        firstClassification: false,
      });
      expect(item.applyMoves).toBe(applyMoves ? true : undefined);
    },
  );

  it('leaves a thread that merged into a scheduled item to the next scheduled run, with the job’s applyMoves', () => {
    const { ports, oldIds } = setup(2, 0, { applyMoves: true });
    const merged = at(oldIds, 0);
    saveQueue(ports.state, queued([], merged, 'scheduled', 0, { firstClassification: false }));
    respondTo(ports, 'old 0', [newsAndShip]);
    respondRest(ports);

    const { report, summary } = editorRun(ports);

    // The editor run takes no scheduled item, and completes without it.
    expect(sentSubjects(ports)).toEqual(['old 1']);
    expect(report.job).toBe('completed');
    expect(summary.queueSize).toBe(1);
    expect(only(fieldsOf(ports, 'manual.completed'))).toMatchObject({
      queued: 1,
      merged: 1,
      sent: 1,
      classified: 1,
      labels: { [NEWS]: 1 },
      moves: {},
    });
    expect(only(loadQueue(ports.state))).toMatchObject({
      threadId: merged,
      source: 'scheduled',
      strikes: 0,
      firstClassification: false,
      applyMoves: true,
    });
    expect(labelNames(ports, merged)).toContain('INBOX');

    const scheduled = scheduledRun(ports);

    expect(sentSubjects(ports)).toEqual(['old 1', 'old 0']);
    expect(scheduled.report.summary).toMatchObject({ classified: 1, queueSize: 0 });
    expect(scheduled.report.moves).toEqual({ archive: 1 });
    expect(labelNames(ports, merged)).toContain(NEWS);
    expect(labelNames(ports, merged)).not.toContain('INBOX');
  });
});

describe('each thread is settled at most once per execution', () => {
  it('strikes a failing thread once per execution, waits, and completes when it gets Jev/Error', () => {
    const { ports, oldIds } = setup(1);
    const threadId = at(oldIds, 0);
    respondRest(ports, [r429]);

    for (const strikes of [1, 2]) {
      const { report } = editorRun(ports);
      expect(report).toEqual({ job: 'active', stopped: 'waiting', alerts: [] });
      expect(sentSubjects(ports)).toHaveLength(strikes * 3);
      expect(only(loadQueue(ports.state))).toMatchObject({ threadId, strikes });
      expect(at(fieldsOf(ports, 'manual.progress'), strikes - 1)).toMatchObject({
        chunks: 1,
        struck: 1,
        stopped: 'waiting',
        manualQueued: 1,
        executions: strikes,
      });
      expect(job(ports)).toMatchObject({ executions: strikes, searchDone: true });
    }

    const { report, collected } = editorRun(ports);

    expect(report).toEqual({ job: 'completed', stopped: 'completed', alerts: ['errored'] });
    expect(collected.erroredThreadIds).toEqual([threadId]);
    expect(sentSubjects(ports)).toHaveLength(9);
    expect(labelNames(ports, threadId)).toContain(JEV_ERROR_LABEL);
    expect(loadQueue(ports.state)).toEqual([]);
    expect(only(fieldsOf(ports, 'manual.completed'))).toMatchObject({
      executions: 3,
      chunks: 3,
      struck: 2,
      errored: 1,
      classified: 0,
    });
    expect(ports.state.get(MANUAL_KEY)).toBeUndefined();
  });
});

describe('what stops an execution', () => {
  /** The job is saved, counted once, and still there. */
  function expectActive(ports: FakePorts, report: ManualRunReport, stopped: string): void {
    expect(report.job).toBe('active');
    expect(report.stopped).toBe(stopped);
    expect(job(ports).executions).toBe(1);
    expect(only(fieldsOf(ports, 'manual.progress'))).toMatchObject({ stopped, executions: 1 });
    expect(only(fieldsOf(ports, 'run.end'))).toMatchObject({ stopped, job: 'active' });
    expect(ports.log.all('manual.completed')).toEqual([]);
  }

  it('the refill’s rate limit: rate_limited, nothing queued', () => {
    const { ports } = setup(3);
    ports.gmail.failNext('searchThreadIds', FakeGmail.rateLimited());

    const { report } = editorRun(ports);

    expectActive(ports, report, 'rate_limited');
    expect(report.alerts).toEqual([]);
    expect(ports.http.calls).toEqual([]);
    expect(loadQueue(ports.state)).toEqual([]);
    expect(ports.log.all('scope_missing')).toEqual([]);
  });

  it('the refill’s missing scope: scope, one scope_missing with step manual_search, and the alert', () => {
    const { ports } = setup(3);
    ports.gmail.failNext('searchThreadIds', {
      ok: false,
      kind: 'scope',
      message: 'Insufficient Permission',
    });

    const { report, collected } = editorRun(ports);

    expectActive(ports, report, 'scope');
    expect(ports.log.all('scope_missing').map((e) => [e.level, e.fields])).toEqual([
      ['warn', { scope: GMAIL_MODIFY, step: 'manual_search', ...SCOPE_FEATURES[GMAIL_MODIFY] }],
    ]);
    expect(report.alerts).toEqual(['scope_missing']);
    expect(collected.missingScopes).toEqual([GMAIL_MODIFY]);
    expect(ports.http.calls).toEqual([]);
  });

  it('a chunk’s rate limit: rate_limited, no further chunk', () => {
    const { ports } = setup(25);
    respondRest(ports);
    ports.gmail.failNext('modifyThread', FakeGmail.rateLimited(), { after: 1 });

    const { report, summary } = editorRun(ports);

    expectActive(ports, report, 'rate_limited');
    expect(ports.http.batches).toHaveLength(1);
    expect(summary).toMatchObject({ chunks: 1, classified: 1, untouched: 1, queueSize: 24 });
    expect(job(ports).counts).toMatchObject({ chunks: 1, classified: 1 });
  });

  it('the budget reached mid-run: budget, and the alert', () => {
    const { ports } = setup(25);
    ports.state.set(BUDGET_KEY, encodeBudget({ day: TODAY, inputTokens: BUDGET - 1 }));
    respondRest(ports);

    const { report, summary } = editorRun(ports);

    expectActive(ports, report, 'budget');
    // The budget is checked before each batch: the first chunk's batch still goes out.
    expect(ports.http.batches.map((batch) => batch.length)).toEqual([20]);
    expect(summary).toMatchObject({ chunks: 2, classified: 20, untouched: 5, queueSize: 5 });
    expect(report.alerts).toEqual(['budget_reached']);
  });

  it('too little time for the next chunk: deadline', () => {
    const limits: RunLimits = {
      softLimitMs: 30_000,
      reserveMs: 10_000,
      chunkSize: 5,
      maxGmailUnitsPerRun: 100_000,
      minChunkStartMs: 7000,
    };
    const { ports } = setup(10, 0, { httpLatencyMs: 25_000 });
    respondRest(ports);

    const { report, summary } = editorRun(ports, { limits });

    expectActive(ports, report, 'deadline');
    expect(summary).toMatchObject({ chunks: 1, classified: 5, queueSize: 5, durationMs: 25_000 });
  });

  it('too few Gmail units for the next chunk: units', () => {
    const { ports } = setup(45);
    respondRest(ports);

    const { report, summary } = editorRun(ports, { limits: SCHEDULED_10 });

    expectActive(ports, report, 'units');
    expect(summary).toMatchObject({ chunks: 1, classified: 20, queueSize: 25 });
  });

  it('no time for a page: deadline, no Gmail call', () => {
    const { ports } = setup(3);
    const ctx = context(ports, MANUAL);
    ports.clock.advance(MANUAL.softLimitMs);

    const { report } = continueManualJob(ctx, editorDeps(ports));

    expectActive(ports, report, 'deadline');
    expect(ports.gmail.calls).toEqual([]);
  });

  it('no Gmail units for a page: units, no Gmail call', () => {
    const { ports } = setup(3);

    const { report } = editorRun(ports, { limits: { ...MANUAL, maxGmailUnitsPerRun: 9 } });

    expectActive(ports, report, 'units');
    expect(ports.gmail.calls).toEqual([]);
  });

  it('no room to queue a page and no manual item: queue_full, the scheduled items untouched', () => {
    const { ports } = setup(3);
    const scheduled = ghostQueue(901);
    saveQueue(ports.state, scheduled);

    const { report, summary } = editorRun(ports);

    expectActive(ports, report, 'queue_full');
    expect(ports.gmail.calls).toEqual([]);
    expect(ports.http.calls).toEqual([]);
    expect(summary.queueSize).toBe(901);
    expect(loadQueue(ports.state)).toEqual(scheduled);
    expect(job(ports)).toMatchObject({ searchDone: false, cursor: { seen: 0 } });
  });
});

describe('a refused key on a manual chunk', () => {
  function arrange(): { ports: FakePorts; oldIds: string[] } {
    const world = setup(3);
    respondTo(world.ports, 'old 1', [wrongKey401]);
    respondRest(world.ports);
    return world;
  }

  function expectKept(ports: FakePorts, oldIds: readonly string[]): void {
    expect(job(ports)).toMatchObject({ executions: 1 });
    expect(job(ports).counts).toMatchObject({ classified: 2, chunks: 1 });
    expect(loadQueue(ports.state).map((item) => [item.threadId, item.strikes])).toEqual([
      [at(oldIds, 1), 0],
    ]);
    expect(labelNames(ports, at(oldIds, 0))).toContain(NEWS);
    expect(labelNames(ports, at(oldIds, 1))).not.toContain(JEV_ERROR_LABEL);
  }

  it('runManualJob returns abort and never throws it', () => {
    const { ports, oldIds } = arrange();
    const ctx = context(ports, MANUAL);

    const result = runManualJob(ctx, manualDeps(ports), {
      labels: createLabelCache({ gmail: ctx.gmail, log: ports.log }),
      apiKey: KEY,
      queue: loadQueue(ports.state),
      taken: new Set(),
    });

    expect(result).toMatchObject({ job: 'active', stopped: 'abort', abort: 'auth' });
    expect(result.counts).toMatchObject({ classified: 2, untouched: 1, chunks: 1 });
    expect(result.queue).toEqual(loadQueue(ports.state));
    expect(ports.log.all('run.end')).toEqual([]);
    expect(only(fieldsOf(ports, 'manual.progress'))).toMatchObject({ stopped: 'abort' });
    expectKept(ports, oldIds);
  });

  it('continueManualJob logs run.end, then throws RunAbortError', () => {
    const { ports, oldIds } = arrange();

    const error = thrownBy(() => editorRun(ports));

    expect(error).toBeInstanceOf(RunAbortError);
    expect(error).toMatchObject({ reason: 'auth' });
    expect(only(fieldsOf(ports, 'run.end'))).toMatchObject({
      stopped: 'abort',
      job: 'active',
      classified: 2,
      untouched: 1,
      queueSize: 1,
    });
    expect(at(ports.log.events, ports.log.events.length - 1).event).toBe('run.end');
    expectKept(ports, oldIds);
  });

  it('through the hook, runScheduled logs run.end with stopped abort, then throws', () => {
    const { ports, oldIds } = arrange();

    const error = thrownBy(() => scheduledRun(ports));

    expect(error).toBeInstanceOf(RunAbortError);
    expect(error).toMatchObject({ reason: 'auth' });
    const end = only(fieldsOf(ports, 'run.end'));
    expect(end).toMatchObject({ stopped: 'abort', classified: 0, queueSize: 1 });
    expect(end.spare).toMatchObject({ classified: 2, untouched: 1 });
    expectKept(ports, oldIds);
  });
});

describe('continueManualJob', () => {
  it('a missing key throws RunAbortError before anything else, and the job stays', () => {
    const { ports } = setup(3, 0, { jevApiKey: undefined });
    const before = ports.state.snapshot();

    const error = thrownBy(() => editorRun(ports));

    expect(error).toBeInstanceOf(RunAbortError);
    expect(error).toMatchObject({ reason: 'missing_key' });
    expect(ports.state.snapshot()).toEqual(before);
    expect(ports.state.get(MANUAL_KEY)).toBeDefined();
    expect(ports.gmail.calls).toEqual([]);
    expect(ports.http.calls).toEqual([]);
    expect(ports.log.all('run.end')).toEqual([]);
  });

  it('with no job: one run.end with stopped no_job, and a normal return', () => {
    const { ports } = setup(3, 0, { job: false });
    saveQueue(ports.state, ghostQueue(2));

    const { summary, report } = editorRun(ports);

    expect(report).toEqual({ job: 'none', stopped: 'no_job', alerts: [] });
    const numbers = {
      ...ZERO_COUNTS,
      queueSize: 2,
      gmailCalls: 0,
      gmailCallsToday: 0,
      gmailUnits: 0,
      durationMs: 0,
    };
    expect(summary).toEqual(numbers);
    expect(only(fieldsOf(ports, 'run.end'))).toEqual({
      ...numbers,
      stopped: 'no_job',
      job: 'none',
      alerts: [],
    });
    expect(ports.log.events.map((e) => e.event)).toEqual(['run.end']);
    expect(ports.gmail.calls).toEqual([]);
    expect(ports.state.get(MANUAL_KEY)).toBeUndefined();
  });

  it('without gmail.modify: no Gmail call at all', () => {
    const { ports } = setup(3);
    ports.scopes.revoke(GMAIL_MODIFY);
    const before = ports.state.get(MANUAL_KEY);

    const { report, collected } = editorRun(ports);

    expect(report).toEqual({
      job: 'active',
      stopped: 'gmail_scope_missing',
      alerts: ['scope_missing'],
    });
    expect(collected.missingScopes).toEqual([GMAIL_MODIFY]);
    expect(ports.gmail.calls).toEqual([]);
    expect(ports.http.calls).toEqual([]);
    expect(only(fieldsOf(ports, 'run.end'))).toMatchObject({
      ...ZERO_COUNTS,
      stopped: 'gmail_scope_missing',
      job: 'active',
      gmailCalls: 0,
    });
    expect(ports.state.get(MANUAL_KEY)).toEqual(before);
    expect(ports.log.all('manual.progress')).toEqual([]);
  });

  it.each<[string, (ports: FakePorts) => void, string]>([
    [
      'classify_scope_missing',
      (ports) => {
        ports.scopes.revoke(EXTERNAL_REQUEST);
      },
      'scope_missing',
    ],
    [
      'budget',
      (ports) => {
        ports.state.set(BUDGET_KEY, encodeBudget({ day: TODAY, inputTokens: BUDGET }));
      },
      'budget_reached',
    ],
  ])('%s: no search and no send', (stopped, arrange, alert) => {
    const { ports } = setup(3);
    arrange(ports);
    const before = ports.state.get(MANUAL_KEY);

    const { report } = editorRun(ports);

    expect(report).toEqual({ job: 'active', stopped, alerts: [alert] });
    expect(ports.gmail.calls).toEqual([]);
    expect(ports.http.calls).toEqual([]);
    expect(only(fieldsOf(ports, 'run.end'))).toMatchObject({ ...ZERO_COUNTS, stopped });
    expect(ports.state.get(MANUAL_KEY)).toEqual(before);
    expect(ports.log.all('manual.progress')).toEqual([]);
  });

  it('does manual work only: no listHistory, the position kept, scheduled items untouched and unsent', () => {
    const { ports, freshIds } = setup(3, 2);
    let scheduled: WorkQueue = [];
    for (const [i, threadId] of freshIds.entries()) {
      scheduled = queued(scheduled, threadId, 'scheduled', i);
    }
    saveQueue(ports.state, scheduled);
    const position = ports.state.get(POSITION_KEY);
    respondRest(ports);

    const { report, summary } = editorRun(ports);

    expect(report.job).toBe('completed');
    expect(methods(ports)).not.toContain('listHistory');
    expect(ports.state.get(POSITION_KEY)).toEqual(position);
    expect(sentSubjects(ports).sort()).toEqual(['old 0', 'old 1', 'old 2']);
    expect(loadQueue(ports.state)).toEqual(scheduled);
    expect(summary.queueSize).toBe(2);
    for (const id of freshIds) {
      expect(labelNames(ports, id)).not.toContain(NEWS);
    }
  });

  it('returns a summary of numbers only that the run record accepts', () => {
    const { ports } = setup(3);
    respondRest(ports);

    const { summary } = editorRun(ports);

    expect(Object.keys(summary)).toHaveLength(18);
    expect(Object.values(summary).every((value) => Number.isSafeInteger(value))).toBe(true);
    const record = recordSuccess(recordStart(undefined, NOW), NOW, summary);
    expect(record.lastSummary).toEqual(summary);
  });

  it('through runEntry with kind manual: the manual limits, and state.runs records ok', () => {
    const { ports } = setup(45);
    respondRest(ports);

    const result = runEntry(
      { entry: 'continueManualRun', kind: 'manual', heartbeat: true, tallyGmail: true },
      {
        lock: ports.lock,
        clock: ports.clock,
        state: ports.state,
        log: ports.log,
        gmail: ports.gmail,
        alertSink: { deliver: () => undefined },
        loadConfig: () => config(),
      },
      (ctx) => continueManualJob(ctx, editorDeps(ports)),
    );

    if ('skipped' in result) throw new Error('the lock was busy');
    expect(result.report).toEqual({ job: 'completed', stopped: 'completed', alerts: [] });
    expect(ports.log.find('run.start')?.fields).toMatchObject({
      kind: 'manual',
      softLimitMs: MANUAL.softLimitMs,
    });
    const runs = decodeRunRecord(ports.state.get(RUNS_KEY));
    expect(runs.lastOutcome).toBe('ok');
    expect(runs.lastSummary).toEqual(result.summary);
    expect(result.summary).toMatchObject({ chunks: 3, classified: 45, queueSize: 0 });
    expect(ports.log.all('run.failed')).toEqual([]);
  });
});
