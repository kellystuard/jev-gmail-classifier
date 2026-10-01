/**
 * The log contract, end to end (Solution Design §10.5; epic #15 decision 5;
 * task #143): one run over the fakes logs `thread.classified` and `run.end`
 * with exactly the fields the SD lists, every event it logs is in the catalog
 * at an allowed level, and the real log adapter writes the reserved keys first.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { GasLogAdapter } from '../../src/adapters/gas/gas-log-adapter.ts';
import { saveManualJob } from '../../src/app/manual-job-store.ts';
import { continueManualJob, type ManualRunReport } from '../../src/app/manual-run.ts';
import { type RunReport, runScheduled } from '../../src/app/run-controller.ts';
import { runEntry } from '../../src/app/run-entry.ts';
import { loadConfig } from '../../src/config/loader.ts';
import type { Config } from '../../src/config/schema.ts';
import { decodeGmailCalls, encodeGmailCalls, GMAIL_CALLS_KEY } from '../../src/core/gmail-calls.ts';
import type { GmailMessage } from '../../src/core/gmail-types.ts';
import { isLogEventName, LOG_EVENT_LEVELS, type LogEventLevel } from '../../src/core/log-events.ts';
import { newManualJob } from '../../src/core/manual-job.ts';
import { encodePosition, POSITION_KEY } from '../../src/core/position.ts';
import { JEV_LIMIT_TOKENS } from '../../src/core/token-estimate.ts';
import type { LogPort } from '../../src/ports/log-port.ts';
import type { FakeHttpResponse } from '../fakes/fake-http.ts';
import type { LoggedEvent } from '../fakes/fake-log.ts';
import { createFakePorts, type FakePorts, type FakePortsOptions } from '../fakes/fake-ports.ts';
import { nodeDecodeUtf8 } from '../fakes/node-utf8.ts';

const HOUR_MS = 3_600_000;
const NEWS = 'News';
const REQUEST_ID = 'req_01a0f0a817707d35a24d604207bb0e52';
const MODEL = 'jev-1.13.0';
const TOKENS = 580;
const BODY_TEXT = 'the private body of';
const KEY = 'test-key';
const JOB_QUERY = 'subject:old-mail';
const RULE_IDS = ['approval', 'bill', 'newsletter', 'shipping', 'password'];

/** The keys of `thread.classified` with no optional field but `subject`, `from` and `requestId`. */
const CLASSIFIED_KEYS = [
  'threadId',
  'source',
  'subject',
  'from',
  'probabilities',
  'fired',
  'actions',
  'requestId',
  'model',
  'inputTokens',
];

const EXECUTION_COUNTS = [
  'pages',
  'queued',
  'merged',
  'chunks',
  'excluded',
  'skipped',
  'sent',
  'classified',
  'struck',
  'errored',
  'untouched',
  'gone',
  'inputTokens',
];

const GMAIL_KEYS = ['gmailCalls', 'gmailCallsToday', 'gmailUnits'];

/** `run.end` of a scheduled run with no spare-time work: 21 keys. */
const SCHEDULED_RUN_END_KEYS = [
  'ingested',
  'merged',
  'excluded',
  'skipped',
  'classified',
  'struck',
  'errored',
  'untouched',
  'gone',
  'sent',
  'chunks',
  'inputTokens',
  'queueSize',
  ...GMAIL_KEYS,
  'durationMs',
  'stopped',
  'labels',
  'moves',
  'alerts',
];

/** `run.end` of a manual editor run: 21 keys. */
const MANUAL_RUN_END_KEYS = [
  ...EXECUTION_COUNTS,
  'queueSize',
  ...GMAIL_KEYS,
  'durationMs',
  'stopped',
  'job',
  'alerts',
];

/**
 * Five rules. `newsletter` adds `News`, `shipping` archives, and `password` is
 * a rule whose ID is a forbidden log field name: its probability must stay a
 * number in the log (story #141 decision S1).
 */
