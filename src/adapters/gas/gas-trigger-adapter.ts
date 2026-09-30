/**
 * `GasTriggerAdapter`: `TriggerPort` over `ScriptApp` time-driven triggers
 * (Solution Design §5.2, §6.7; epic #13 decisions 1, 14, 15, 17).
 *
 * It needs the `script.scriptapp` scope (SD §9). A missing scope is a `scope`
 * result; anything else is thrown as `UnexpectedResponseError` and reaches the
 * per-run boundary.
 *
 * Order is delete, then create (decision 14): a failure between the two
 * leaves no trigger and `install` throws, so the user sees it and runs
 * `install` again. Creating first would briefly leave two triggers, both
 * calling `onTrigger`.
 *
 * The pitfall (E1 #163, spike #27 P7): deleting the `Trigger` object that
 * `create()` returned, in the same execution, fails with a bare HTTP 500. So
 * the adapter never deletes or keeps that object, and every delete goes
 * through a fresh `getProjectTriggers()` copy. It keeps no fields: each
 * method reads the triggers itself.
 *
 * It doesn't log, retry or sleep (the use cases log). It is covered by
 * `docs/smoke-test.md`, not by unit tests (Engineering Standards §8).
 */
import { UnexpectedResponseError } from '../../core/errors.ts';
import { fail, ok, type Fail, type NoFields, type Result } from '../../core/result.ts';
import type { TriggerIntervalMinutes, TriggerPort } from '../../ports/trigger-port.ts';
import { isScopeErrorMessage } from './scope-errors.ts';

/** The parts of ScriptApp this file uses. There is no Apps Script type package: `declare const` emits nothing. */
interface GasTrigger {
  getHandlerFunction(): string;
  getUniqueId(): string;
}

declare const ScriptApp: {
  getProjectTriggers(): GasTrigger[];
  deleteTrigger(trigger: GasTrigger): void;
  newTrigger(handler: string): {
    timeBased(): { everyMinutes(n: number): { create(): GasTrigger } };
  };
};

/** Deletes every project trigger that calls `handler`, from a fresh copy, and counts them. */
function deleteByHandler(handler: string): number {
  const matching = ScriptApp.getProjectTriggers().filter(
    (trigger) => trigger.getHandlerFunction() === handler,
  );
  for (const trigger of matching) {
    ScriptApp.deleteTrigger(trigger);
  }
  return matching.length;
}

/** A `scope` failure for a missing-scope message, otherwise the error that reaches the run boundary. */
function toFailure(error: unknown, method: string): Fail<'scope', { message: string }> {
  const message = error instanceof Error ? error.message : String(error);
  if (isScopeErrorMessage(message)) {
    return fail('scope', { message });
  }
  throw new UnexpectedResponseError(
    `ScriptApp ${method} failed`,
    { service: 'trigger', reason: `${method} failed` },
    { cause: error },
  );
}

export class GasTriggerAdapter implements TriggerPort {
  replaceRecurringTrigger(
    handler: string,
    minutes: TriggerIntervalMinutes,
  ): Result<NoFields, Fail<'scope', { message: string }>> {
    try {
      deleteByHandler(handler);
      ScriptApp.newTrigger(handler).timeBased().everyMinutes(minutes).create();
      return ok({});
    } catch (error) {
      return toFailure(error, 'replaceRecurringTrigger');
    }
  }

  deleteTriggers(handler: string): Result<{ deleted: number }, Fail<'scope', { message: string }>> {
    try {
      return ok({ deleted: deleteByHandler(handler) });
    } catch (error) {
      return toFailure(error, 'deleteTriggers');
    }
  }
}
