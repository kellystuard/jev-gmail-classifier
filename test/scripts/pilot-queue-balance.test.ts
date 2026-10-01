/**
 * The identity `scripts/pilot-measures-run.ts` relies on for `balanceBreaks`
 * (task #315): across consecutive scheduled runs with no manual work,
 *
 *     queueSize = previous queueSize + ingested
 *                 - (excluded + skipped + classified + errored + gone)
 *
 * It is proved here against `runScheduled` and the fakes, over several runs
 * with a strike, an exclusion, a `Jev/Error` and a gone thread.
 */
import { describe, expect, it } from 'vitest';

import { createAlertCollector } from '../../src/app/alerts.ts';
import { countGmailCalls } from '../../src/app/counting-gmail.ts';
import { runScheduled } from '../../src/app/run-controller.ts';
import type { RunContext } from '../../src/app/run-entry.ts';
import { loadConfig } from '../../src/config/loader.ts';
import { createDeadline } from '../../src/core/deadline.ts';
import { encodePosition, POSITION_KEY } from '../../src/core/position.ts';
import { fail } from '../../src/core/result.ts';
import { runLimits } from '../../src/core/run-limits.ts';
import type { HttpRequest } from '../../src/ports/http-port.ts';
import { jsonPayload } from '../fakes/fake-http.ts';
import { createFakePorts, type FakePorts } from '../fakes/fake-ports.ts';
import { nodeDecodeUtf8 } from '../fakes/node-utf8.ts';
import ok200 from '../fixtures/jev/200-four-rules.json' with { type: 'json' };
import invalid422 from '../fixtures/jev/422-empty-questions.json' with { type: 'json' };

const NOW = Date.parse('2026-09-26T12:00:00Z');
const HOUR_MS = 3_600_000;
const LIMITS = runLimits('manual', 10);

const config = loadConfig({
  defaultThreshold: 0.8,
  triggerIntervalMinutes: 10,
  excludeQuery: 'from:bank.example.test',
  rules: [{ id: 'newsletter', question: 'Is it a newsletter?', label: 'News' }],
});

function deliver(ports: FakePorts, subject: string, from = 'friend@example.test'): string {
  return ports.gmail.deliver({
    internalDate: NOW - 10 * 60_000,
    headers: [
      { name: 'From', value: from },
      { name: 'Subject', value: subject },
    ],
    bodyText: `body of ${subject}`,
  }).threadId;
}

function subjectOf(request: HttpRequest): string {
  const payload = jsonPayload(request);
  if (typeof payload !== 'object' || payload === null) return '';
  const state: unknown = Reflect.get(payload, 'state');
  if (!Array.isArray(state)) return '';
  const first: unknown = state[0];
  const subject: unknown =
    typeof first === 'object' && first !== null ? Reflect.get(first, 'subject') : undefined;
  return typeof subject === 'string' ? subject : '';
}

type Summary = Record<string, number | string>;

function runOnce(ports: FakePorts): Summary {
  const counting = countGmailCalls(ports.gmail);
  const ctx: RunContext = {
    config,
    deadline: createDeadline(() => ports.clock.now(), LIMITS),
    limits: LIMITS,
    gmail: counting.gmail,
    gmailUsage: () => ({
      calls: counting.calls(),
      units: counting.units(),
      callsToday: counting.calls(),
    }),
    alerts: createAlertCollector(),
  };
  const report = runScheduled(ctx, {
    http: ports.http,
    state: ports.state,
    log: ports.log,
    clock: ports.clock,
    random: ports.random,
    secrets: ports.secrets,
    auth: ports.auth,
    decodeUtf8: nodeDecodeUtf8,
  });
  return { ...report.summary, stopped: report.stopped };
}

function num(summary: Summary, key: string): number {
  const value = summary[key];
  if (typeof value !== 'number') throw new Error(`no ${key}`);
  return value;
}

describe('the queue balance behind balanceBreaks', () => {
  it('holds across runs with a strike, an exclusion, an error and a gone thread', () => {
    const ports = createFakePorts();
    ports.state.seedRaw(
      POSITION_KEY,
      JSON.stringify(encodePosition({ historyId: ports.gmail.historyId, savedAt: NOW - HOUR_MS })),
    );
    ports.gmail.setSearchMatcher(
      (_q, message) =>
        message.payload?.headers?.some(
          (h) => h.name === 'From' && h.value === 'alerts@bank.example.test',
        ) === true,
    );
    const r503 = { status: 503, headers: {}, body: '' };
    ports.http.respond((r) => subjectOf(r) === 'flaky', [r503, r503, r503, ok200]);
    ports.http.respond((r) => subjectOf(r) === 'invalid', [invalid422]);
    ports.http.respond(() => true, [ok200]);

    // Run 1: six threads. One excluded, one gone at the write, one 422
    // (errored), one flaky (struck, stays queued), two classified.
    deliver(ports, 'plain 1');
    deliver(ports, 'plain 2');
    deliver(ports, 'bank notice', 'alerts@bank.example.test');
    const gone = deliver(ports, 'vanishing');
    deliver(ports, 'invalid');
    deliver(ports, 'flaky');
    ports.gmail.failNext('modifyThread', fail('not_found'), { threadId: gone });
    const first = runOnce(ports);

    // Run 2: the flaky thread again, plus two new ones.
    deliver(ports, 'plain 3');
    deliver(ports, 'plain 4');
    const second = runOnce(ports);

    // Run 3: nothing new.
    const third = runOnce(ports);

    expect(first).toMatchObject({ ingested: 6, excluded: 1, errored: 1, gone: 1, struck: 1 });
    expect(num(first, 'queueSize')).toBe(1);
    let previous = 0;
    for (const summary of [first, second, third]) {
      const out =
        num(summary, 'excluded') +
        num(summary, 'skipped') +
        num(summary, 'classified') +
        num(summary, 'errored') +
        num(summary, 'gone');
      expect(num(summary, 'queueSize')).toBe(previous + num(summary, 'ingested') - out);
      previous = num(summary, 'queueSize');
    }
    expect(num(second, 'classified')).toBe(3);
    expect(num(third, 'queueSize')).toBe(0);
  });
});