function config(): Config {
  return loadConfig({
    defaultThreshold: 0.8,
    triggerIntervalMinutes: 10,
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
      { id: 'password', question: 'Does it ask for a password?', label: 'Security/Password' },
    ],
  });
}

/** A 200 answering every rule: `newsletter` and `shipping` fire. */
const answered: FakeHttpResponse = {
  status: 200,
  headers: { 'content-type': 'application/json', 'x-typesafe-request-id': REQUEST_ID },
  body: JSON.stringify({
    model: MODEL,
    answers: {
      approval: { type: 'noul', noul: 0.06 },
      bill: { type: 'noul', noul: 0.01 },
      newsletter: { type: 'noul', noul: 0.93 },
      shipping: { type: 'noul', noul: 0.97 },
      password: { type: 'noul', noul: 0.02 },
    },
    usage: { input_tokens: TOKENS, output_tokens: 68 },
  }),
};

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

/** Every world a test built: its log is checked after the test. */
let worlds: FakePorts[] = [];

function expectInCatalog(events: readonly { event: string; level: LogEventLevel }[]): void {
  for (const { event, level } of events) {
    if (!isLogEventName(event)) {
      throw new Error(`'${event}' was logged but is not in LOG_EVENTS`);
    }
    const allowed: readonly LogEventLevel[] = LOG_EVENT_LEVELS[event];
    expect(allowed, `'${event}' was logged at ${level}`).toContain(level);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const ports of worlds) {
    const logged = JSON.stringify(ports.log.events);
    expect(logged).not.toContain(BODY_TEXT);
    expect(logged).not.toContain(KEY);
    expect(ports.log.events.some((e) => 'state' in e.fields)).toBe(false);
    expectInCatalog(ports.log.events);
  }
  worlds = [];
});

/** Fake ports with `state.position` at the mailbox's current `historyId`, saved an hour ago. */
function world(options: FakePortsOptions = {}): FakePorts {
  const ports = createFakePorts(options);
  worlds.push(ports);
  seedPosition(ports);
  ports.http.respond(() => true, [answered]);
  return ports;
}

function seedPosition(ports: FakePorts): void {
  ports.state.seedRaw(
    POSITION_KEY,
    JSON.stringify(
      encodePosition({ historyId: ports.gmail.historyId, savedAt: ports.clock.now() - HOUR_MS }),
    ),
  );
}

function deliver(ports: FakePorts, subject: string, body = `${BODY_TEXT} ${subject}`): string {
  return ports.gmail.deliver({
    internalDate: ports.clock.now() - 10 * 60_000,
    headers: [
      { name: 'From', value: 'Friend <friend@example.com>' },
      { name: 'Subject', value: subject },
    ],
    bodyText: body,
  }).threadId;
}

/**
 * `onTrigger`'s pairing: `runEntry` with the scheduled options around
 * `runScheduled`. The sink only records, so nothing calls Gmail outside the
 * counting port.
 */
function runTrigger(ports: FakePorts, log: LogPort = ports.log): RunReport {
  const result = runEntry(
    { entry: 'onTrigger', kind: 'scheduled', heartbeat: true, tallyGmail: true },
    {
      lock: ports.lock,
      clock: ports.clock,
      state: ports.state,
      log,
      gmail: ports.gmail,
      alertSink: { deliver: () => undefined },
      loadConfig: config,
    },
    (ctx) =>
      runScheduled(ctx, {
        http: ports.http,
        state: ports.state,
        log,
        clock: ports.clock,
        random: ports.random,
        secrets: ports.secrets,
        auth: ports.auth,
        decodeUtf8: nodeDecodeUtf8,
      }),
  );
  if ('skipped' in result) throw new Error('the lock was busy');
  return result;
}

