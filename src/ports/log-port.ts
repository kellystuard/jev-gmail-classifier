import type { LogFields } from '../core/log-fields.ts';

/**
 * Structured JSON logs, `console.*` (Solution Design §5.2, §10.5; Engineering
 * Standards §6).
 *
 * - `event` is a dotted lower-case name whose segments may use `_`, like
 *   `thread.classified` or `scope_missing`.
 * - The adapter adds `runId`, `entry` and `ts` to every event, and runs
 *   `redact` (`src/core/redact.ts`) on the fields as a last line of defence.
 * - Callers never pass message bodies, the API key, the `Authorization`
 *   header or a request's `state`: `redact` doesn't excuse them.
 */
export interface LogPort {
  /** A normal event. */
  info(event: string, fields?: LogFields): void;

  /** A handled failure, such as a strike, `scope_missing`, a truncation or a skipped move. */
  warn(event: string, fields?: LogFields): void;

  /** A failure at a boundary, or an aborted run. */
  error(event: string, fields?: LogFields): void;
}
