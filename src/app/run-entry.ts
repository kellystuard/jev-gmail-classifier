/**
 * The per-run error boundary (Solution Design §10.1, §10.4; ADR-0006,
 * ADR-0008; epic #13 decision 6).
 *
 * Every entry point that touches state runs its body through `runEntry`:
 *
 * 1. `lock.tryAcquire()`; busy → `run.skipped` and `{skipped: 'busy'}`, nothing else.
 * 2. The `state.runs` heartbeat's `lastStart` (when `heartbeat`).
 * 3. `loadConfig()`, the run limits, the `Deadline`.
 * 4. The daily Gmail call tally (when `tallyGmail`), and the counting `GmailPort`.
 * 5. `run.start`, then the body.
 * 6. Success: the heartbeat's `lastEnd`, `lastOutcome: 'ok'`, `lastSummary`.
 *    Failure: `run.failed`, the heartbeat's failure, then the error is rethrown.
 * 7. `finally`: save the tally, deliver the alerts, release the lock (last).
 *
 * This is the only place a run's exceptions are caught (Engineering Standards
 * §5). `run.end` is the body's: only it knows the fields.
 */
import type { Config } from '../config/schema.ts';
import type { AlertCondition } from '../core/alert-condition.ts';
import { type Deadline, createDeadline } from '../core/deadline.ts';
import { ConfigError, JevClassifierError, RunAbortError } from '../core/errors.ts';
import { type GmailCallTally, addGmailCalls } from '../core/gmail-calls.ts';
import type { LogFields } from '../core/log-fields.ts';
import {
  type RunRecord,
  type RunSummary,
  RUNS_KEY,
  decodeRunRecord,
  encodeRunRecord,
  recordFailure,
  recordStart,
  recordSuccess,
} from '../core/run-record.ts';
import { type RunLimits, runLimits } from '../core/run-limits.ts';
import { dayInTimeZone } from '../core/token-budget.ts';
import type { ClockPort } from '../ports/clock-port.ts';
import type { GmailPort } from '../ports/gmail-port.ts';
import type { LockPort } from '../ports/lock-port.ts';
import type { LogPort } from '../ports/log-port.ts';
import type { StatePort } from '../ports/state-port.ts';
import { type AlertCollector, type AlertSink, createAlertCollector } from './alerts.ts';
import { countGmailCalls, loadGmailCalls, saveGmailCalls } from './counting-gmail.ts';

export type RunEntryKind = 'scheduled' | 'manual' | 'lifecycle';

export type GmailUsage = {
  /** Gmail calls made by this run so far. */
  readonly calls: number;
  /** Their quota units. */
  readonly units: number;
  /** Today's calls, this run's included (this run's only when the tally is off). */
  readonly callsToday: number;
};

export type RunContext = {
  readonly config: Config;
  readonly deadline: Deadline;
  readonly limits: RunLimits;
  /** The counting wrapper: use it for every Gmail call of the run. */
  readonly gmail: GmailPort;
  gmailUsage(): GmailUsage;
  readonly alerts: AlertCollector;
};

export type RunEntryOptions = {
  /**
   * The entry point, such as `onTrigger` or `install`. Not logged here: the
   * log adapter adds `entry` to every event (SD §10.5).
   */
  readonly entry: string;
  /** `lifecycle` (`install`, `uninstall`) gets the `scheduled` limits of its interval. */
  readonly kind: RunEntryKind;
  /** Write `state.runs` at the start and end (`onTrigger`, manual entries). */
  readonly heartbeat: boolean;
  /** Load and save `state.gmailCalls` (every entry but `uninstall`). */
  readonly tallyGmail: boolean;
};

export type RunEntryDeps = {
  readonly lock: LockPort;
  readonly clock: ClockPort;
  readonly state: StatePort;
  readonly log: LogPort;
  readonly gmail: GmailPort;
  readonly alertSink: AlertSink;
  readonly loadConfig: () => Config;
};

/**
 * Runs `body` under the script lock, with the config, limits, `Deadline`, a
 * counting Gmail port and an alert collector. Returns the body's result
 * unchanged, or `{skipped: 'busy'}` when another execution holds the lock.
 * Anything thrown is logged as `run.failed`, recorded, and **rethrown** (the
 * same object) so the execution shows as Failed.
 */
