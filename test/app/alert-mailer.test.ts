import { afterEach, describe, expect, it } from 'vitest';

import {
  ALERT_ERROR_MESSAGE_MAX_CHARS,
  createMailAlertSink,
  loadAlertRecord,
  saveAlertRecord,
} from '../../src/app/alert-mailer.ts';
import type { AlertSink, CollectedAlerts } from '../../src/app/alerts.ts';
import { createAlertCollector } from '../../src/app/alerts.ts';
import { type RunEntryDeps, type RunEntryOptions, runEntry } from '../../src/app/run-entry.ts';
import { loadConfig } from '../../src/config/loader.ts';
import type { AlertCondition } from '../../src/core/alert-condition.ts';
import {
  type AlertEmailInput,
  ALERT_SUBJECT_PREFIX,
  buildAlertEmail,
} from '../../src/core/alert-email.ts';
import { ALERTS_KEY } from '../../src/core/alert-limit.ts';
import { RunAbortError, StateError, UnexpectedResponseError } from '../../src/core/errors.ts';
import { GMAIL_CALLS_KEY, decodeGmailCalls } from '../../src/core/gmail-calls.ts';
import { fail } from '../../src/core/result.ts';
import { FakeGmail, RATE_LIMIT_MESSAGE } from '../fakes/fake-gmail.ts';
import type { FakeLog } from '../fakes/fake-log.ts';
import { FakeMail, MAIL_QUOTA_MESSAGE } from '../fakes/fake-mail.ts';
import { type FakePorts, type FakePortsOptions, createFakePorts } from '../fakes/fake-ports.ts';
import { SCOPE_ERROR_MESSAGE } from '../fakes/fake-scopes.ts';

const NOW = '2026-09-30T12:00:00Z';
const TODAY = '2026-09-30';
const TOMORROW = '2026-10-01';
const HOUR_MS = 60 * 60 * 1000;
/** The fake Gmail's default profile address: a reserved example domain. */
const OWNER = 'owner@example.com';
const SEND_MAIL = 'https://www.googleapis.com/auth/script.send_mail';
const GMAIL_MODIFY = 'https://www.googleapis.com/auth/gmail.modify';
const EXTERNAL_REQUEST = 'https://www.googleapis.com/auth/script.external_request';

/** Every log a test created, for the leak check below. */
const logs: FakeLog[] = [];

afterEach(() => {
  for (const log of logs) {
    for (const event of log.events) {
      const text = JSON.stringify(event);
      expect(text).not.toContain(OWNER);
      expect(text).not.toContain(ALERT_SUBJECT_PREFIX);
    }
  }
  logs.length = 0;
});

type Setup = { readonly ports: FakePorts; readonly sink: AlertSink };

function setup(options: FakePortsOptions = {}): Setup {
  const ports = createFakePorts({ now: NOW, ...options });
  logs.push(ports.log);
  return { ports, sink: createMailAlertSink(ports) };
}

function collected(
  conditions: readonly AlertCondition[],
  details: Partial<Omit<CollectedAlerts, 'conditions'>> = {},
): CollectedAlerts {
  return { conditions, erroredThreadIds: [], missingScopes: [], ...details };
}

/** The email `buildAlertEmail` gives for `condition` with the fakes' defaults. */
function emailFor(
  condition: AlertCondition,
  overrides: Partial<AlertEmailInput> = {},
): { to: string; subject: string; body: string } {
  return {
    to: OWNER,
    ...buildAlertEmail({
      condition,
      ownerAddress: OWNER,
      day: TODAY,
      timeZone: 'Etc/UTC',
      erroredThreadIds: [],
      missingScopes: [],
      ...overrides,
    }),
  };
}

function storedAlerts(ports: FakePorts): string | undefined {
  return ports.state.snapshot()[ALERTS_KEY];
}

function stateWrites(ports: FakePorts): number {
  return ports.state.calls.filter((call) => call.method === 'set').length;
}

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