/** `continueManualRun`'s pairing: `runEntry` (`kind: 'manual'`) around `continueManualJob`. */
function runEditor(ports: FakePorts): ManualRunReport {
  const result = runEntry(
    { entry: 'continueManualRun', kind: 'manual', heartbeat: true, tallyGmail: true },
    {
      lock: ports.lock,
      clock: ports.clock,
      state: ports.state,
      log: ports.log,
      gmail: ports.gmail,
      alertSink: { deliver: () => undefined },
      loadConfig: config,
    },
    (ctx) =>
      continueManualJob(ctx, {
        http: ports.http,
        state: ports.state,
        log: ports.log,
        clock: ports.clock,
        random: ports.random,
        secrets: ports.secrets,
        auth: ports.auth,
        decodeUtf8: nodeDecodeUtf8,
      }),
  );
  if ('skipped' in result) throw new Error('the lock was busy');
  return result.report;
}

function header(message: GmailMessage, name: string): string {
  return message.payload?.headers?.find((h) => h.name === name)?.value ?? '';
}

/**
 * A world with `old` threads (subjects `old <i>`) delivered before the saved
 * position, so only the job's search finds them, and a saved job.
 */
function manualWorld(old: number): FakePorts {
  const ports = createFakePorts();
  worlds.push(ports);
  ports.gmail.setSearchMatcher((q, message) => {
    if (q !== JOB_QUERY) throw new Error('an unexpected search query');
    return header(message, 'Subject').startsWith('old ');
  });
  for (let i = 0; i < old; i++) {
    deliver(ports, `old ${String(i)}`);
  }
  seedPosition(ports);
  saveManualJob(
    ports.state,
    newManualJob({
      query: JOB_QUERY,
      applyMoves: false,
      startedAt: ports.clock.now() - HOUR_MS,
    }),
  );
  ports.http.respond(() => true, [answered]);
  return ports;
}

function only(ports: FakePorts, event: string): LoggedEvent {
  const events = ports.log.all(event);
  expect(events).toHaveLength(1);
  const [found] = events;
  if (found === undefined) throw new Error(`no ${event}`);
  return found;
}

function sorted(keys: readonly string[]): string[] {
  return [...keys].sort();
}

function numberField(event: LoggedEvent, name: string): number {
  const value = event.fields[name];
  if (typeof value !== 'number') throw new Error(`${event.event}.${name} is not a number`);
  return value;
}

function storedTally(ports: FakePorts): { day: string; count: number } {
  const tally = decodeGmailCalls(ports.state.get(GMAIL_CALLS_KEY));
  return { day: tally.day, count: tally.count };
}

function seedTally(ports: FakePorts, day: string, count: number): void {
  ports.state.seedRaw(GMAIL_CALLS_KEY, JSON.stringify(encodeGmailCalls({ day, count })));
}

// ---------------------------------------------------------------------------
// thread.classified
// ---------------------------------------------------------------------------

