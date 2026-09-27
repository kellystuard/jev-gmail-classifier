import type { Fail, NoFields, Result } from '../core/result.ts';

/**
 * Alert emails, `MailApp.sendEmail` (Solution Design §5.2, §10.5). Owned by
 * E9, which refines it.
 *
 * - `scope`: `script.send_mail` isn't granted (SD §9). Alerts are then only
 *   logged.
 * - `quota`: the daily email quota is used up.
 *
 * Anything else the adapter doesn't recognize is thrown as
 * `UnexpectedResponseError` (`src/core/errors.ts`) and reaches the per-run
 * boundary (SD §10.1).
 */
export interface MailPort {
  /** Sends a plain-text email. */
  send(
    to: string,
    subject: string,
    body: string,
  ): Result<NoFields, Fail<'scope', { message: string }> | Fail<'quota', { message: string }>>;
}
