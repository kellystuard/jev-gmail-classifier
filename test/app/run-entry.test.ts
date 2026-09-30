import { describe, expect, it } from 'vitest';

import type { AlertSink, CollectedAlerts } from '../../src/app/alerts.ts';
import {
  type RunContext,
  type RunEntryDeps,
  type RunEntryOptions,
  runEntry,
} from '../../src/app/run-entry.ts';
import { loadConfig } from '../../src/config/loader.ts';
import type { Config } from '../../src/config/schema.ts';
import type { AlertCondition } from '../../src/core/alert-condition.ts';
import { ConfigError, RunAbortError, StateError } from '../../src/core/errors.ts';
import { GMAIL_CALLS_KEY, decodeGmailCalls } from '../../src/core/gmail-calls.ts';
import { type RunRecord, RUNS_KEY, decodeRunRecord } from '../../src/core/run-record.ts';
import { runLimits } from '../../src/core/run-limits.ts';
import type { LockPort } from '../../src/ports/lock-port.ts';
import { type FakePorts, createFakePorts } from '../fakes/fake-ports.ts';

const NOW = Date.parse('2026-09-30T12:00:00Z');
const TODAY = '2026-09-30';

const SCHEDULED: RunEntryOptions = {
  entry: 'onTrigger',
  kind: 'scheduled',
  heartbeat: true,
  tallyGmail: true,
};
const MANUAL: RunEntryOptions = {
  entry: 'startManualRun',
  kind: 'manual',
  heartbeat: true,
  tallyGmail: true,
};
const INSTALL: RunEntryOptions = {
  entry: 'install',
  kind: 'lifecycle',
  heartbeat: false,
  tallyGmail: true,
};
const UNINSTALL: RunEntryOptions = {
  entry: 'uninstall',
  kind: 'lifecycle',
  heartbeat: false,
  tallyGmail: false,
};

function config(triggerIntervalMinutes: 1 | 5 | 10 | 15 | 30 = 10): Config {
  return loadConfig({
    defaultThreshold: 0.8,
    triggerIntervalMinutes,
    rules: [{ id: 'bill', question: 'Is this email a bill?', label: 'Bill' }],
  });
}

type Setup = {
  readonly ports: FakePorts;
  readonly deps: RunEntryDeps;
  /** Every `deliver` call's argument, in order. */
  readonly delivered: CollectedAlerts[];
  /** How many times `loadConfig` ran. */
  loads(): number;
};

function setup(
  options: {
    readonly now?: number | string;
    readonly timeZone?: string;
    readonly config?: () => Config;
    readonly sink?: AlertSink;
    readonly lock?: LockPort;
  } = {},
): Setup {
  const ports = createFakePorts({
    now: options.now ?? NOW,
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
  });
  const delivered: CollectedAlerts[] = [];
  let loads = 0;
  const load = options.config ?? (() => config());
  const deps: RunEntryDeps = {
    lock: options.lock ?? ports.lock,
    clock: ports.clock,
    state: ports.state,
    log: ports.log,
    gmail: ports.gmail,
    alertSink: options.sink ?? {
      deliver: (alerts) => {
        delivered.push(alerts);
      },
    },
    loadConfig: () => {
      loads += 1;
      return load();
    },
  };
  return { ports, deps, delivered, loads: () => loads };
}

function storedRuns(ports: FakePorts): RunRecord | undefined {
  const raw = ports.state.get(RUNS_KEY);
  return raw === undefined ? undefined : decodeRunRecord(raw);
}

function storedCalls(ports: FakePorts): number | undefined {
  const raw = ports.state.get(GMAIL_CALLS_KEY);
  return raw === undefined ? undefined : decodeGmailCalls(raw).count;
}

function seedCalls(ports: FakePorts, day: string, count: number): void {
  ports.state.seedRaw(GMAIL_CALLS_KEY, JSON.stringify({ v: 1, day, count }));
}

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