describe('thread.classified through a scheduled run', () => {
  it('plain: exactly the fields of SD §10.5, at info', () => {
    const ports = world();
    const threadId = deliver(ports, 'Your parcel is on its way');

    runTrigger(ports);

    const event = only(ports, 'thread.classified');
    expect(event.level).toBe('info');
    expect(sorted(Object.keys(event.fields))).toEqual(sorted(CLASSIFIED_KEYS));
    expect(event.fields).toEqual({
      threadId,
      source: 'scheduled',
      subject: 'Your parcel is on its way',
      from: 'Friend <friend@example.com>',
      // One number per configured rule ID, and nothing else.
      probabilities: {
        approval: 0.06,
        bill: 0.01,
        newsletter: 0.93,
        shipping: 0.97,
        password: 0.02,
      },
      // Rule IDs, in config order.
      fired: ['newsletter', 'shipping'],
      // `label:<name>` for each label, then at most one `move:…`.
      actions: [`label:${NEWS}`, 'move:archive'],
      requestId: REQUEST_ID,
      model: MODEL,
      inputTokens: TOKENS,
    });
    expect(Object.keys(event.fields['probabilities'] ?? {})).toEqual(RULE_IDS);
  });

  it('truncated: the same fields plus truncated, at warn', () => {
    const ports = world();
    // ASCII, so the estimate is one token per character (SD §8.4): over Jev's limit.
    const body = `${BODY_TEXT} `.repeat(Math.ceil(40_000 / (BODY_TEXT.length + 1)));
    expect(body.length).toBeGreaterThan(JEV_LIMIT_TOKENS);
    deliver(ports, 'A very long mail', body);

    runTrigger(ports);

    const event = only(ports, 'thread.classified');
    expect(event.level).toBe('warn');
    expect(sorted(Object.keys(event.fields))).toEqual(sorted([...CLASSIFIED_KEYS, 'truncated']));
    const { truncated } = event.fields;
    expect(Object.keys(truncated ?? {}).sort()).toEqual([
      'bodiesDropped',
      'charsDropped',
      'messagesDropped',
    ]);
    // One message, its body cut: nothing dropped whole.
    expect(truncated).toMatchObject({ messagesDropped: 0, bodiesDropped: 0 });
    const charsDropped: unknown = Object.entries(truncated ?? {}).find(
      ([key]) => key === 'charsDropped',
    )?.[1];
    expect(typeof charsDropped === 'number' && charsDropped > 0).toBe(true);
  });

  it('a plain and a truncated thread in one run are logged at their own levels', () => {
    const ports = world();
    deliver(ports, 'short');
    deliver(ports, 'long', 'x'.repeat(40_000));

    runTrigger(ports);

    const levels = ports.log
      .all('thread.classified')
      .map((e) => [e.fields['subject'], e.level, 'truncated' in e.fields]);
    expect(levels).toEqual([
      ['short', 'info', false],
      ['long', 'warn', true],
    ]);
  });
});

// ---------------------------------------------------------------------------
// run.end
// ---------------------------------------------------------------------------

describe('run.end of a scheduled run', () => {
  it('has exactly the 21 fields of SD §10.5, at info', () => {
    const ports = world();
    deliver(ports, 'mail 0');
    deliver(ports, 'mail 1');

    const report = runTrigger(ports);

    const event = only(ports, 'run.end');
    expect(event.level).toBe('info');
    expect(SCHEDULED_RUN_END_KEYS).toHaveLength(21);
    expect(sorted(Object.keys(event.fields))).toEqual(sorted(SCHEDULED_RUN_END_KEYS));
    expect(event.fields).toMatchObject({
      ingested: 2,
      merged: 0,
      excluded: 0,
      skipped: 0,
      classified: 2,
      struck: 0,
      errored: 0,
      untouched: 0,
      gone: 0,
      sent: 2,
      chunks: 1,
      inputTokens: 2 * TOKENS,
      queueSize: 0,
      stopped: 'drained',
      labels: { [NEWS]: 2 },
      moves: { archive: 2 },
      alerts: [],
    });
    // The summary stored in `state.runs` is the 17 numeric fields.
    expect(sorted(Object.keys(report.summary))).toEqual(
      sorted(
        SCHEDULED_RUN_END_KEYS.filter(
          (key) => !['stopped', 'labels', 'moves', 'alerts'].includes(key),
        ),
      ),
    );
  });

  it('gmailCalls, gmailUnits and gmailCallsToday: the run, on top of today’s stored tally', () => {
    const ports = world();
    deliver(ports, 'mail 0');
    seedTally(ports, '2026-09-26', 100);

    runTrigger(ports);

    const event = only(ports, 'run.end');
    const gmailCalls = numberField(event, 'gmailCalls');
    expect(gmailCalls).toBeGreaterThan(0);
    expect(gmailCalls).toBe(ports.gmail.calls.length);
    expect(numberField(event, 'gmailUnits')).toBe(ports.gmail.unitsUsed);
    expect(numberField(event, 'gmailCallsToday')).toBe(100 + gmailCalls);
    expect(event.fields['alerts']).toEqual([]);
    expect(storedTally(ports)).toEqual({ day: '2026-09-26', count: 100 + gmailCalls });
  });

  it('with no stored tally, gmailCallsToday is this run’s calls', () => {
    const ports = world();
    deliver(ports, 'mail 0');

    runTrigger(ports);

    const event = only(ports, 'run.end');
    const gmailCalls = numberField(event, 'gmailCalls');
    expect(numberField(event, 'gmailCallsToday')).toBe(gmailCalls);
    expect(storedTally(ports)).toEqual({ day: '2026-09-26', count: gmailCalls });
  });

  it('the day is the script’s: a tally for the UTC day is yesterday’s in Tokyo', () => {
    // 23:30 UTC on the 26th is 08:30 on the 27th in Tokyo.
    const ports = world({ now: '2026-09-26T23:30:00Z', timeZone: 'Asia/Tokyo' });
    deliver(ports, 'mail 0');
    seedTally(ports, '2026-09-26', 100);

    runTrigger(ports);

    const event = only(ports, 'run.end');
    const gmailCalls = numberField(event, 'gmailCalls');
    expect(gmailCalls).toBe(ports.gmail.calls.length);
    expect(numberField(event, 'gmailCallsToday')).toBe(gmailCalls);
    expect(storedTally(ports)).toEqual({ day: '2026-09-27', count: gmailCalls });
  });

  it('the same instant in UTC keeps the stored tally', () => {
    const ports = world({ now: '2026-09-26T23:30:00Z' });
    deliver(ports, 'mail 0');
    seedTally(ports, '2026-09-26', 100);

    runTrigger(ports);

    const event = only(ports, 'run.end');
    expect(numberField(event, 'gmailCallsToday')).toBe(100 + numberField(event, 'gmailCalls'));
  });
});

