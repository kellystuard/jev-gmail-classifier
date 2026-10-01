/**
 * `GasMailAdapter`: `MailPort` over `MailApp.sendEmail` (Solution Design §5.2;
 * epic #15 decision 7).
 *
 * One call, plain text, with the sender name `Jev Gmail Classifier`. No HTML,
 * cc, bcc, reply-to, attachments or inline images. It needs the
 * `script.send_mail` scope (SD §9). The error mapping is `mailFailure` in
 * `mail-errors.ts`: `scope` and `quota` are results, anything else is thrown
 * as `UnexpectedResponseError`. It doesn't log, retry or sleep, and keeps no
 * fields. It is covered by `docs/smoke-test.md`, not by unit tests
 * (Engineering Standards §8).
 */
import { ok, type NoFields, type Result } from '../../core/result.ts';
import type { MailPort } from '../../ports/mail-port.ts';
import { mailFailure, type MailFailure } from './mail-errors.ts';

/** The sender name every alert shows. */
export const MAIL_SENDER_NAME = 'Jev Gmail Classifier';

/** The part of MailApp this file uses. There is no Apps Script type package: `declare const` emits nothing. */
declare const MailApp: {
  sendEmail(message: { to: string; subject: string; body: string; name: string }): void;
};

export class GasMailAdapter implements MailPort {
  send(to: string, subject: string, body: string): Result<NoFields, MailFailure> {
    try {
      MailApp.sendEmail({ to, subject, body, name: MAIL_SENDER_NAME });
      return ok({});
    } catch (error) {
      return mailFailure(error, to);
    }
  }
}
