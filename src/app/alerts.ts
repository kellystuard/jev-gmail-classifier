/**
 * The per-run alert collector and the sink that delivers what it collected
 * (Solution Design §10.5 "Alerts"; epic #13 decision 6).
 *
 * Use cases return the conditions they detect; the run adds them to one
 * collector, and `runEntry` hands `collected()` to the `AlertSink` in its
 * `finally`. E7's sink does nothing (the conditions are already in `run.end`
 * or `run.failed`); the sink that sends, at most once per condition per day,
 * is `createMailAlertSink` (`src/app/alert-mailer.ts`, #302).
 */
import type { AlertCondition } from '../core/alert-condition.ts';

export type AlertDetails = {
  /** For `errored`: the threads that got `Jev/Error`. */
  readonly threadIds?: readonly string[];
  /** For `scope_missing`: the missing scopes. */
  readonly scopes?: readonly string[];
  /** For `run_failures`: failed or unfinished runs in a row. */
  readonly consecutiveFailures?: number;
};

export type CollectedAlerts = {
  /** De-duplicated, in first-seen order. */
  readonly conditions: readonly AlertCondition[];
  /** From `errored` details, de-duplicated, first-seen order. */
  readonly erroredThreadIds: readonly string[];
  /** From `scope_missing` details, de-duplicated, first-seen order. */
  readonly missingScopes: readonly string[];
  /** From `run_failures` details: the latest count given. Absent when none was given. */
  readonly consecutiveFailures?: number;
};

export interface AlertCollector {
  /**
   * Adds a condition (again is a no-op). `details.threadIds` count only for
   * `errored`, `details.scopes` only for `scope_missing`, and
   * `details.consecutiveFailures` only for `run_failures` (the latest one
   * given replaces an earlier one; adding without it keeps the earlier one).
   */
  add(condition: AlertCondition, details?: AlertDetails): void;
  /** Adds each condition, for the `alerts` arrays E3–E6 return. */
  addAll(conditions: readonly AlertCondition[]): void;
  /** A snapshot: fresh arrays, unaffected by later `add` calls. */
  collected(): CollectedAlerts;
}

export function createAlertCollector(): AlertCollector {
  const conditions: AlertCondition[] = [];
  const erroredThreadIds: string[] = [];
  const missingScopes: string[] = [];
  let consecutiveFailures: number | undefined;

  const addUnique = <T>(list: T[], values: readonly T[]): void => {
    for (const value of values) {
      if (!list.includes(value)) list.push(value);
    }
  };

  const add = (condition: AlertCondition, details?: AlertDetails): void => {
    addUnique(conditions, [condition]);
    if (condition === 'errored' && details?.threadIds !== undefined) {
      addUnique(erroredThreadIds, details.threadIds);
    }
    if (condition === 'scope_missing' && details?.scopes !== undefined) {
      addUnique(missingScopes, details.scopes);
    }
    if (condition === 'run_failures' && details?.consecutiveFailures !== undefined) {
      consecutiveFailures = details.consecutiveFailures;
    }
  };

  return {
    add,
    addAll: (list) => {
      for (const condition of list) add(condition);
    },
    collected: () => ({
      conditions: [...conditions],
      erroredThreadIds: [...erroredThreadIds],
      missingScopes: [...missingScopes],
      ...(consecutiveFailures === undefined ? {} : { consecutiveFailures }),
    }),
  };
}

/**
 * Delivers one run's alerts. `runEntry` calls `deliver` once per run that took
 * the lock, in its `finally`, whether the run succeeded or failed.
 *
 * **Never write under `state.` for a `lifecycle` run with the Gmail tally
 * off** (`uninstall`): `deliver` runs after its body has deleted every
 * `state.*` key, and a write would leave state behind. The mailer
 * (`createMailAlertSink`, #302), which rate-limits through `state.alerts`,
 * must not be given to `uninstall` in a form that writes it (the composition
 * root chooses the sink per entry).
 */
export interface AlertSink {
  deliver(alerts: CollectedAlerts): void;
}

/**
 * E7's sink: does nothing (the conditions are already in `run.end` /
 * `run.failed`). The sink that sends is `createMailAlertSink`
 * (`src/app/alert-mailer.ts`, #302).
 */
export const logOnlyAlertSink: AlertSink = {
  deliver: () => undefined,
};
