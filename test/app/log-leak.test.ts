/**
 * The leak test (Solution Design §10.5 "Never logged"; Engineering Standards
 * §6; epic #15 decision 5; task #143). A mail body, the API key and the
 * `Authorization` value hold sentinel strings, the run takes every path that
 * handles a response or an error, and no log line may hold a sentinel.
 *
 * It runs twice. With `FakeLog` nothing scrubs the fields, so it proves the
 * **callers** pass no secret. With `GasLogAdapter` it proves the lines that
 * reach `console`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { GasLogAdapter } from '../../src/adapters/gas/gas-log-adapter.ts';
import { loadQueue } from '../../src/app/queue-store.ts';
import { runScheduled } from '../../src/app/run-controller.ts';
import { runEntry } from '../../src/app/run-entry.ts';
import { loadConfig } from '../../src/config/loader.ts';
import type { Config } from '../../src/config/schema.ts';
import { RunAbortError } from '../../src/core/errors.ts';
import type { GmailMessage } from '../../src/core/gmail-types.ts';
import { JEV_ERROR_LABEL } from '../../src/core/label-path.ts';
import { encodePosition, POSITION_KEY } from '../../src/core/position.ts';
import { isForbiddenLogField } from '../../src/core/redact.ts';
import type { HttpRequest } from '../../src/ports/http-port.ts';
import type { LogPort } from '../../src/ports/log-port.ts';
import { type FakeHttpResponse, jsonPayload } from '../fakes/fake-http.ts';
import { FakeLog } from '../fakes/fake-log.ts';
import { createFakePorts, type FakePorts } from '../fakes/fake-ports.ts';
import { nodeDecodeUtf8 } from '../fakes/node-utf8.ts';
import ok200 from '../fixtures/jev/200-four-rules.json' with { type: 'json' };

/** In every delivered message's body. */
const BODY = 'LEAK-BODY-7f3a9c2e';
/** The Jev key. */
const KEY = 'LEAK-KEY-5d2e8b41';
/** The `Authorization` header's value. */
const AUTH = `Bearer ${KEY}`;

const HOUR_MS = 3_600_000;
const EXCLUDE_QUERY = 'from:bank@example.com';
const BANK = 'bank@example.com';

/** What an error body echoes: the request's `state`, the key and the header. */
const ECHO = `state was [{"body":"${BODY}"}], key ${KEY}, Authorization: ${AUTH}`;

function config(): Config {
  return loadConfig({
    defaultThreshold: 0.8,
    triggerIntervalMinutes: 10,
    excludeQuery: EXCLUDE_QUERY,
    rules: [
      { id: 'approval', question: 'Does it ask for approval?', label: 'Approval' },
      { id: 'bill', question: 'Is it a bill?', label: 'Finance/Bill' },
      { id: 'newsletter', question: 'Is it a newsletter?', label: 'News' },
      {
        id: 'shipping',
        question: 'Is it a shipping notice?',
        action: 'move',
        destination: 'archive',
      },
    ],
  });
}

function errorBody(errorType: string): string {
  return JSON.stringify({
    detail: { error_type: errorType, message: ECHO, input: { state: [{ body: BODY }] } },
  });
}

const JSON_HEADERS = { 'content-type': 'application/json' };
const r429: FakeHttpResponse = { status: 429, headers: { 'retry-after': '1' }, body: ECHO };

/**
 * One response list per thread, by subject. Subjects and senders hold no
 * sentinel: they may be logged.
 */
