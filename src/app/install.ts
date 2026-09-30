/**
 * The `install` use case (Solution Design §6.7, §9; epic #13 decision 11):
 * insist on the essential scopes, check the scopes and the key, record the
 * install time, save the starting position and create or replace the one
 * trigger, **last**, so a trigger never exists without a position.
 *
 * The lock, the config load, `run.start`, `run.failed` and alert delivery are
 * `runEntry`'s (#120). This function runs inside it (`kind: 'lifecycle'`).
 *
 * Re-running `install` never skips or duplicates mail: the position is kept
 * (unless `RESET_POSITION=true`), and the queue is never read or written.
 */
import type { Config } from '../config/schema.ts';
import type { AlertCondition } from '../core/alert-condition.ts';
import type { DeclaredScope } from '../core/declared-scopes.ts';
import { RunAbortError, UnexpectedResponseError } from '../core/errors.ts';
import { FALLBACK_KEY } from '../core/history-fallback.ts';
import { encodeInstallRecord, INSTALLED_AT_KEY } from '../core/install-record.ts';
import type { LogValue } from '../core/log-fields.ts';
import { decodePosition, encodePosition, POSITION_KEY } from '../core/position.ts';
import { INSTALL_REQUIRED_SCOPES } from '../core/scope-features.ts';
import type { AuthPort } from '../ports/auth-port.ts';
import type { ClockPort } from '../ports/clock-port.ts';
import type { GmailPort } from '../ports/gmail-port.ts';
import type { LogPort } from '../ports/log-port.ts';
import type { SecretsPort } from '../ports/secrets-port.ts';
import type { StatePort } from '../ports/state-port.ts';
import type { TriggerIntervalMinutes, TriggerPort } from '../ports/trigger-port.ts';
import { checkScopes } from './scope-preflight.ts';

/** The Script Property that asks `install` to start from the current `historyId`. */
export const RESET_POSITION_INPUT = 'RESET_POSITION';

const GMAIL_MODIFY: DeclaredScope = 'https://www.googleapis.com/auth/gmail.modify';
const SCRIPTAPP: DeclaredScope = 'https://www.googleapis.com/auth/script.scriptapp';

/**
 * The part of #120's `AlertCollector` that `install` uses (structural, so
 * `RunContext['alerts']` fits).
 */
export type InstallAlerts = {
  add(condition: AlertCondition, details?: { readonly scopes?: readonly string[] }): void;
};

/** A `Pick` of #120's `RunContext`: `runEntry` passes its context straight through. */
export type InstallContext = {
  readonly config: Config;
  /** `checkScopes` returns its alerts; `install` adds them here. */
  readonly alerts: InstallAlerts;
};

export type InstallDeps = {
  readonly gmail: GmailPort;
  readonly state: StatePort;
  readonly trigger: TriggerPort;
  readonly auth: AuthPort;
  readonly secrets: SecretsPort;
  readonly clock: ClockPort;
  readonly log: LogPort;
};

/** JSON-serializable: the entry point returns it to the editor. */
export type InstallReport = {
  readonly position: 'kept' | 'set' | 'reset';
  readonly historyId: string;
  readonly triggerMinutes: TriggerIntervalMinutes;
  /** `[]` when none is missing, or when the check was `unknown`. */
  readonly missingScopes: readonly DeclaredScope[];
};

type ResetRequest = 'reset' | 'none' | 'ignored';

/**
 * Installs the classifier, in this order (SD §6.7):
 *
 * 1. `auth.requireScopes(INSTALL_REQUIRED_SCOPES)`: Apps Script's error
 *    propagates, which in the editor brings the consent screen back.
 * 2. `checkScopes`: its alerts go to `ctx.alerts`. Without `gmail.modify` or
 *    `script.scriptapp`, throws `RunAbortError` `scope_missing`.
 * 3. No Jev key: throws `RunAbortError` `missing_key`. Nothing is written
 *    before this point.
 * 4. `state.installedAt` (the last install time).
 * 5. The position: kept, or set (reset) from `getProfile`, after deleting
 *    `state.fallback`. A reset then deletes `RESET_POSITION`.
 * 6. The trigger, last: `replaceRecurringTrigger(handler, …)`.
 * 7. `run.end`.
 *
 * Throws `RunAbortError` `scope_missing` for a `scope` result from
 * `getProfile` or the trigger, `UnexpectedResponseError` for Gmail's
 * per-user rate limit, and whatever the state store or a codec throws.
 */
