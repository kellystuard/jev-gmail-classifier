import type { LogFields } from '../core/log-fields.ts';

/**
 * Structured JSON logs, `console.*` (Solution Design §5.2, §10.5; Engineering
 * Standards §6). Owned by E9, which refines it.
 *
 * - `event` is a dotted lower-case name whose segments may use `_`, like
 *   `thread.classified` or `scope_missing`.
 * - The adapter adds `runId`, `entry` and `ts` to every event. How it gets
 *   them is E9's.
 * - Callers never pass message bodies, the API key, the `Authorization`
 *   header or a request's `state`.
 */
export interface LogPort {
  /** A normal event. */
  info(event: string, fields?: LogFields): void;

  /** A handled failure, such as a strike, `scope_missing`, a truncation or a skipped move. */
  warn(event: string, fields?: LogFields): void;

  /** A failure at a boundary, or an aborted run. */
  error(event: string, fields?: LogFields): void;
}