describe('run.end of a manual editor run', () => {
  it('has exactly the 21 fields of SD §10.5, at info', () => {
    const ports = manualWorld(3);
    seedTally(ports, '2026-09-26', 100);

    const report = runEditor(ports);

    expect(report).toEqual({ job: 'completed', stopped: 'completed', alerts: [] });
    const event = only(ports, 'run.end');
    expect(event.level).toBe('info');
    expect(MANUAL_RUN_END_KEYS).toHaveLength(21);
    expect(sorted(Object.keys(event.fields))).toEqual(sorted(MANUAL_RUN_END_KEYS));
    expect(event.fields).toMatchObject({
      pages: 1,
      queued: 3,
      merged: 0,
      chunks: 1,
      excluded: 0,
      skipped: 0,
      sent: 3,
      classified: 3,
      struck: 0,
      errored: 0,
      untouched: 0,
      gone: 0,
      inputTokens: 3 * TOKENS,
      queueSize: 0,
      stopped: 'completed',
      job: 'completed',
      alerts: [],
    });
    const gmailCalls = numberField(event, 'gmailCalls');
    expect(gmailCalls).toBe(ports.gmail.calls.length);
    expect(numberField(event, 'gmailUnits')).toBe(ports.gmail.unitsUsed);
    expect(numberField(event, 'gmailCallsToday')).toBe(100 + gmailCalls);
    // No `applyMoves`: the move rule fires, nothing moves, and that is not a failure.
    for (const classified of ports.log.all('thread.classified')) {
      expect(classified.level).toBe('info');
      expect(classified.fields).toMatchObject({
        source: 'manual',
        fired: ['newsletter', 'shipping'],
        actions: [`label:${NEWS}`],
      });
    }
  });
});

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

describe('every event of a run is in the catalog', () => {
  it('a scheduled run and a manual editor run log only LOG_EVENTS, at allowed levels', () => {
    const scheduled = world();
    deliver(scheduled, 'short');
    deliver(scheduled, 'long', 'x'.repeat(40_000));
    runTrigger(scheduled);
    const manual = manualWorld(2);
    runEditor(manual);

    const events = [...scheduled.log.events, ...manual.log.events];
    expectInCatalog(events);
    expect([...new Set(events.map((e) => e.event))].sort()).toEqual([
      'ingest.done',
      'jev.batch',
      'label.created',
      'manual.completed',
      'manual.progress',
      'run.end',
      'run.start',
      'thread.classified',
    ]);
  });

  it('the check itself rejects an unknown event and a level the catalog does not allow', () => {
    expect(() => {
      expectInCatalog([{ event: 'config.invalid', level: 'error' }]);
    }).toThrow("'config.invalid' was logged but is not in LOG_EVENTS");
    expect(() => {
      expectInCatalog([{ event: 'thread.failed', level: 'info' }]);
    }).toThrow();
  });
});

