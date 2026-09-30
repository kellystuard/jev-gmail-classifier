import type { Fail, NoFields, Result } from '../core/result.ts';

/** The intervals Apps Script allows for a minutes-based trigger (Solution Design §3). */
export type TriggerIntervalMinutes = 1 | 5 | 10 | 15 | 30;

/**
 * Time-driven triggers, `ScriptApp` (SD §5.2, §6.7). Only triggers for the
 * given handler are ever touched; other handlers' triggers are left alone.
 *
 * `scope`: `script.scriptapp` isn't granted (SD §9). Anything else the
 * adapter doesn't recognize is thrown as `UnexpectedResponseError`
 * (`src/core/errors.ts`) and reaches the per-run boundary (SD §10.1).
 */
export interface TriggerPort {
  /**
   * Deletes every trigger that calls `handler` (read fresh from the project's
   * triggers), then creates one that calls it every `minutes`, so exactly one
   * is left (SD §6.7). It never deletes the trigger it just created (E1 #163).
   */
  replaceRecurringTrigger(
    handler: string,
    minutes: TriggerIntervalMinutes,
  ): Result<NoFields, Fail<'scope', { message: string }>>;

  /** Deletes every trigger that calls `handler`, and says how many there were (0 is fine). */
  deleteTriggers(handler: string): Result<{ deleted: number }, Fail<'scope', { message: string }>>;
}