const FIRST_RUN: Readonly<Record<string, readonly FakeHttpResponse[]>> = {
  // Classified.
  'leak answered': [ok200],
  // `Jev/Error` at once.
  'leak invalid': [{ status: 422, headers: JSON_HEADERS, body: errorBody('validation_error') }],
  // Retryable on every attempt: one strike.
  'leak unavailable': [{ status: 503, headers: JSON_HEADERS, body: errorBody('unavailable') }],
  // Exceptional: `interpretResponse` throws, one strike.
  'leak server error': [{ status: 500, headers: JSON_HEADERS, body: errorBody('server_error') }],
  // A 200 that isn't JSON: the exception path.
  'leak garbled': [{ status: 200, headers: JSON_HEADERS, body: `<html>${ECHO}</html>` }],
  // A network error whose message quotes the header.
  'leak offline': [{ transport: `connection reset after sending Authorization: ${AUTH}` }],
  // Retried, then answered. It also keeps the retry rounds from being all 5xx
  // or network errors, which would be an outage that strikes nothing.
  'leak slow': [r429, r429, ok200],
};

const SUBJECTS = Object.keys(FIRST_RUN);

const wrongKey: FakeHttpResponse = {
  status: 401,
  headers: JSON_HEADERS,
  body: JSON.stringify({
    detail: { error_type: 'authentication_error', message: `The key ${KEY} is wrong. ${ECHO}` },
  }),
};

const payloadSchema = z.object({ state: z.array(z.object({ subject: z.string() })) });

function subjectOf(request: HttpRequest): string {
  return payloadSchema.parse(jsonPayload(request)).state[0]?.subject ?? '';
}

function header(message: GmailMessage, name: string): string {
  return message.payload?.headers?.find((h) => h.name === name)?.value ?? '';
}

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

type Scenario = {
  readonly ports: FakePorts;
  /** Thread IDs by subject. */
  readonly ids: Readonly<Record<string, string>>;
  readonly excludedId: string;
  /** What the second run threw. */
  readonly secondRunError: unknown;
};

/**
 * Two scheduled runs through `runEntry` + `runScheduled`, logging to `log`.
 * The first takes every path; in the second Jev refuses the key, so the run
 * fails.
 */
