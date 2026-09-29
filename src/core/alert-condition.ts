/**
 * The alert conditions (Solution Design §10.5; epic #9 decision 10). Use cases
 * return the conditions they detect; E7 passes them on, and E9 sends and
 * rate-limits the alerts (one per condition per day, via `state.alerts`).
 */
export type AlertCondition =
  | 'auth'
  | 'errored'
  | 'run_failures'
  | 'budget_reached'
  | 'scope_missing'
  | 'history_expired'
  | 'config_invalid';