export function install(ctx: InstallContext, deps: InstallDeps, handler: string): InstallReport {
  // 1. Before anything else: the three scopes nothing useful works without.
  deps.auth.requireScopes(INSTALL_REQUIRED_SCOPES);

  // 2. The scope check. A missing `script.external_request` or `script.send_mail` doesn't stop install.
  const scopes = checkScopes({ auth: deps.auth, log: deps.log });
  for (const condition of scopes.alerts) {
    ctx.alerts.add(condition, scopes.missing.length > 0 ? { scopes: scopes.missing } : undefined);
  }
  if (!scopes.can.gmail || !scopes.can.trigger) {
    throw scopeMissing(
      scopes.missing.filter((scope) => scope === GMAIL_MODIFY || scope === SCRIPTAPP),
    );
  }

  // 3. The key. Never logged.
  if (deps.secrets.getJevApiKey() === undefined) {
    throw new RunAbortError(
      'JEV_API_KEY is missing: set JEV_API_KEY in Script Properties, then run install again',
      {
        reason: 'missing_key',
      },
    );
  }

  // 4. The last install time.
  deps.state.set(INSTALLED_AT_KEY, encodeInstallRecord({ at: deps.clock.now() }));

  // 5. The position.
  const reset = readResetRequest(deps.state);
  const position = savePosition(ctx, deps, reset === 'reset');

  // 6. The trigger, last.
  const triggerMinutes = ctx.config.triggerIntervalMinutes;
  const replaced = deps.trigger.replaceRecurringTrigger(handler, triggerMinutes);
  if (!replaced.ok) {
    ctx.alerts.add('scope_missing', { scopes: [SCRIPTAPP] });
    throw scopeMissing([SCRIPTAPP]);
  }

  // 7. `run.end`.
  const fields: Record<string, LogValue> = {
    position: position.outcome,
    historyId: position.historyId,
    triggerMinutes,
  };
  if (scopes.missing.length > 0) {
    fields['missingScopes'] = scopes.missing;
  }
  if (reset === 'ignored') {
    fields['resetPositionIgnored'] = true;
  }
  if (scopes.missing.length > 0 || reset === 'ignored') {
    deps.log.warn('run.end', fields);
  } else {
    deps.log.info('run.end', fields);
  }

  return {
    position: position.outcome,
    historyId: position.historyId,
    triggerMinutes,
    missingScopes: scopes.missing,
  };
}

/**
 * `RESET_POSITION`: `true` (trimmed, any case) resets. Absent or blank is no
 * reset, silently. Anything else is ignored (with a warning in `run.end`) and
 * left in place.
 */
function readResetRequest(state: StatePort): ResetRequest {
  const raw = state.getInput(RESET_POSITION_INPUT);
  if (raw === undefined) return 'none';
  const value = raw.trim().toLowerCase();
  if (value === '') return 'none';
  return value === 'true' ? 'reset' : 'ignored';
}

function savePosition(
  ctx: InstallContext,
  deps: InstallDeps,
  reset: boolean,
): { outcome: InstallReport['position']; historyId: string } {
  // A reset doesn't read the stored position at all: a corrupt one is being replaced.
  if (!reset) {
    const stored = deps.state.get(POSITION_KEY);
    if (stored !== undefined) {
      // Kept. A corrupt value throws `StateError`, before the trigger; the fix is RESET_POSITION=true.
      return { outcome: 'kept', historyId: decodePosition(stored).historyId };
    }
  }

  const profile = deps.gmail.getProfile();
  if (!profile.ok) {
    if (profile.kind === 'scope') {
      ctx.alerts.add('scope_missing', { scopes: [GMAIL_MODIFY] });
      throw scopeMissing([GMAIL_MODIFY]);
    }
    throw new UnexpectedResponseError(
      "Gmail's per-user rate limit was reached; run install again in a few minutes",
      { service: 'gmail', reason: 'rate_limited' },
    );
  }

  // The fallback goes first: a cursor left next to a new position would, when
  // it finished, write its own older `historyId` over the new one (SD §6.3).
  // A crash between the two writes leaves the old position, and running
  // install again redoes the step.
  deps.state.delete(FALLBACK_KEY);
  deps.state.set(
    POSITION_KEY,
    encodePosition({ historyId: profile.historyId, savedAt: deps.clock.now() }),
  );
  if (reset) {
    // Before the trigger: if the trigger fails, the next install keeps this position.
    deps.state.deleteInput(RESET_POSITION_INPUT);
  }
  return { outcome: reset ? 'reset' : 'set', historyId: profile.historyId };
}

function scopeMissing(missing: readonly DeclaredScope[]): RunAbortError {
  const names = missing.length > 0 ? missing.join(', ') : 'a required scope';
  return new RunAbortError(`install needs ${names}: grant it and run install again`, {
    reason: 'scope_missing',
  });
}