// ---------------------------------------------------------------------------
// The real adapter
// ---------------------------------------------------------------------------

const lineSchema = z.looseObject({
  event: z.string(),
  runId: z.string(),
  entry: z.string(),
  ts: z.string(),
});

type Line = { level: LogEventLevel; text: string };

/** Stubs `Utilities` and `console` as `test/adapters/gas/gas-log-adapter.test.ts` does. */
function stubGasLog(): Line[] {
  const lines: Line[] = [];
  let uuids = 0;
  vi.stubGlobal('Utilities', { getUuid: () => `uuid-${String(++uuids)}` });
  vi.stubGlobal('console', {
    info: (text: string) => lines.push({ level: 'info', text }),
    warn: (text: string) => lines.push({ level: 'warn', text }),
    error: (text: string) => lines.push({ level: 'error', text }),
  });
  return lines;
}

describe('a whole scheduled run through GasLogAdapter', () => {
  function run(): { lines: Line[]; parsed: Record<string, unknown>[] } {
    const ports = world();
    deliver(ports, 'Your parcel is on its way');
    const lines = stubGasLog();
    runTrigger(ports, new GasLogAdapter({ entry: 'onTrigger', secretValues: () => [KEY] }));
    vi.unstubAllGlobals();
    // Nothing reached the fake log: every event went through the adapter.
    expect(ports.log.events).toEqual([]);
    const parsed = lines.map((line): Record<string, unknown> => {
      const value: unknown = JSON.parse(line.text);
      return lineSchema.parse(value);
    });
    return { lines, parsed };
  }

  it('every line is one JSON object that starts with event, runId, entry, ts', () => {
    const { lines, parsed } = run();

    expect(lines.length).toBeGreaterThanOrEqual(5);
    for (const [i, line] of lines.entries()) {
      expect(line.text).not.toContain('\n');
      expect(Object.keys(parsed[i] ?? {}).slice(0, 4)).toEqual(['event', 'runId', 'entry', 'ts']);
    }
    expect(new Set(parsed.map((line) => line['runId']))).toEqual(new Set(['uuid-1']));
    expect(new Set(parsed.map((line) => line['entry']))).toEqual(new Set(['onTrigger']));
    for (const line of parsed) {
      expect(line['ts']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  });

  it('every line’s event is in LOG_EVENTS, written with the console method of an allowed level', () => {
    const { lines, parsed } = run();

    const events = parsed.map((line, i) => ({
      event: String(line['event']),
      level: lines[i]?.level ?? 'error',
    }));
    expectInCatalog(events);
    expect(events).toEqual([
      { event: 'run.start', level: 'info' },
      { event: 'ingest.done', level: 'info' },
      { event: 'jev.batch', level: 'info' },
      { event: 'label.created', level: 'info' },
      { event: 'thread.classified', level: 'info' },
      { event: 'run.end', level: 'info' },
    ]);
  });

  it('a rule ID that looks like a secret keeps its number', () => {
    const { parsed } = run();

    const classified = parsed.find((line) => line['event'] === 'thread.classified');
    expect(classified).toMatchObject({
      probabilities: {
        approval: 0.06,
        bill: 0.01,
        newsletter: 0.93,
        shipping: 0.97,
        password: 0.02,
      },
      subject: 'Your parcel is on its way',
      requestId: REQUEST_ID,
    });
    expect(JSON.stringify(parsed)).not.toContain('[redacted]');
  });
});