export function runEntry<T extends { readonly summary?: RunSummary }>(
  options: RunEntryOptions,
  deps: RunEntryDeps,
  body: (ctx: RunContext) => T,
): T | { readonly skipped: 'busy' } {
  const { lock, clock, state, log } = deps;
  if (!lock.tryAcquire()) {
    log.info('run.skipped', { kind: options.kind, reason: 'busy' });
    return { skipped: 'busy' };
  }

  const startedAt = clock.now();
  const alerts = createAlertCollector();
  const counting = countGmailCalls(deps.gmail);
  let tally: GmailCallTally | undefined;
  let started: RunRecord | undefined;

  const gmailUsage = (): GmailUsage => ({
    calls: counting.calls(),
    units: counting.units(),
    callsToday:
      tally === undefined ? counting.calls() : addGmailCalls(tally, counting.calls()).count,
  });

  try {
    if (options.heartbeat) {
      const raw = state.get(RUNS_KEY);
      started = recordStart(raw === undefined ? undefined : decodeRunRecord(raw), startedAt);
      state.set(RUNS_KEY, encodeRunRecord(started));
    }
    const config = deps.loadConfig();
    const limits = runLimits(
      options.kind === 'manual' ? 'manual' : 'scheduled',
      config.triggerIntervalMinutes,
    );
    // The Deadline starts at its own creation, a few ms after the lock.
    const deadline = createDeadline(() => clock.now(), limits);
    if (options.tallyGmail) {
      tally = loadGmailCalls(state, dayInTimeZone(startedAt, clock.timeZone()));
    }
    log.info('run.start', {
      kind: options.kind,
      softLimitMs: limits.softLimitMs,
      reserveMs: limits.reserveMs,
      chunkSize: limits.chunkSize,
      maxGmailUnitsPerRun: limits.maxGmailUnitsPerRun,
    });

    const result = body({ config, deadline, limits, gmail: counting.gmail, gmailUsage, alerts });

    if (started !== undefined) {
      state.set(RUNS_KEY, encodeRunRecord(recordSuccess(started, clock.now(), result.summary)));
    }
    return result;
  } catch (error) {
    const condition = alertFor(error);
    if (condition !== undefined) alerts.add(condition);
    log.error('run.failed', {
      kind: options.kind,
      ...errorFields(error),
      elapsedMs: Math.max(0, clock.now() - startedAt),
      alerts: alerts.collected().conditions,
    });
    if (started !== undefined) {
      const record = started;
      step(log, 'heartbeat', () => {
        state.set(RUNS_KEY, encodeRunRecord(recordFailure(record, clock.now())));
      });
    }
    throw error;
  } finally {
    if (tally !== undefined) {
      const loaded = tally;
      step(log, 'gmail_calls', () => {
        saveGmailCalls(state, addGmailCalls(loaded, counting.calls()));
      });
    }
    step(log, 'alerts', () => {
      deps.alertSink.deliver(alerts.collected());
    });
    step(log, 'unlock', () => {
      lock.release();
    });
  }
}

/** The alert a run failure raises, if any. E9's `run_failures` comes from `state.runs`, not from here. */
function alertFor(error: unknown): AlertCondition | undefined {
  if (error instanceof ConfigError) return 'config_invalid';
  if (!(error instanceof RunAbortError)) return undefined;
  switch (error.reason) {
    case 'auth':
    case 'missing_key':
      return 'auth';
    case 'config_invalid':
      return 'config_invalid';
    case 'scope_missing':
      return 'scope_missing';
  }
}

/**
 * The error's log fields: a `JevClassifierError`'s `toLogFields()` (which
 * sets `error` and `errorMessage`), another `Error`'s name and message, or
 * `error: 'unknown'` for a thrown non-`Error`. Never a stack.
 */
function errorFields(error: unknown): LogFields {
  if (error instanceof JevClassifierError) return error.toLogFields();
  if (error instanceof Error) return { error: error.name, errorMessage: error.message };
  return { error: 'unknown' };
}

/**
 * Runs one clean-up step. A throw is logged as `run.failed` with `phase:
 * 'finally'` and `step`, and swallowed, so the next step still runs and the
 * run's own error (or result) isn't hidden.
 */
function step(log: LogPort, name: string, action: () => void): void {
  try {
    action();
  } catch (error) {
    log.error('run.failed', { ...errorFields(error), phase: 'finally', step: name });
  }
}