function runLeakScenario(log: LogPort): Scenario {
  const ports = createFakePorts({ jevApiKey: KEY });
  ports.state.seedRaw(
    POSITION_KEY,
    JSON.stringify(
      encodePosition({ historyId: ports.gmail.historyId, savedAt: ports.clock.now() - HOUR_MS }),
    ),
  );
  ports.gmail.setSearchMatcher((q, message) => {
    if (!q.startsWith(`(${EXCLUDE_QUERY}) `)) throw new Error('an unexpected search query');
    return header(message, 'From') === BANK;
  });

  const deliver = (subject: string, from = 'friend@example.com'): string =>
    ports.gmail.deliver({
      internalDate: ports.clock.now() - 10 * 60_000,
      headers: [
        { name: 'From', value: from },
        { name: 'Subject', value: subject },
      ],
      bodyText: `Dear friend, ${BODY} is the private part of ${subject}.`,
    }).threadId;

  const ids: Record<string, string> = {};
  for (const subject of SUBJECTS) {
    ids[subject] = deliver(subject);
  }
  const excludedId = deliver('leak statement', BANK);

  let secondRun = false;
  ports.http.respond(() => secondRun, [wrongKey]);
  for (const [subject, responses] of Object.entries(FIRST_RUN)) {
    ports.http.respond((request) => subjectOf(request) === subject, responses);
  }

  const trigger = (): unknown =>
    runEntry(
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

  trigger();
  secondRun = true;
  const secondRunError = caught(trigger);
  return { ports, ids, excludedId, secondRunError };
}

function labelNames(ports: FakePorts, threadId: string): string[] {
  const listed = ports.gmail.listLabels();
  if (!listed.ok) throw new Error('listLabels failed');
  const names = new Map(listed.labels.map((l) => [l.id, l.name]));
  return (ports.gmail.threadLabels(threadId)[0] ?? []).map((id) => names.get(id) ?? id);
}

function idOf(scenario: Scenario, subject: string): string {
  const id = scenario.ids[subject];
  if (id === undefined) throw new Error(`no thread ${subject}`);
  return id;
}

/** The scenario really carried the sentinels, and really took every path. */
function expectScenarioRan(scenario: Scenario): void {
  const { ports } = scenario;
  const requests = ports.http.batches.flat();
  expect(requests.length).toBeGreaterThan(SUBJECTS.length);
  for (const request of requests) {
    expect(request.payload).toContain(BODY);
    expect(request.headers['Authorization']).toBe(AUTH);
  }
  // Every subject was sent, and the excluded thread never was.
  expect(new Set(requests.map(subjectOf))).toEqual(new Set(SUBJECTS));

  expect(labelNames(ports, idOf(scenario, 'leak answered'))).toContain('News');
  expect(labelNames(ports, idOf(scenario, 'leak slow'))).toContain('News');
  expect(labelNames(ports, idOf(scenario, 'leak invalid'))).toContain(JEV_ERROR_LABEL);
  // One strike each in the first run; the second run's 401 strikes nothing.
  expect(
    Object.fromEntries(loadQueue(ports.state).map((item) => [item.threadId, item.strikes])),
  ).toEqual({
    [idOf(scenario, 'leak unavailable')]: 1,
    [idOf(scenario, 'leak server error')]: 1,
    [idOf(scenario, 'leak garbled')]: 1,
    [idOf(scenario, 'leak offline')]: 1,
  });
  expect(scenario.secondRunError).toBeInstanceOf(RunAbortError);
}

describe('no log line holds a body, the key or the Authorization value', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('through FakeLog: the callers pass none of them', () => {
    const log = new FakeLog();
    const scenario = runLeakScenario(log);

    expectScenarioRan(scenario);
    const count = (event: string): number => log.all(event).length;
    expect(count('thread.classified')).toBe(2);
    expect(count('thread.errored')).toBe(1);
    expect(count('thread.failed')).toBe(4);
    expect(count('thread.excluded')).toBe(1);
    expect(count('run.failed')).toBe(1);
    expect(log.all('thread.failed').map((e) => e.fields['reason'])).toEqual(
      expect.arrayContaining(['retryable', 'transport', 'UnexpectedResponseError']),
    );
    expect(log.find('thread.excluded')?.fields).toEqual({
      threadId: scenario.excludedId,
      source: 'scheduled',
      reason: 'matched',
    });
    expect(log.find('run.failed')?.fields).toMatchObject({ error: 'RunAbortError' });

    const logged = JSON.stringify(log.events);
    expect(logged).not.toContain(BODY);
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain('Bearer ');
    expect(logged).not.toContain('[redacted]');
    // `FakeLog` would have thrown on these names; this says so in the open.
    for (const event of log.events) {
      expect(Object.keys(event.fields).filter(isForbiddenLogField)).toEqual([]);
    }
    // The excluded thread's subject and sender are never logged.
    expect(logged).not.toContain('leak statement');
    expect(logged).not.toContain(BANK);
  });

  it('through GasLogAdapter: no console line holds one', () => {
    const lines: string[] = [];
    const write = (line: string): void => {
      lines.push(line);
    };
    vi.stubGlobal('Utilities', { getUuid: () => 'uuid-1' });
    vi.stubGlobal('console', { info: write, warn: write, error: write });
    const scenario = runLeakScenario(
      new GasLogAdapter({ entry: 'onTrigger', secretValues: () => [KEY] }),
    );
    vi.unstubAllGlobals();

    expectScenarioRan(scenario);
    expect(scenario.ports.log.events).toEqual([]);
    const events = lines.map(
      (line) => z.object({ event: z.string() }).parse(JSON.parse(line)).event,
    );
    expect(events).toEqual(
      expect.arrayContaining([
        'thread.classified',
        'thread.errored',
        'thread.failed',
        'thread.excluded',
        'run.failed',
      ]),
    );

    const written = lines.join('\n');
    expect(written).not.toContain(BODY);
    expect(written).not.toContain(KEY);
    // `Bearer ` may only ever be followed by the scrub mark.
    expect(written).not.toMatch(/Bearer (?!\[redacted\])\S/i);
  });
});
