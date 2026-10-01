/**
 * The alert conditions (Solution Design §10.5; epic #9 decision 10). Use cases
 * return the conditions they detect; E7 passes them on, and E9 sends and
 * rate-limits the alerts (`src/core/alert-limit.ts`, `src/app/alert-mailer.ts`).
 */

/** Every alert condition, in a fixed order. `state.alerts` writes its keys in this order. */
export const ALERT_CONDITIONS = [
  'auth',
  'errored',
  'run_failures',
  'budget_reached',
  'scope_missing',
  'history_expired',
  'config_invalid',
] as const;

export type AlertCondition = (typeof ALERT_CONDITIONS)[number];