/** The state keys a call touched, by method. */
function touchedKeys(ports: FakePorts, method: 'get' | 'set' | 'delete'): unknown[] {
  return ports.state.calls.filter((call) => call.method === method).map((call) => call.args[0]);
}

describe('runEntry', () => {
  describe('a busy lock', () => {
    it('logs run.skipped, returns busy and does nothing else', () => {
      const s = setup();
      s.ports.lock.holdByOther();
      seedCalls(s.ports, TODAY, 3);
      const before = s.ports.state.snapshot();
      let called = false;

      const result = runEntry(SCHEDULED, s.deps, () => {
        called = true;
        return {};
      });

      expect(result).toEqual({ skipped: 'busy' });
      expect(called).toBe(false);
      expect(s.loads()).toBe(0);
      expect(s.ports.log.events).toEqual([
        { level: 'info', event: 'run.skipped', fields: { kind: 'scheduled', reason: 'busy' } },
      ]);
      expect(s.ports.log.find('run.start')).toBeUndefined();
      expect(s.ports.state.calls).toEqual([]);
      expect(s.ports.state.snapshot()).toEqual(before);
      expect(s.delivered).toEqual([]);
      expect(s.ports.lock.isHeldByOther).toBe(true);
    });
  });

  describe('a successful run', () => {
    it('runs the steps in order, gives the body its context and records the end', () => {
      const s = setup();
      seedCalls(s.ports, TODAY, 7);
      const load = s.deps.loadConfig;
      let heartbeatAtLoad: RunRecord | undefined;
      const deps: RunEntryDeps = {
        ...s.deps,
        loadConfig: () => {
          heartbeatAtLoad = storedRuns(s.ports);
          expect(s.ports.lock.isHeld).toBe(true);
          return load();
        },
      };
      const expected = { summary: { classified: 2, errored: 0 }, extra: 'kept' };
      let seen: RunContext | undefined;

      const result = runEntry(SCHEDULED, deps, (ctx) => {
        seen = ctx;
        expect(s.ports.log.events.map((e) => e.event)).toEqual(['run.start']);
        expect(ctx.limits).toEqual(runLimits('scheduled', 10));
        expect(ctx.config.triggerIntervalMinutes).toBe(10);
        expect(ctx.deadline.startedAt).toBe(NOW);
        expect(ctx.deadline.remaining()).toBe(30_000);
        s.ports.clock.advance(5000);
        expect(ctx.deadline.remaining()).toBe(25_000);
        expect(ctx.gmailUsage()).toEqual({ calls: 0, units: 0, callsToday: 7 });
        ctx.gmail.getProfile();
        ctx.gmail.getThread('missing', { format: 'minimal' });
        expect(ctx.gmailUsage()).toEqual({ calls: 2, units: 41, callsToday: 9 });
        expect(s.ports.gmail.calls).toHaveLength(2);
        s.ports.log.info('run.end', { classified: 2 });
        return expected;
      });

      expect(result).toBe(expected);
      expect(seen).toBeDefined();
      expect(heartbeatAtLoad).toEqual({ lastStart: NOW, consecutiveFailures: 0 });
      expect(s.ports.log.find('run.start')).toEqual({
        level: 'info',
        event: 'run.start',
        fields: {
          kind: 'scheduled',
          softLimitMs: 30_000,
          reserveMs: 10_000,
          chunkSize: 20,
          maxGmailUnitsPerRun: 3000,
        },
      });
      expect(s.ports.log.events.map((e) => e.event)).toEqual(['run.start', 'run.end']);
      expect(storedRuns(s.ports)).toEqual({
        lastStart: NOW,
        lastEnd: NOW + 5000,
        lastOutcome: 'ok',
        consecutiveFailures: 0,
        lastSummary: { classified: 2, errored: 0 },
      });
      expect(storedCalls(s.ports)).toBe(9);
      expect(s.ports.lock.isHeld).toBe(false);
      expect(s.ports.lock.acquireCount).toBe(1);
      expect(s.delivered).toEqual([{ conditions: [], erroredThreadIds: [], missingScopes: [] }]);
    });

    it('hands the body collector to the sink', () => {
      const s = setup();
      runEntry(SCHEDULED, s.deps, (ctx) => {
        ctx.alerts.addAll(['history_expired']);
        ctx.alerts.add('errored', { threadIds: ['t1'] });
        return {};
      });
      expect(s.delivered).toEqual([
        { conditions: ['history_expired', 'errored'], erroredThreadIds: ['t1'], missingScopes: [] },
      ]);
    });

    it('stores no summary when the body returns none', () => {
      const s = setup();
      s.ports.state.seedRaw(
        RUNS_KEY,
        JSON.stringify({ v: 1, lastStart: 1, consecutiveFailures: 0, lastSummary: { old: 1 } }),
      );
      runEntry(SCHEDULED, s.deps, () => ({}));
      expect(storedRuns(s.ports)).toEqual({
        lastStart: NOW,
        lastEnd: NOW,
        lastOutcome: 'ok',
        consecutiveFailures: 0,
      });
    });

    it.each([
      ['manual', MANUAL, 10, runLimits('manual', 10)],
      ['manual on a 1-minute interval', MANUAL, 1, runLimits('manual', 1)],
      ['lifecycle', INSTALL, 10, runLimits('scheduled', 10)],
      ['lifecycle on a 5-minute interval', INSTALL, 5, runLimits('scheduled', 5)],
      ['scheduled on a 1-minute interval', SCHEDULED, 1, runLimits('scheduled', 1)],
    ] as const)('gives a %s run its limits', (_name, options, interval, limits) => {
      const s = setup({ config: () => config(interval) });
      runEntry(options, s.deps, (ctx) => {
        expect(ctx.limits).toEqual(limits);
        expect(ctx.deadline.remaining()).toBe(limits.softLimitMs);
        return {};
      });
      expect(s.ports.log.find('run.start')?.fields).toMatchObject({
        kind: options.kind,
        softLimitMs: limits.softLimitMs,
        chunkSize: limits.chunkSize,
      });
    });
  });

  describe('a failing run', () => {
    type Case = {
      readonly name: string;
      readonly error: unknown;
      /** Thrown by `loadConfig` instead of the body. */
      readonly atLoad?: boolean;
      readonly alerts: readonly AlertCondition[];
      readonly fields: Readonly<Record<string, unknown>>;
    };
    const cases: readonly Case[] = [
      {
        name: 'RunAbortError auth',
        error: new RunAbortError('401 from Jev', { reason: 'auth' }),
        alerts: ['auth'],
        fields: { error: 'RunAbortError', reason: 'auth', errorMessage: '401 from Jev' },
      },
      {
        name: 'RunAbortError missing_key',
        error: new RunAbortError('No key', { reason: 'missing_key' }),
        alerts: ['auth'],
        fields: { error: 'RunAbortError', reason: 'missing_key' },
      },
      {
        name: 'RunAbortError config_invalid',
        error: new RunAbortError('Unknown model', { reason: 'config_invalid' }),
        alerts: ['config_invalid'],
        fields: { error: 'RunAbortError', reason: 'config_invalid' },
      },
      {
        name: 'RunAbortError scope_missing',
        error: new RunAbortError('No gmail.modify', { reason: 'scope_missing' }),
        alerts: ['scope_missing'],
        fields: { error: 'RunAbortError', reason: 'scope_missing' },
      },
      {
        name: 'ConfigError from loadConfig',
        error: new ConfigError([{ path: 'rules[0].threshold', message: 'Too big' }]),
        atLoad: true,
        alerts: ['config_invalid'],
        fields: { error: 'ConfigError', issues: ['rules[0].threshold: Too big'] },
      },
      {
        name: 'a plain TypeError',
        error: new TypeError('x is not a function'),
        alerts: [],
        fields: { error: 'TypeError', errorMessage: 'x is not a function' },
      },
      {
        name: 'a thrown string',
        error: 'boom',
        alerts: [],
        fields: { error: 'unknown' },
      },
    ];

    it.each(cases)('$name: logs, records, alerts, rethrows the same object', (c) => {
      const s = setup({
        config: () => {
          if (c.atLoad === true) throw c.error;
          return config();
        },
      });
      seedCalls(s.ports, TODAY, 4);

      const thrown = caught(() =>
        runEntry(SCHEDULED, s.deps, (ctx) => {
          ctx.gmail.getProfile();
          s.ports.clock.advance(1500);
          throw c.error;
        }),
      );

      expect(thrown).toBe(c.error);
      const failed = s.ports.log.all('run.failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]?.level).toBe('error');
      expect(failed[0]?.fields).toMatchObject({
        kind: 'scheduled',
        ...c.fields,
        elapsedMs: c.atLoad === true ? 0 : 1500,
        alerts: c.alerts,
      });
      expect(Object.keys(failed[0]?.fields ?? {})).not.toContain('stack');
      expect(storedRuns(s.ports)).toMatchObject({
        lastStart: NOW,
        lastEnd: c.atLoad === true ? NOW : NOW + 1500,
        lastOutcome: 'failed',
        consecutiveFailures: 1,
      });
      // The tally is loaded after the config: a config failure makes no call and saves nothing new.
      expect(storedCalls(s.ports)).toBe(c.atLoad === true ? 4 : 5);
      expect(s.delivered).toEqual([
        { conditions: c.alerts, erroredThreadIds: [], missingScopes: [] },
      ]);
      expect(s.ports.lock.isHeld).toBe(false);
    });

    it('keeps the alerts the body collected before it threw', () => {
      const s = setup();
      caught(() =>
        runEntry(SCHEDULED, s.deps, (ctx) => {
          ctx.alerts.add('history_expired');
          throw new RunAbortError('401', { reason: 'auth' });
        }),
      );
      expect(s.ports.log.find('run.failed')?.fields['alerts']).toEqual(['history_expired', 'auth']);
      expect(s.delivered[0]?.conditions).toEqual(['history_expired', 'auth']);
    });

    it('counts consecutive failures 1, 2, then 0 after a success', () => {
      const s = setup();
      const fail = (): void => {
        caught(() =>
          runEntry(SCHEDULED, s.deps, () => {
            throw new TypeError('bug');
          }),
        );
      };
      fail();
      expect(storedRuns(s.ports)?.consecutiveFailures).toBe(1);
      s.ports.clock.advance(60_000);
      fail();
      expect(storedRuns(s.ports)?.consecutiveFailures).toBe(2);
      s.ports.clock.advance(60_000);
      runEntry(SCHEDULED, s.deps, () => ({ summary: { classified: 1 } }));
      expect(storedRuns(s.ports)).toEqual({
        lastStart: NOW + 120_000,
        lastEnd: NOW + 120_000,
        lastOutcome: 'ok',
        consecutiveFailures: 0,
        lastSummary: { classified: 1 },
      });
    });

    it('fails the run on a corrupt state.runs, and overwrites nothing', () => {
      const s = setup();
      s.ports.state.seedRaw(RUNS_KEY, '{"v":1,"lastStart":"soon"}');
      seedCalls(s.ports, TODAY, 2);
      const before = s.ports.state.snapshot();
      let called = false;

      const thrown = caught(() =>
        runEntry(SCHEDULED, s.deps, () => {
          called = true;
          return {};
        }),
      );

      expect(thrown).toBeInstanceOf(StateError);
      expect(thrown).toMatchObject({ key: RUNS_KEY });
      expect(called).toBe(false);
      expect(s.loads()).toBe(0);
      expect(s.ports.log.find('run.failed')?.fields).toMatchObject({
        error: 'StateError',
        key: RUNS_KEY,
        reason: 'schema',
        alerts: [],
      });
      expect(touchedKeys(s.ports, 'set')).toEqual([]);
      expect(s.ports.state.snapshot()).toEqual(before);
      expect(s.ports.lock.isHeld).toBe(false);
      expect(s.delivered).toHaveLength(1);
    });

    it('treats a failed success heartbeat as a run failure and records it', () => {
      const s = setup();
      const full = new StateError('full', { key: RUNS_KEY, reason: 'store_full' });
      s.ports.state.failNext('set', full, { key: RUNS_KEY, after: 1 });
      const result = { summary: { classified: 1 } };

      const thrown = caught(() => runEntry(SCHEDULED, s.deps, () => result));

      expect(thrown).toBe(full);
      expect(s.ports.log.all('run.failed')).toHaveLength(1);
      expect(storedRuns(s.ports)).toMatchObject({ lastOutcome: 'failed', consecutiveFailures: 1 });
      expect(s.ports.lock.isHeld).toBe(false);
    });

    it('logs a failed failure heartbeat and still rethrows the first error', () => {
      const s = setup();
      const full = new StateError('full', { key: RUNS_KEY, reason: 'store_full' });
      s.ports.state.failNext('set', full, { key: RUNS_KEY, after: 1, times: 2 });

      const thrown = caught(() => runEntry(SCHEDULED, s.deps, () => ({})));

      expect(thrown).toBe(full);
      const failed = s.ports.log.all('run.failed');
      expect(failed).toHaveLength(2);
      expect(failed[1]?.fields).toMatchObject({
        phase: 'finally',
        step: 'heartbeat',
        error: 'StateError',
      });
      expect(storedRuns(s.ports)).toEqual({ lastStart: NOW, consecutiveFailures: 0 });
      expect(s.ports.lock.isHeld).toBe(false);
    });
  });

  describe('heartbeat and tally switches', () => {
    it('writes no state.runs with the heartbeat off, on success or failure', () => {
      const s = setup();
      runEntry(INSTALL, s.deps, () => ({ summary: { ok: 1 } }));
      caught(() =>
        runEntry(INSTALL, s.deps, () => {
          throw new RunAbortError('No key', { reason: 'missing_key' });
        }),
      );
      expect(touchedKeys(s.ports, 'get')).not.toContain(RUNS_KEY);
      expect(touchedKeys(s.ports, 'set')).not.toContain(RUNS_KEY);
      expect(s.ports.state.snapshot()[RUNS_KEY]).toBeUndefined();
    });

    it('saves the tally for install (heartbeat off, tally on)', () => {
      const s = setup();
      runEntry(INSTALL, s.deps, (ctx) => {
        ctx.gmail.getProfile();
        return {};
      });
      expect(storedCalls(s.ports)).toBe(1);
    });

    it('leaves the store empty after an uninstall-like body deletes state.*', () => {
      const s = setup();
      seedCalls(s.ports, TODAY, 9);
      s.ports.state.seedRaw(
        RUNS_KEY,
        JSON.stringify({ v: 1, lastStart: 1, consecutiveFailures: 0 }),
      );
      s.ports.state.seedRaw('state.position', JSON.stringify({ v: 1, historyId: '1', savedAt: 1 }));

      const result = runEntry(UNINSTALL, s.deps, (ctx) => {
        ctx.gmail.getProfile();
        expect(ctx.gmailUsage()).toEqual({ calls: 1, units: 1, callsToday: 1 });
        for (const key of s.ports.state.keys('state.')) s.ports.state.delete(key);
        return { summary: { keysDeleted: 3 } };
      });

      expect(result).toEqual({ summary: { keysDeleted: 3 } });
      expect(s.ports.state.snapshot()).toEqual({});
      expect(touchedKeys(s.ports, 'get')).toEqual([]);
      expect(touchedKeys(s.ports, 'set')).toEqual([]);
      expect(s.delivered).toHaveLength(1);
      expect(s.ports.lock.isHeld).toBe(false);
    });
  });

  describe('failures in finally', () => {
    it('keeps the body error when saving the tally fails', () => {
      const s = setup();
      const abort = new RunAbortError('401', { reason: 'auth' });
      s.ports.state.failNext(
        'set',
        new StateError('full', { key: GMAIL_CALLS_KEY, reason: 'store_full' }),
        { key: GMAIL_CALLS_KEY },
      );

      const thrown = caught(() =>
        runEntry(SCHEDULED, s.deps, (ctx) => {
          ctx.gmail.getProfile();
          throw abort;
        }),
      );

      expect(thrown).toBe(abort);
      expect(s.ports.log.all('run.failed').map((e) => e.fields)).toEqual([
        expect.objectContaining({ error: 'RunAbortError', reason: 'auth' }),
        expect.objectContaining({
          phase: 'finally',
          step: 'gmail_calls',
          error: 'StateError',
          reason: 'store_full',
        }),
      ]);
      expect(s.delivered).toHaveLength(1);
      expect(s.ports.lock.isHeld).toBe(false);
    });

    it('still returns the result when the sink throws', () => {
      const s = setup({
        sink: {
          deliver: () => {
            throw new Error('mail down');
          },
        },
      });
      const expected = { summary: { classified: 1 } };

      expect(runEntry(SCHEDULED, s.deps, () => expected)).toBe(expected);

      expect(s.ports.log.all('run.failed')).toEqual([
        {
          level: 'error',
          event: 'run.failed',
          fields: { error: 'Error', errorMessage: 'mail down', phase: 'finally', step: 'alerts' },
        },
      ]);
      expect(storedRuns(s.ports)?.lastOutcome).toBe('ok');
      expect(s.ports.lock.isHeld).toBe(false);
    });

    it('logs a release that throws, after every other step', () => {
      const order: string[] = [];
      const lock: LockPort = {
        tryAcquire: () => true,
        release: () => {
          order.push('release');
          throw new Error('lock gone');
        },
      };
      const s = setup({
        lock,
        sink: {
          deliver: () => {
            order.push('deliver');
          },
        },
      });

      expect(runEntry(SCHEDULED, s.deps, () => ({}))).toEqual({});
      expect(order).toEqual(['deliver', 'release']);
      expect(s.ports.log.find('run.failed')?.fields).toMatchObject({
        phase: 'finally',
        step: 'unlock',
        errorMessage: 'lock gone',
      });
    });
  });

  it("counts the tally's day in the script's time zone", () => {
    // 03:30 UTC on 1 October is still 30 September in Los Angeles.
    const s = setup({ now: '2026-10-01T03:30:00Z', timeZone: 'America/Los_Angeles' });
    seedCalls(s.ports, '2026-09-30', 5);
    runEntry(SCHEDULED, s.deps, (ctx) => {
      ctx.gmail.getProfile();
      expect(ctx.gmailUsage().callsToday).toBe(6);
      return {};
    });
    expect(decodeGmailCalls(s.ports.state.get(GMAIL_CALLS_KEY))).toEqual({
      day: '2026-09-30',
      count: 6,
    });
  });

  it('starts a new day at 0 in the script time zone', () => {
    // 23:30 UTC on 30 September is already 1 October in Tokyo.
    const s = setup({ now: '2026-09-30T23:30:00Z', timeZone: 'Asia/Tokyo' });
    seedCalls(s.ports, '2026-09-30', 5);
    runEntry(SCHEDULED, s.deps, (ctx) => {
      ctx.gmail.getProfile();
      return {};
    });
    expect(decodeGmailCalls(s.ports.state.get(GMAIL_CALLS_KEY))).toEqual({
      day: '2026-10-01',
      count: 1,
    });
  });
});
