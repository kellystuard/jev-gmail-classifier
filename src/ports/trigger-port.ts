import type { Fail, NoFields, Result } from '../core/result.ts';

/** The intervals Apps Script allows for a minutes-based trigger (Solution Design §3). */
export type TriggerIntervalMinutes = 1 | 5 | 10 | 15 | 30;

/**
 * Time-driven triggers, `ScriptApp` (SD §5.2, §6.7). Owned by E7, which
 * refines it.
 *
 * `scope`: `script.scriptapp` isn't granted (SD §9). Anything else the
 * adapter doesn't recognize is thrown as `UnexpectedResponseError`
 * (`src/core/errors.ts`) and reaches the per-run boundary (SD §10.1).
 */
export interface TriggerPort {
  /** Leaves exactly one recurring trigger that calls `handler` every `minutes` (SD §6.7). */
  replaceRecurringTrigger(
    handler: string,
    minutes: TriggerIntervalMinutes,
  ): Result<NoFields, Fail<'scope', { message: string }>>;

  /** Deletes every trigger that calls `handler`, and says how many there were. */
  deleteTriggers(handler: string): Result<{ deleted: number }, Fail<'scope', { message: string }>>;
}
