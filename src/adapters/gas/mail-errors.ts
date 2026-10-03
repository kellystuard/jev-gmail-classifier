/**
 * Pure mapping from what `MailApp.sendEmail` throws to a `MailPort` result
 * (Solution Design §5.2, §9; epic #15 decision 7), with no Apps Script
 * globals, so it is unit-tested.
 *
 * Classification (Engineering Standards §5):
 * - A missing scope (`script.send_mail`) and the daily email quota are
 *   **normal failures**: `scope` and `quota` results.
 * - Nothing is **retryable** here: the next run that raises the condition
 *   tries again (#302).
 * - Everything else is **exceptional**: `UnexpectedResponseError`
 *   (`service: 'mail'`), thrown to the per-run boundary.
 *
 * Neither the scope text nor the quota text has been observed (SD §14): the
 * scope fragments are in `scope-errors.ts`, and the quota text is Google's
 * documented wording, `Service invoked too many times for one day: email.`
 * Still unobserved
 * (the release smoke test saw only the invalid-address text, M7 in
 * `docs/smoke-test-results.md`): record the first real scope or quota text
 * there, and in SD §14.
 *
 * The message is the exception's own text, with every occurrence of the
 * recipient replaced by `<recipient>` (Apps Script may quote an address in
 * its error) and cut to `MAX_MAIL_FAILURE_MESSAGE_LENGTH`. The thrown error
 * has no `cause`, on purpose and unlike `gas-trigger-adapter.ts`:
 * `toLogFields()` logs a cause's message, which would put the unscrubbed text
 * in the log. The subject and the body are never read here.
 */
import { UnexpectedResponseError } from '../../core/errors.ts';
import { fail, type Fail } from '../../core/result.ts';
import { isScopeErrorMessage } from './scope-errors.ts';

/** The longest `message` a failure or the thrown error carries. */
export const MAX_MAIL_FAILURE_MESSAGE_LENGTH = 500;

export type MailFailure = Fail<'scope', { message: string }> | Fail<'quota', { message: string }>;

const QUOTA_FRAGMENT = 'service invoked too many times for one day';

const RECIPIENT_PLACEHOLDER = '<recipient>';

/**
 * What a throw from `MailApp.sendEmail` becomes: a `scope` or `quota` failure,
 * or a thrown `UnexpectedResponseError` (`service: 'mail'`).
 */
export function mailFailure(error: unknown, recipient: string): MailFailure {
  const fullMessage = readMessage(error);
  const message = scrub(fullMessage, recipient).slice(0, MAX_MAIL_FAILURE_MESSAGE_LENGTH);
  if (isScopeErrorMessage(fullMessage)) {
    return fail('scope', { message });
  }
  if (fullMessage.toLowerCase().includes(QUOTA_FRAGMENT)) {
    return fail('quota', { message });
  }
  throw new UnexpectedResponseError(`MailApp sendEmail failed: ${message}`, {
    service: 'mail',
    reason: 'sendEmail failed',
  });
}

/** Replaces every occurrence of `recipient`, ignoring case. An empty recipient scrubs nothing. */
function scrub(text: string, recipient: string): string {
  if (recipient === '') {
    return text;
  }
  const lowerText = text.toLowerCase();
  const lowerRecipient = recipient.toLowerCase();
  // Lower-casing can change a string's length (rare Unicode); then positions don't line up.
  if (lowerText.length !== text.length || lowerRecipient.length !== recipient.length) {
    return text.split(recipient).join(RECIPIENT_PLACEHOLDER);
  }
  let result = '';
  let from = 0;
  for (;;) {
    const at = lowerText.indexOf(lowerRecipient, from);
    if (at === -1) {
      return result + text.slice(from);
    }
    result += text.slice(from, at) + RECIPIENT_PLACEHOLDER;
    from = at + recipient.length;
  }
}

/** The error's own message, or its string form for a thrown non-`Error`. */
function readMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const { message } = error;
    if (typeof message === 'string') {
      return message;
    }
  }
  return String(error);
}
