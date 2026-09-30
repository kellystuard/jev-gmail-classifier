import { RunAbortError } from '../core/errors.ts';
import type { LogPort } from '../ports/log-port.ts';
import type { StatePort } from '../ports/state-port.ts';
import type { TriggerPort } from '../ports/trigger-port.ts';

export type UninstallDeps = {
  readonly trigger: TriggerPort;
  readonly state: StatePort;
  readonly log: LogPort;
};

/** JSON-serializable: the entry point returns it to the editor. */
export type UninstallReport = {
  readonly triggersDeleted: number;
  readonly keysDeleted: number;
};

/**
 * Removes the `handler` triggers, then every `state.*` key (Solution Design
 * §6.7). The trigger goes first: state without a trigger is harmless, but a
 * trigger without state would fail every later run. A missing
 * `script.scriptapp` scope stops it before any state call.
 *
 * It never reads a value, so corrupt values and odd keys are deleted too.
 * Labels, `JEV_API_KEY`, `MANUAL_*` and `RESET_POSITION` stay. Running it
 * again after a failure finishes the job. The caller runs it under the lock
 * with no heartbeat and no Gmail tally, so nothing writes `state.*` after it.
 */
export function uninstall(deps: UninstallDeps, handler: string): UninstallReport {
  const deleted = deps.trigger.deleteTriggers(handler);
  if (!deleted.ok) {
    throw new RunAbortError(
      'uninstall needs the script.scriptapp permission to delete the trigger; nothing was changed',
      { reason: 'scope_missing' },
    );
  }
  const keys = deps.state.keys('state.');
  for (const key of keys) {
    deps.state.delete(key);
  }
  const report: UninstallReport = {
    triggersDeleted: deleted.deleted,
    keysDeleted: keys.length,
  };
  deps.log.info('run.end', report);
  return report;
}