describe('createMailAlertSink', () => {
  describe('nothing to send', () => {
    it('does nothing when no condition was collected', () => {
      const { ports, sink } = setup();

      sink.deliver(collected([]));
      sink.deliver(createAlertCollector().collected());

      expect(ports.state.calls).toEqual([]);
      expect(ports.gmail.calls).toEqual([]);
      expect(ports.mail.calls).toEqual([]);
      expect(ports.log.events).toEqual([]);
    });

    it('sends nothing the same day again: no profile call, no log, no write', () => {
      const { ports, sink } = setup();
      sink.deliver(collected(['budget_reached']));
      ports.clock.advance(HOUR_MS);

      sink.deliver(collected(['budget_reached']));

      expect(ports.mail.sent).toHaveLength(1);
      expect(ports.gmail.calls).toHaveLength(1);
      expect(ports.log.events).toHaveLength(1);
      expect(stateWrites(ports)).toBe(1);
    });
  });

  describe('one condition', () => {
    it('sends one email to the profile address, records the day and logs alert.sent', () => {
      const { ports, sink } = setup();

      sink.deliver(collected(['history_expired']));

      expect(ports.mail.sent).toEqual([emailFor('history_expired')]);
      expect(loadAlertRecord(ports.state)).toEqual({ sent: { history_expired: TODAY } });
      expect(ports.log.events).toEqual([
        {
          level: 'info',
          event: 'alert.sent',
          fields: { condition: 'history_expired', day: TODAY },
        },
      ]);
      expect(ports.gmail.calls.map((call) => call.method)).toEqual(['getProfile']);
    });

    it('sends again the next day and moves the stored day', () => {
      const { ports, sink } = setup();
      sink.deliver(collected(['budget_reached']));
      ports.clock.advance(24 * HOUR_MS);

      sink.deliver(collected(['budget_reached']));

      expect(ports.mail.sent).toEqual([
        emailFor('budget_reached'),
        emailFor('budget_reached', { day: TOMORROW }),
      ]);
      expect(loadAlertRecord(ports.state)).toEqual({ sent: { budget_reached: TOMORROW } });
      expect(ports.log.all('alert.sent').map((e) => e.fields['day'])).toEqual([TODAY, TOMORROW]);
    });

    it('sends again when the stored day is later than today (the clock moved back)', () => {
      const { ports, sink } = setup();
      saveAlertRecord(ports.state, { sent: { auth: TOMORROW } });

      sink.deliver(collected(['auth']));

      expect(ports.mail.sent).toEqual([emailFor('auth')]);
      expect(loadAlertRecord(ports.state)).toEqual({ sent: { auth: TODAY } });
    });
  });

  describe("the script's time zone", () => {
    it('records and prints the local day, not the UTC day', () => {
      const { ports, sink } = setup({ now: '2026-10-01T02:00:00Z', timeZone: 'America/Chicago' });

      sink.deliver(collected(['auth']));

      expect(loadAlertRecord(ports.state)).toEqual({ sent: { auth: '2026-09-30' } });
      expect(ports.mail.sent).toEqual([
        emailFor('auth', { day: '2026-09-30', timeZone: 'America/Chicago' }),
      ]);
      expect(ports.mail.sent[0]?.body).toContain('day 2026-09-30, time zone America/Chicago');
      expect(ports.log.find('alert.sent')?.fields).toEqual({
        condition: 'auth',
        day: '2026-09-30',
      });
    });

    it('treats the hours before and after local midnight as two days', () => {
      // 23:00 on 2026-09-30 in Chicago (UTC-5); both moments are 2026-10-01 in UTC.
      const { ports, sink } = setup({ now: '2026-10-01T04:00:00Z', timeZone: 'America/Chicago' });

      sink.deliver(collected(['auth']));
      ports.clock.advance(2 * HOUR_MS);
      sink.deliver(collected(['auth']));

      expect(ports.log.all('alert.sent').map((e) => e.fields['day'])).toEqual([
        '2026-09-30',
        '2026-10-01',
      ]);
      expect(ports.mail.sent).toHaveLength(2);
    });
  });

  describe('several conditions', () => {
    it('sends them in the collected order with one profile call and one write per email', () => {
      const { ports, sink } = setup();

      sink.deliver(collected(['history_expired', 'auth', 'budget_reached']));

      expect(ports.mail.sent).toEqual([
        emailFor('history_expired'),
        emailFor('auth'),
        emailFor('budget_reached'),
      ]);
      expect(ports.gmail.calls).toHaveLength(1);
      expect(stateWrites(ports)).toBe(3);
      expect(ports.log.all('alert.sent').map((e) => e.fields['condition'])).toEqual([
        'history_expired',
        'auth',
        'budget_reached',
      ]);
      expect(loadAlertRecord(ports.state)).toEqual({
        sent: { auth: TODAY, budget_reached: TODAY, history_expired: TODAY },
      });
    });

    it('sends only the ones not sent today', () => {
      const { ports, sink } = setup();
      saveAlertRecord(ports.state, { sent: { auth: TODAY, errored: '2026-09-29' } });

      sink.deliver(collected(['auth', 'errored', 'budget_reached']));

      expect(ports.mail.sent.map((mail) => mail.subject)).toEqual([
        emailFor('errored').subject,
        emailFor('budget_reached').subject,
      ]);
      expect(loadAlertRecord(ports.state)).toEqual({
        sent: { auth: TODAY, errored: TODAY, budget_reached: TODAY },
      });
    });
  });

  describe('details', () => {
    it('passes the errored threads and logs their number', () => {
      const { ports, sink } = setup();
      const erroredThreadIds = ['thread-a', 'thread-b'];

      sink.deliver(collected(['errored'], { erroredThreadIds }));

      expect(ports.mail.sent).toEqual([emailFor('errored', { erroredThreadIds })]);
      expect(ports.mail.sent[0]?.body).toContain('#all/thread-a');
      expect(ports.mail.sent[0]?.body).toContain('#all/thread-b');
      expect(ports.log.find('alert.sent')?.fields).toEqual({
        condition: 'errored',
        day: TODAY,
        threads: 2,
      });
    });

    it('logs the number of collected threads, not the number of links', () => {
      const { ports, sink } = setup();
      const erroredThreadIds = Array.from({ length: 60 }, (_, i) => `thread-${String(i)}`);

      sink.deliver(collected(['errored'], { erroredThreadIds }));

      expect(ports.log.find('alert.sent')?.fields['threads']).toBe(60);
    });

    it('passes the missing scopes', () => {
      const { ports, sink } = setup();
      const missingScopes = [EXTERNAL_REQUEST];

      sink.deliver(collected(['scope_missing'], { missingScopes }));

      expect(ports.mail.sent).toEqual([emailFor('scope_missing', { missingScopes })]);
      expect(ports.mail.sent[0]?.body).toContain(EXTERNAL_REQUEST);
      expect(ports.log.find('alert.sent')?.fields).toEqual({
        condition: 'scope_missing',
        day: TODAY,
      });
    });

    it('passes the failure count, and sends the uncounted text without one', () => {
      const counted = setup();
      const uncounted = setup();

      counted.sink.deliver(collected(['run_failures'], { consecutiveFailures: 4 }));
      uncounted.sink.deliver(collected(['run_failures']));

      expect(counted.ports.mail.sent).toEqual([
        emailFor('run_failures', { consecutiveFailures: 4 }),
      ]);
      expect(uncounted.ports.mail.sent).toEqual([emailFor('run_failures')]);
      expect(counted.ports.mail.sent[0]?.body).not.toBe(uncounted.ports.mail.sent[0]?.body);
    });
  });

  describe('the preflight reported a missing scope', () => {
    it('logs alert.failed for script.send_mail and calls no port', () => {
      const { ports, sink } = setup();
      saveAlertRecord(ports.state, { sent: { auth: TODAY } });
      const before = storedAlerts(ports);
      const writes = stateWrites(ports);

      sink.deliver(
        collected(['auth', 'scope_missing', 'budget_reached'], { missingScopes: [SEND_MAIL] }),
      );

      expect(ports.log.events).toEqual([
        {
          level: 'warn',
          event: 'alert.failed',
          fields: { conditions: ['scope_missing', 'budget_reached'], reason: 'scope' },
        },
      ]);
      expect(ports.mail.calls).toEqual([]);
      expect(ports.gmail.calls).toEqual([]);
      expect(stateWrites(ports)).toBe(writes);
      expect(storedAlerts(ports)).toBe(before);
    });

    it('logs nothing for script.send_mail when nothing is due', () => {
      const { ports, sink } = setup();
      saveAlertRecord(ports.state, { sent: { scope_missing: TODAY } });

      sink.deliver(collected(['scope_missing'], { missingScopes: [SEND_MAIL] }));

      expect(ports.log.events).toEqual([]);
      expect(ports.mail.calls).toEqual([]);
      expect(ports.gmail.calls).toEqual([]);
    });

    it('puts script.send_mail first when both scopes are missing', () => {
      const { ports, sink } = setup();

      sink.deliver(collected(['scope_missing'], { missingScopes: [GMAIL_MODIFY, SEND_MAIL] }));

      expect(ports.log.events.map((e) => e.fields)).toEqual([
        { conditions: ['scope_missing'], reason: 'scope' },
      ]);
    });

    it('logs alert.failed for gmail.modify without a Gmail call or a mail', () => {
      const { ports, sink } = setup();

      sink.deliver(collected(['scope_missing', 'auth'], { missingScopes: [GMAIL_MODIFY] }));

      expect(ports.log.events).toEqual([
        {
          level: 'warn',
          event: 'alert.failed',
          fields: { conditions: ['scope_missing', 'auth'], reason: 'no_owner', kind: 'scope' },
        },
      ]);
      expect(ports.gmail.calls).toEqual([]);
      expect(ports.mail.calls).toEqual([]);
      expect(storedAlerts(ports)).toBeUndefined();
    });
  });

  describe('getProfile fails', () => {
    it('logs no_owner with kind scope, records nothing, and tries again next time', () => {
      const { ports, sink } = setup();
      ports.scopes.revoke(GMAIL_MODIFY);

      sink.deliver(collected(['auth', 'budget_reached']));

      expect(ports.log.events).toEqual([
        {
          level: 'warn',
          event: 'alert.failed',
          fields: {
            conditions: ['auth', 'budget_reached'],
            reason: 'no_owner',
            kind: 'scope',
            errorMessage: SCOPE_ERROR_MESSAGE,
          },
        },
      ]);
      expect(ports.mail.calls).toEqual([]);
      expect(storedAlerts(ports)).toBeUndefined();
      expect(stateWrites(ports)).toBe(0);

      ports.scopes.grant(GMAIL_MODIFY);
      sink.deliver(collected(['auth', 'budget_reached']));

      expect(ports.mail.sent).toEqual([emailFor('auth'), emailFor('budget_reached')]);
      expect(ports.gmail.calls).toHaveLength(2);
    });

    it('logs no_owner with kind rate_limited, and tries again next time', () => {
      const { ports, sink } = setup();
      ports.gmail.failNext('getProfile', FakeGmail.rateLimited());

      sink.deliver(collected(['history_expired']));

      expect(ports.log.events).toEqual([
        {
          level: 'warn',
          event: 'alert.failed',
          fields: {
            conditions: ['history_expired'],
            reason: 'no_owner',
            kind: 'rate_limited',
            errorMessage: RATE_LIMIT_MESSAGE,
          },
        },
      ]);
      expect(ports.mail.calls).toEqual([]);
      expect(storedAlerts(ports)).toBeUndefined();

      sink.deliver(collected(['history_expired']));

      expect(ports.mail.sent).toEqual([emailFor('history_expired')]);
      expect(ports.log.all('alert.failed')).toHaveLength(1);
      expect(ports.log.all('alert.sent')).toHaveLength(1);
    });

    it('cuts errorMessage to 500 characters', () => {
      const { ports, sink } = setup();
      ports.gmail.failNext('getProfile', fail('rate_limited', { message: 'x'.repeat(600) }));

      sink.deliver(collected(['auth']));

      expect(ALERT_ERROR_MESSAGE_MAX_CHARS).toBe(500);
      expect(ports.log.find('alert.failed')?.fields['errorMessage']).toBe('x'.repeat(500));
    });

    it('lets an unrecognized Gmail failure propagate, with nothing sent or recorded', () => {
      const { ports, sink } = setup();
      const unexpected = new UnexpectedResponseError('Gmail 500', {
        service: 'gmail',
        reason: 'server_error',
      });
      ports.gmail.failNext('getProfile', unexpected);

      expect(
        caught(() => {
          sink.deliver(collected(['auth']));
        }),
      ).toBe(unexpected);
      expect(ports.mail.calls).toEqual([]);
      expect(storedAlerts(ports)).toBeUndefined();
      expect(ports.log.events).toEqual([]);
    });
  });

  describe('mail.send fails', () => {
    it('logs alert.failed with every due condition for a missing scope, and records nothing', () => {
      const { ports, sink } = setup();
      ports.scopes.revoke(SEND_MAIL);

      sink.deliver(collected(['auth', 'budget_reached']));

      expect(ports.log.events).toEqual([
        {
          level: 'warn',
          event: 'alert.failed',
          fields: {
            conditions: ['auth', 'budget_reached'],
            reason: 'scope',
            errorMessage: SCOPE_ERROR_MESSAGE,
          },
        },
      ]);
      expect(ports.mail.calls).toHaveLength(1);
      expect(ports.mail.sent).toEqual([]);
      expect(storedAlerts(ports)).toBeUndefined();
      expect(stateWrites(ports)).toBe(0);
    });

    it('stops at the quota, keeps what was sent, and sends the rest later', () => {
      const { ports, sink } = setup({ mailDailyQuota: 1 });

      sink.deliver(collected(['auth', 'budget_reached']));

      expect(ports.mail.sent).toEqual([emailFor('auth')]);
      expect(loadAlertRecord(ports.state)).toEqual({ sent: { auth: TODAY } });
      expect(ports.log.events).toEqual([
        { level: 'info', event: 'alert.sent', fields: { condition: 'auth', day: TODAY } },
        {
          level: 'warn',
          event: 'alert.failed',
          fields: {
            conditions: ['budget_reached'],
            reason: 'quota',
            errorMessage: MAIL_QUOTA_MESSAGE,
          },
        },
      ]);

      // A fresh quota, the same state, later the same day.
      const mail = new FakeMail({ scopes: ports.scopes });
      ports.clock.advance(HOUR_MS);
      createMailAlertSink({ ...ports, mail }).deliver(collected(['auth', 'budget_reached']));

      expect(mail.sent).toEqual([emailFor('budget_reached')]);
      expect(loadAlertRecord(ports.state)).toEqual({
        sent: { auth: TODAY, budget_reached: TODAY },
      });
    });

    it('lets an unrecognized mail failure propagate and keeps the first email recorded', () => {
      const { ports, sink } = setup();
      const unexpected = new UnexpectedResponseError('MailApp failed', {
        service: 'mail',
        reason: 'unrecognized',
      });
      ports.mail.failNext('send', unexpected, { after: 1 });

      expect(
        caught(() => {
          sink.deliver(collected(['auth', 'budget_reached']));
        }),
      ).toBe(unexpected);
      expect(ports.mail.sent).toEqual([emailFor('auth')]);
      expect(loadAlertRecord(ports.state)).toEqual({ sent: { auth: TODAY } });
      expect(ports.log.events.map((e) => e.event)).toEqual(['alert.sent']);
    });
  });

  describe('state.alerts fails', () => {
    it('resends one email at most after a crash between emails', () => {
      const { ports, sink } = setup();
      const full = new StateError('full', { key: ALERTS_KEY, reason: 'store_full' });
      ports.state.failNext('set', full, { key: ALERTS_KEY, after: 1 });

      expect(
        caught(() => {
          sink.deliver(collected(['auth', 'budget_reached']));
        }),
      ).toBe(full);
      expect(ports.mail.sent).toEqual([emailFor('auth'), emailFor('budget_reached')]);
      expect(loadAlertRecord(ports.state)).toEqual({ sent: { auth: TODAY } });
      expect(ports.log.all('alert.sent').map((e) => e.fields['condition'])).toEqual(['auth']);

      sink.deliver(collected(['auth', 'budget_reached']));

      expect(ports.mail.sent).toHaveLength(3);
      expect(ports.mail.sent[2]).toEqual(emailFor('budget_reached'));
      expect(loadAlertRecord(ports.state)).toEqual({
        sent: { auth: TODAY, budget_reached: TODAY },
      });
    });

    it('throws StateError for a corrupt value, sends nothing and leaves it unchanged', () => {
      const { ports, sink } = setup();
      const corrupt = '{"v":1,"sent":{"not_a_condition":"2026-09-30"}}';
      ports.state.seedRaw(ALERTS_KEY, corrupt);

      const thrown = caught(() => {
        sink.deliver(collected(['auth']));
      });

      expect(thrown).toBeInstanceOf(StateError);
      expect(ports.mail.calls).toEqual([]);
      expect(ports.gmail.calls).toEqual([]);
      expect(ports.log.events).toEqual([]);
      expect(storedAlerts(ports)).toBe(corrupt);
      expect(stateWrites(ports)).toBe(0);
    });
  });

  describe('through runEntry', () => {
    const SCHEDULED: RunEntryOptions = {
      entry: 'onTrigger',
      kind: 'scheduled',
      heartbeat: true,
      tallyGmail: true,
    };

    function runSetup(): Setup & { readonly deps: RunEntryDeps } {
      const { ports, sink } = setup();
      const config = loadConfig({
        defaultThreshold: 0.8,
        triggerIntervalMinutes: 10,
        rules: [{ id: 'bill', question: 'Is this email a bill?', label: 'Bill' }],
      });
      const deps: RunEntryDeps = {
        lock: ports.lock,
        clock: ports.clock,
        state: ports.state,
        log: ports.log,
        gmail: ports.gmail,
        alertSink: sink,
        loadConfig: () => config,
      };
      return { ports, sink, deps };
    }

    it('sends one email for a condition the body added, and returns the result', () => {
      const { ports, deps } = runSetup();
      const result = { summary: { classified: 0 } };

      const returned = runEntry(SCHEDULED, deps, (ctx) => {
        ctx.alerts.add('history_expired');
        return result;
      });

      expect(returned).toBe(result);
      expect(ports.mail.sent).toEqual([emailFor('history_expired')]);
      expect(ports.log.all('alert.sent')).toHaveLength(1);
      expect(ports.log.all('run.failed')).toEqual([]);
      expect(ports.lock.isHeld).toBe(false);
    });

    it('sends the auth email for a missing key and rethrows the same error', () => {
      const { ports, deps } = runSetup();
      const abort = new RunAbortError('no key', { reason: 'missing_key' });

      const thrown = caught(() =>
        runEntry(SCHEDULED, deps, () => {
          throw abort;
        }),
      );

      expect(thrown).toBe(abort);
      expect(ports.mail.sent).toEqual([emailFor('auth')]);
      expect(loadAlertRecord(ports.state)).toEqual({ sent: { auth: TODAY } });
      expect(ports.log.all('run.failed')).toHaveLength(1);
      expect(ports.lock.isHeld).toBe(false);
    });

    it('logs a corrupt state.alerts as a failed finally step and keeps the result', () => {
      const { ports, deps } = runSetup();
      const corrupt = '{"v":99}';
      ports.state.seedRaw(ALERTS_KEY, corrupt);
      const result = { summary: { classified: 0 } };

      const returned = runEntry(SCHEDULED, deps, (ctx) => {
        ctx.alerts.add('history_expired');
        return result;
      });

      expect(returned).toBe(result);
      expect(ports.log.all('run.failed').map((e) => e.fields)).toEqual([
        expect.objectContaining({ phase: 'finally', step: 'alerts', error: 'StateError' }),
      ]);
      expect(ports.mail.calls).toEqual([]);
      expect(storedAlerts(ports)).toBe(corrupt);
      expect(ports.lock.isHeld).toBe(false);
    });

    it("doesn't count the sink's getProfile in state.gmailCalls", () => {
      const { ports, deps } = runSetup();

      runEntry(SCHEDULED, deps, (ctx) => {
        ctx.gmail.listLabels();
        ctx.alerts.add('budget_reached');
        return {};
      });

      expect(ports.gmail.calls.map((call) => call.method)).toEqual(['listLabels', 'getProfile']);
      expect(decodeGmailCalls(ports.state.get(GMAIL_CALLS_KEY)).count).toBe(1);
      expect(ports.mail.sent).toHaveLength(1);
    });
  });
});

describe('the state.alerts store', () => {
  it('gives undefined for an absent key and writes nothing', () => {
    const { ports } = setup();

    expect(loadAlertRecord(ports.state)).toBeUndefined();
    expect(stateWrites(ports)).toBe(0);
    expect(storedAlerts(ports)).toBeUndefined();
  });

  it('round-trips a record', () => {
    const { ports } = setup();

    saveAlertRecord(ports.state, { sent: { history_expired: TODAY, auth: '2026-09-29' } });

    expect(loadAlertRecord(ports.state)).toEqual({
      sent: { auth: '2026-09-29', history_expired: TODAY },
    });
    expect(storedAlerts(ports)).toBe(
      '{"v":1,"sent":{"auth":"2026-09-29","history_expired":"2026-09-30"}}',
    );
  });

  it('lets a failed write propagate', () => {
    const { ports } = setup();
    const full = new StateError('full', { key: ALERTS_KEY, reason: 'store_full' });
    ports.state.failNext('set', full, { key: ALERTS_KEY });

    expect(
      caught(() => {
        saveAlertRecord(ports.state, { sent: { auth: TODAY } });
      }),
    ).toBe(full);
    expect(storedAlerts(ports)).toBe(undefined);
  });
});
