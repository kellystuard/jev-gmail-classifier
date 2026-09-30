/**
 * The run preflight (Solution Design §6.2; epic #13 decision 8): the checks a
 * run makes before it touches Gmail or Jev. Order: key, scopes, budget.
 *
 * - **Key.** No `JEV_API_KEY` throws `RunAbortError('missing_key')` before any
 *   port call (no auth, Gmail, HTTP or state access). It logs nothing: the
 *   per-run boundary logs `run.failed` and maps the reason to the `auth` alert.
 * - **Scopes.** `checkScopes` logs `scope_missing`; its alert is added to the
 *   collector here, with the missing scopes as details.
 * - **Budget.** Today's budget already reached adds `budget_reached` and logs
 *   `budget.reached` once, with the sender's fields. It is checked even when a
 *   scope is missing; the controller decides what to skip.
 *
 * Nothing is written. A corrupt `state.budget` throws `StateError`.
 */
import type { Config } from '../config/schema.ts';
import { RunAbortError } from '../core/errors.ts';
import { dayInTimeZone, isBudgetReached } from '../core/token-budget.ts';
import type { AuthPort } from '../ports/auth-port.ts';
import type { ClockPort } from '../ports/clock-port.ts';
import type { LogPort } from '../ports/log-port.ts';
import type { SecretsPort } from '../ports/secrets-port.ts';
import type { StatePort } from '../ports/state-port.ts';
import type { AlertCollector } from './alerts.ts';
import { loadBudget } from './budget-store.ts';
import { type ScopeCheck, checkScopes } from './scope-preflight.ts';

export type PreflightDeps = {
  readonly secrets: SecretsPort;
  readonly auth: AuthPort;
  readonly state: StatePort;
  readonly clock: ClockPort;
  readonly log: LogPort;
};

export type Preflight = {
  /** Non-blank. Passed to processChunk; never logged. */
  readonly apiKey: string;
  /** `checkScopes`' result as it returned it (missing, unknown, can). */
  readonly scopes: ScopeCheck;
  readonly budgetReached: boolean;
};

export function runPreflight(
  deps: PreflightDeps,
  config: Pick<Config, 'dailyTokenBudget'>,
  alerts: AlertCollector,
): Preflight {
  const apiKey = deps.secrets.getJevApiKey();
  if (apiKey === undefined) {
    throw new RunAbortError('The Jev API key is not set: add JEV_API_KEY in Script Properties', {
      reason: 'missing_key',
    });
  }

  const scopes = checkScopes({ auth: deps.auth, log: deps.log });
  for (const condition of scopes.alerts) {
    if (condition === 'scope_missing' && scopes.missing.length > 0) {
      alerts.add(condition, { scopes: scopes.missing });
    } else {
      alerts.add(condition);
    }
  }

  const today = dayInTimeZone(deps.clock.now(), deps.clock.timeZone());
  const budget = loadBudget(deps.state, today);
  const budgetReached = isBudgetReached(budget, config.dailyTokenBudget);
  if (budgetReached) {
    alerts.add('budget_reached');
    deps.log.warn('budget.reached', {
      day: budget.day,
      inputTokens: budget.inputTokens,
      dailyTokenBudget: config.dailyTokenBudget,
    });
  }

  return { apiKey, scopes, budgetReached };
}
